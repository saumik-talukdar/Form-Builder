import { Router } from "express";
import { randomBytes } from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { Form } from "../models/form";
import { FormVersion } from "../models/formVersion";
import { FormView } from "../models/formView";
import { ResponseModel } from "../models/response";
import { AppError, conflict, notFound } from "../lib/errors";
import { getCompiledForm } from "../lib/compiledCache";
import { RESPONDENT_COOKIE, captureMeta, clientIp } from "../lib/meta";
import { hmac } from "../lib/hash";
import { emitNewResponse } from "../lib/realtime";
import { config, isProd } from "../config";

/**
 * Anonymous, unauthenticated endpoints used by respondents.
 * Abuse protection: rate limits, honeypot, body-size cap (in app.ts),
 * strict validation against the published version, atomic response caps.
 */
export const publicRouter = Router();

const readLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.READ_RATE_LIMIT_PER_MIN,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

const submitLimiter = rateLimit({
  windowMs: 60_000,
  limit: config.SUBMIT_RATE_LIMIT_PER_MIN,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many submissions, slow down" },
});

const slugParam = z.string().regex(/^[A-Za-z0-9_-]{4,32}$/);

const gone = () =>
  new AppError(410, "This form is no longer accepting responses");

publicRouter.get("/forms/:slug", readLimiter, async (req, res) => {
  const slug = slugParam.safeParse(req.params.slug);
  if (!slug.success) throw notFound("Form not found");

  const form = await Form.findOne({ slug: slug.data }).lean();
  if (!form || form.status === "draft") throw notFound("Form not found");
  if (
    form.status === "closed" ||
    (form.settings.closesAt && form.settings.closesAt <= new Date())
  ) {
    throw gone();
  }

  const version = await FormVersion.findOne({
    formId: form._id,
    version: form.publishedVersion,
  }).lean();
  if (!version) throw notFound("Form not found");

  // Anonymous per-browser token: lets the "one response per person" rule work
  // without accounts. Cleared cookies bypass it, so it is a soft limit.
  if (!req.cookies?.[RESPONDENT_COOKIE]) {
    res.cookie(RESPONDENT_COOKIE, randomBytes(16).toString("hex"), {
      httpOnly: true,
      sameSite: "lax",
      secure: isProd,
      maxAge: 1000 * 60 * 60 * 24 * 365,
      path: "/",
    });
  }

  // Fire-and-forget view for the views → submits funnel.
  FormView.create({ formId: form._id, ipHash: hmac(clientIp(req)) }).catch(
    (err) => console.error("failed to record view", err),
  );

  res.set("Cache-Control", "no-store");
  res.json({
    slug: form.slug,
    title: version.title,
    description: version.description,
    version: version.version,
    fields: version.fields,
    closesAt: form.settings.closesAt ?? null,
  });
});

const submitSchema = z.object({
  answers: z.record(z.string(), z.unknown()),
  /** Version the client rendered; a mismatch means the form changed under them. */
  version: z.number().int().positive().optional(),
  startedAt: z.number().optional(),
  referrer: z.string().max(500).optional(),
  /** Honeypot: hidden input real users never fill. */
  website: z.string().max(500).optional(),
});

publicRouter.post("/forms/:slug/responses", submitLimiter, async (req, res) => {
  const slug = slugParam.safeParse(req.params.slug);
  if (!slug.success) throw notFound("Form not found");
  const body = submitSchema.parse(req.body);

  const form = await Form.findOne({ slug: slug.data }).lean();
  if (!form || form.status === "draft") throw notFound("Form not found");
  if (
    form.status === "closed" ||
    (form.settings.closesAt && form.settings.closesAt <= new Date())
  ) {
    throw gone();
  }

  if (body.website) {
    // Looks like a bot: pretend success, store nothing.
    res.status(201).json({ ok: true });
    return;
  }

  if (body.version !== undefined && body.version !== form.publishedVersion) {
    throw new AppError(
      409,
      "This form was updated. Reload to see the latest version.",
      {
        currentVersion: form.publishedVersion,
      },
    );
  }

  const compiled = await getCompiledForm(form._id, form.publishedVersion);
  if (!compiled) throw notFound("Form not found");

  const result = compiled.validate(body.answers);
  if (!result.success) {
    throw new AppError(422, "Some answers are invalid", result.errors);
  }

  const meta = captureMeta(req, {
    startedAt: body.startedAt,
    referrer: body.referrer,
  });

  if (!form.settings.allowMultiple) {
    const or: Record<string, unknown>[] = [
      { "meta.ipHash": meta.ipHash, "meta.userAgent": meta.userAgent },
    ];
    if (meta.tokenHash) or.push({ "meta.tokenHash": meta.tokenHash });
    const already = await ResponseModel.exists({ formId: form._id, $or: or });
    if (already) throw conflict("You have already responded to this form");
  }

  // Atomically reserve a slot so concurrent submits can't exceed maxResponses.
  const max = form.settings.maxResponses;
  const reserved = await Form.findOneAndUpdate(
    {
      _id: form._id,
      status: "published",
      ...(max ? { responseCount: { $lt: max } } : {}),
    },
    { $inc: { responseCount: 1 } },
  ).lean();
  if (!reserved) throw gone();

  let saved;
  try {
    saved = await ResponseModel.create({
      formId: form._id,
      version: form.publishedVersion,
      answers: result.data,
      meta,
    });
  } catch (err) {
    await Form.updateOne({ _id: form._id }, { $inc: { responseCount: -1 } });
    throw err;
  }

  // Push to any owner dashboards watching this form. Never exposes answers or IPs.
  emitNewResponse(String(form._id), {
    id: String(saved._id),
    count: reserved.responseCount + 1, // findOneAndUpdate returned the pre-increment document
    submittedAt: saved.submittedAt.toISOString(),
    device: meta.device,
    country: meta.country ?? null,
  });

  res.status(201).json({ ok: true });
});

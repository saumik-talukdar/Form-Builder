import { Router } from "express";
import { randomBytes } from "node:crypto";
import { isValidObjectId, Types } from "mongoose";
import { z } from "zod";
import { fieldSchema, formDefinitionSchema, type Field } from "@fb/shared";
import { Form } from "../models/form";
import { FormVersion } from "../models/formVersion";
import { ResponseModel } from "../models/response";
import { FormView } from "../models/formView";
import { requireAuth } from "../middleware/auth";
import { badRequest, conflict, notFound } from "../lib/errors";
import { loadOwnedForm } from "../lib/ownedForm";
import { analyticsRouter } from "./analytics";

export const formsRouter = Router();
formsRouter.use(requireAuth);
formsRouter.use("/:id", analyticsRouter); // /:id/analytics, /:id/export.csv

const settingsSchema = z
  .object({
    allowMultiple: z.boolean(),
    closesAt: z.coerce.date().nullable(),
    maxResponses: z.number().int().min(1).max(1_000_000).nullable(),
  })
  .partial()
  .strict();

const createSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  fields: z.array(fieldSchema).default([]),
  settings: settingsSchema.optional(),
});

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).nullable(),
    fields: z.array(fieldSchema),
    settings: settingsSchema,
  })
  .partial()
  .strict();

/** Public-facing, unguessable slug (8 chars of base64url ≈ 48 bits). */
const newSlug = () => randomBytes(6).toString("base64url");

const sameDefinition = (
  a: { title: string; description?: string | null; fields: unknown },
  b: { title: string; description?: string | null; fields: unknown },
) =>
  a.title === b.title &&
  (a.description ?? "") === (b.description ?? "") &&
  JSON.stringify(a.fields) === JSON.stringify(b.fields);

// ---- Create / list / read ----------------------------------------------

formsRouter.post("/", async (req, res) => {
  const body = createSchema.parse(req.body);
  // Full cross-field validation (duplicate ids, showIf order, ranges, ...)
  const def = formDefinitionSchema.parse({
    title: body.title,
    description: body.description,
    fields: body.fields,
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const form = await Form.create({
        ownerId: req.userId,
        slug: newSlug(),
        title: def.title,
        description: def.description,
        draftFields: def.fields,
        settings: { allowMultiple: true, ...body.settings },
      });
      res.status(201).json(serializeForm(form.toObject()));
      return;
    } catch (err) {
      if ((err as { code?: number }).code !== 11000) throw err; // slug collision: retry
    }
  }
  throw new Error("Could not allocate a unique slug");
});

formsRouter.get("/", async (req, res) => {
  const forms = await Form.find({ ownerId: req.userId })
    .select("-draftFields")
    .sort({ updatedAt: -1 })
    .limit(200)
    .lean();
  res.json(forms.map((f) => serializeForm(f)));
});

formsRouter.get("/:id", async (req, res) => {
  const form = await loadOwnedForm(req.params.id, req.userId);
  res.json(serializeForm(form.toObject()));
});

// ---- Update draft --------------------------------------------------------

formsRouter.patch("/:id", async (req, res) => {
  const form = await loadOwnedForm(req.params.id, req.userId);
  const patch = patchSchema.parse(req.body);

  const next = {
    title: patch.title ?? form.title,
    description:
      patch.description === undefined
        ? form.description
        : (patch.description ?? undefined),
    fields: (patch.fields ?? form.draftFields) as Field[],
  };
  const def = formDefinitionSchema.parse(next);

  form.title = def.title;
  form.description = def.description;
  form.draftFields = def.fields;
  if (patch.settings) {
    const s = patch.settings;
    if (s.allowMultiple !== undefined)
      form.settings.allowMultiple = s.allowMultiple;
    if (s.closesAt !== undefined) form.settings.closesAt = s.closesAt;
    if (s.maxResponses !== undefined)
      form.settings.maxResponses = s.maxResponses;
  }
  form.markModified("draftFields");
  await form.save();
  res.json(serializeForm(form.toObject()));
});

formsRouter.delete("/:id", async (req, res) => {
  const form = await loadOwnedForm(req.params.id, req.userId);
  await form.deleteOne();
  await Promise.all([
    FormVersion.deleteMany({ formId: form._id }),
    ResponseModel.deleteMany({ formId: form._id }),
    FormView.deleteMany({ formId: form._id }),
  ]);
  res.status(204).end();
});

// ---- Publish / close / versions -----------------------------------------

formsRouter.post("/:id/publish", async (req, res) => {
  const form = await loadOwnedForm(req.params.id, req.userId);

  const def = formDefinitionSchema.parse({
    title: form.title,
    description: form.description,
    fields: form.draftFields,
  });
  if (def.fields.length === 0)
    throw badRequest("Add at least one field before publishing");

  if (form.publishedVersion > 0) {
    const current = await FormVersion.findOne({
      formId: form._id,
      version: form.publishedVersion,
    }).lean();
    if (current && sameDefinition(current, def)) {
      if (form.status === "published")
        throw conflict(`No changes since version ${form.publishedVersion}`);
      // Closed form, unchanged definition: just reopen it.
      form.status = "published";
      await form.save();
      res.json(serializeForm(form.toObject()));
      return;
    }
  }

  const expected = form.publishedVersion;
  const version = expected + 1;
  await FormVersion.create({
    formId: form._id,
    version,
    title: def.title,
    description: def.description,
    fields: def.fields,
  });

  // Only advance the pointer if nobody else published meanwhile.
  const updated = await Form.findOneAndUpdate(
    { _id: form._id, publishedVersion: expected },
    { $set: { publishedVersion: version, status: "published" } },
    { new: true },
  ).lean();
  if (!updated) {
    await FormVersion.deleteOne({ formId: form._id, version });
    throw conflict("Form was published concurrently, try again");
  }
  res.status(201).json(serializeForm(updated));
});

formsRouter.post("/:id/close", async (req, res) => {
  const form = await loadOwnedForm(req.params.id, req.userId);
  if (form.status !== "published")
    throw conflict("Only published forms can be closed");
  form.status = "closed";
  await form.save();
  res.json(serializeForm(form.toObject()));
});

formsRouter.get("/:id/versions", async (req, res) => {
  const form = await loadOwnedForm(req.params.id, req.userId);
  // A form has a handful of versions, so counting fields in code is simpler than an aggregation.
  const versions = await FormVersion.find({ formId: form._id })
    .sort({ version: -1 })
    .select("version title publishedAt fields")
    .lean();
  res.json(
    versions.map((v) => ({
      version: v.version,
      title: v.title,
      publishedAt: v.publishedAt,
      fieldCount: (v.fields as unknown[]).length,
    })),
  );
});

formsRouter.get("/:id/versions/:version", async (req, res) => {
  const form = await loadOwnedForm(req.params.id, req.userId);
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version < 1)
    throw notFound("Version not found");
  const doc = await FormVersion.findOne({ formId: form._id, version }).lean();
  if (!doc) throw notFound("Version not found");
  res.json({
    version: doc.version,
    title: doc.title,
    description: doc.description,
    fields: doc.fields,
    publishedAt: doc.publishedAt,
  });
});

// ---- Responses (owner view) ---------------------------------------------

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(100).optional(),
});

formsRouter.get("/:id/responses", async (req, res) => {
  const form = await loadOwnedForm(req.params.id, req.userId);
  const { limit, cursor } = listQuery.parse(req.query);

  const filter: Record<string, unknown> = { formId: form._id };
  if (cursor) {
    // cursor = "<submittedAt ms>_<objectId>", newest first
    const [msRaw, idRaw] = cursor.split("_");
    const ms = Number(msRaw);
    if (!Number.isFinite(ms) || !idRaw || !isValidObjectId(idRaw))
      throw badRequest("Invalid cursor");
    const at = new Date(ms);
    filter.$or = [
      { submittedAt: { $lt: at } },
      { submittedAt: at, _id: { $lt: new Types.ObjectId(idRaw) } },
    ];
  }

  const rows = await ResponseModel.find(filter)
    .sort({ submittedAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  res.json({
    items: page.map((r) => ({
      id: String(r._id),
      version: r.version,
      answers: r.answers,
      submittedAt: r.submittedAt,
      meta: {
        browser: r.meta.browser,
        os: r.meta.os,
        device: r.meta.device,
        country: r.meta.country,
        language: r.meta.language,
        referrer: r.meta.referrer,
        durationMs: r.meta.durationMs,
      },
    })),
    nextCursor:
      rows.length > limit && last
        ? `${last.submittedAt.getTime()}_${last._id}`
        : null,
  });
});

// ---- Serialization -------------------------------------------------------

interface FormLike {
  _id: unknown;
  slug: string;
  status: string;
  title: string;
  description?: string | null;
  draftFields?: unknown;
  publishedVersion: number;
  settings: {
    allowMultiple: boolean;
    closesAt?: Date | null;
    maxResponses?: number | null;
  };
  responseCount: number;
  createdAt: Date;
  updatedAt: Date;
}

function serializeForm(f: FormLike) {
  return {
    id: String(f._id),
    slug: f.slug,
    status: f.status,
    title: f.title,
    description: f.description ?? undefined,
    ...(f.draftFields !== undefined ? { fields: f.draftFields } : {}),
    publishedVersion: f.publishedVersion,
    settings: {
      allowMultiple: f.settings.allowMultiple,
      closesAt: f.settings.closesAt ?? null,
      maxResponses: f.settings.maxResponses ?? null,
    },
    responseCount: f.responseCount,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

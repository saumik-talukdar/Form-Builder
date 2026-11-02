import { Router } from "express";
import { once } from "node:events";
import { z } from "zod";
import { Types, type PipelineStage } from "mongoose";
import type { Field } from "@fb/shared";
import { ResponseModel } from "../models/response";
import { FormView } from "../models/formView";
import { FormVersion } from "../models/formVersion";
import { loadOwnedForm } from "../lib/ownedForm";
import { badRequest, notFound } from "../lib/errors";
import {
  buildQuestionFacets,
  buildSummaryFacets,
  shapeOverview,
  shapeQuestionStats,
  type Pipeline,
} from "../lib/analytics";
import { csvHeader, makeCsvRow } from "../lib/csv";
import { TtlCache } from "../lib/ttlCache";

/** Dashboards recompute heavy aggregations; a short cache absorbs reloads and live-update refetches. */
const ANALYTICS_TTL_MS = 30_000;
const analyticsCache = new TtlCache<unknown>(ANALYTICS_TTL_MS);

// Mounted at /api/forms/:id (auth is applied by the parent router).
export const analyticsRouter = Router({ mergeParams: true });

const DAY_MS = 86_400_000;
const FUNNEL_DEFAULT_DAYS = 30;

const timezoneSchema = z
  .string()
  .max(64)
  .default("UTC")
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown timezone");

const analyticsQuery = z.object({
  /** Which version the per-question stats describe. Default: the published version. */
  version: z.coerce.number().int().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  interval: z.enum(["day", "hour"]).default("day"),
  timezone: timezoneSchema,
});

const stages = (p: unknown[]) => p as unknown as PipelineStage[];
const facetStage = (f: Record<string, Pipeline>) => ({ $facet: f });

const submittedRange = (from?: Date, to?: Date) =>
  from || to
    ? {
        submittedAt: {
          ...(from ? { $gte: from } : {}),
          ...(to ? { $lte: to } : {}),
        },
      }
    : {};

analyticsRouter.get<{ id: string }>("/analytics", async (req, res) => {
  const form = await loadOwnedForm(req.params.id, req.userId);
  const q = analyticsQuery.parse(req.query);
  if (q.from && q.to && q.from > q.to)
    throw badRequest("'from' must be before 'to'");
  if (
    q.interval === "hour" &&
    q.from &&
    q.to &&
    q.to.getTime() - q.from.getTime() > 14 * DAY_MS
  ) {
    throw badRequest("Hourly interval supports ranges of up to 14 days");
  }

  const cacheKey = JSON.stringify([
    String(form._id),
    q.version ?? form.publishedVersion,
    q.from,
    q.to,
    q.timezone,
    q.interval,
  ]);
  const body = await analyticsCache.get(cacheKey, async () => {
    const range = submittedRange(q.from, q.to);
    const questionsVersion = q.version ?? form.publishedVersion;
    const versionDoc = questionsVersion
      ? await FormVersion.findOne({
          formId: form._id,
          version: questionsVersion,
        }).lean()
      : null;
    if (q.version && !versionDoc) throw notFound("Version not found");

    // Funnel window: views expire after 90 days, so compare like with like.
    const now = new Date();
    const funnelTo = q.to ?? now;
    const funnelFrom =
      q.from ?? new Date(funnelTo.getTime() - FUNNEL_DEFAULT_DAYS * DAY_MS);

    const match = { formId: form._id, ...range };
    const durationMatch = { ...match, "meta.durationMs": { $exists: true } };

    const [overviewRes, questionRes, views, uniqueViews, funnelSubmits] =
      await Promise.all([
        ResponseModel.aggregate(
          stages([
            { $match: match },
            facetStage(buildSummaryFacets(q.timezone, q.interval)),
          ]),
        ),
        versionDoc
          ? ResponseModel.aggregate(
              stages([
                {
                  $match: {
                    formId: form._id,
                    version: versionDoc.version,
                    ...range,
                  },
                },
                facetStage(buildQuestionFacets(versionDoc.fields as Field[])),
              ]),
            )
          : Promise.resolve([]),
        FormView.countDocuments({
          formId: form._id,
          createdAt: { $gte: funnelFrom, $lte: funnelTo },
        }),
        FormView.aggregate([
          {
            $match: {
              formId: form._id,
              createdAt: { $gte: funnelFrom, $lte: funnelTo },
            },
          },
          { $group: { _id: "$ipHash" } },
          { $count: "n" },
        ]),
        ResponseModel.countDocuments({
          formId: form._id,
          submittedAt: { $gte: funnelFrom, $lte: funnelTo },
        }),
      ]);

    const overview = shapeOverview(overviewRes[0], q.interval, q.from, q.to);

    // Median completion time without $percentile (needs MongoDB 7+): sort + skip to the middle.
    let medianDurationMs: number | null = null;
    const n = overview.responsesWithDuration;
    if (n > 0) {
      const mid = await ResponseModel.find(durationMatch)
        .select("meta.durationMs")
        .sort({ "meta.durationMs": 1 })
        .skip(Math.floor((n - 1) / 2))
        .limit(n % 2 === 1 ? 1 : 2)
        .allowDiskUse(true)
        .lean();
      const values = mid.map((d) => d.meta.durationMs as number);
      if (values.length > 0)
        medianDurationMs = Math.round(
          values.reduce((a, b) => a + b, 0) / values.length,
        );
    }

    const uniqueViewCount = uniqueViews[0]?.n ?? 0;
    const questions = versionDoc
      ? shapeQuestionStats(versionDoc.fields as Field[], questionRes[0])
      : { total: 0, questions: [] };

    return {
      range: {
        from: q.from ?? null,
        to: q.to ?? null,
        timezone: q.timezone,
        interval: q.interval,
      },
      summary: {
        totalResponses: overview.totalResponses,
        uniqueRespondents: overview.uniqueRespondents,
        avgDurationMs: overview.avgDurationMs,
        medianDurationMs,
      },
      overTime: overview.overTime,
      breakdowns: overview.breakdowns,
      funnel: {
        windowFrom: funnelFrom,
        windowTo: funnelTo,
        views,
        uniqueViews: uniqueViewCount,
        submissions: funnelSubmits,
        // Submissions can exceed views if the same visitor submits several times.
        conversionRate:
          views > 0 ? Math.round((funnelSubmits / views) * 1000) / 1000 : null,
        viewsRetentionDays: 90,
      },
      questions: {
        version: versionDoc?.version ?? null,
        totalResponses: questions.total,
        items: questions.questions,
      },
    };
  });
  res.json(body);
});

// ---- CSV export (streamed) ------------------------------------------------

const exportQuery = z.object({
  version: z.coerce.number().int().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

analyticsRouter.get<{ id: string }>("/export.csv", async (req, res) => {
  const form = await loadOwnedForm(req.params.id, req.userId);
  const q = exportQuery.parse(req.query);

  const version = q.version ?? form.publishedVersion;
  if (!version) throw badRequest("This form has no published version yet");
  const versionDoc = await FormVersion.findOne({
    formId: form._id,
    version,
  }).lean();
  if (!versionDoc) throw notFound("Version not found");
  const fields = versionDoc.fields as Field[];

  res.status(200);
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${form.slug}-v${version}.csv"`,
    "Cache-Control": "no-store",
  });
  res.write("﻿"); // BOM so Excel detects UTF-8
  res.write(csvHeader(fields));

  const toRow = makeCsvRow(fields);
  const cursor = ResponseModel.find({
    formId: form._id as Types.ObjectId,
    version,
    ...submittedRange(q.from, q.to),
  })
    .sort({ _id: 1 })
    .lean()
    .cursor();

  // Stop reading if the client disconnects mid-download.
  res.on("close", () => {
    void cursor.close().catch(() => undefined);
  });

  try {
    for await (const doc of cursor) {
      if (res.destroyed) break;
      // Respect backpressure so a slow client can't make us buffer the whole collection.
      if (!res.write(toRow(doc as never))) await once(res, "drain");
    }
    res.end();
  } catch (err) {
    // Headers are already sent, so all we can do is abort the connection.
    console.error("CSV export failed", err);
    res.destroy(err as Error);
  }
});

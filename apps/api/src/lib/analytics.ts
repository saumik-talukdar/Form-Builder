import type { Field } from "@fb/shared";

/**
 * Pure analytics helpers: aggregation pipeline builders and result shapers.
 * No database access here, so everything is unit-testable (the tests run
 * the real pipelines in-process with mingo).
 */

export type Stage = Record<string, unknown>;
export type Pipeline = Stage[];

export const TOP_N = 20;
const MAX_BREAKDOWN = 10;

// ---- Overview: totals, time series, header-based breakdowns ---------------

export type Interval = "day" | "hour";

const missing = (path: string) => ({ $eq: [{ $type: path }, "missing"] });

export function buildSummaryFacets(
  timezone: string,
  interval: Interval,
): Record<string, Pipeline> {
  const format = interval === "hour" ? "%Y-%m-%dT%H:00" : "%Y-%m-%d";

  const breakdown = (path: string, fallback: string): Pipeline => [
    { $group: { _id: { $ifNull: [path, fallback] }, count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: MAX_BREAKDOWN },
  ];

  return {
    totals: [
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          withDuration: {
            $sum: { $cond: [missing("$meta.durationMs"), 0, 1] },
          },
          avgDurationMs: { $avg: "$meta.durationMs" },
        },
      },
    ],
    // Distinct respondents, counted in a sub-pipeline so $addToSet can't hit the 16MB doc limit.
    unique: [{ $group: { _id: "$meta.ipHash" } }, { $count: "n" }],
    overTime: [
      {
        $group: {
          _id: { $dateToString: { format, date: "$submittedAt", timezone } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ],
    device: breakdown("$meta.device", "other"),
    browser: breakdown("$meta.browser", "Unknown"),
    os: breakdown("$meta.os", "Unknown"),
    country: breakdown("$meta.country", "Unknown"),
    referrer: breakdown("$meta.referrer", "Direct"),
    language: breakdown("$meta.language", "Unknown"),
  };
}

export interface Bucket {
  key: string;
  count: number;
}

type FacetRow = { _id: unknown; count: number };

const toBuckets = (rows: FacetRow[] | undefined): Bucket[] =>
  (rows ?? []).map((r) => ({ key: String(r._id), count: r.count }));

export interface OverviewResult {
  totalResponses: number;
  uniqueRespondents: number;
  avgDurationMs: number | null;
  responsesWithDuration: number;
  overTime: Bucket[];
  breakdowns: Record<
    "device" | "browser" | "os" | "country" | "referrer" | "language",
    Bucket[]
  >;
}

export function shapeOverview(
  facet: Record<string, any[]> | undefined,
  interval: Interval,
  from?: Date,
  to?: Date,
): OverviewResult {
  const f = facet ?? {};
  const totals = f.totals?.[0];
  const overTime = toBuckets(f.overTime);
  return {
    totalResponses: totals?.total ?? 0,
    uniqueRespondents: f.unique?.[0]?.n ?? 0,
    avgDurationMs:
      totals?.avgDurationMs != null ? Math.round(totals.avgDurationMs) : null,
    responsesWithDuration: totals?.withDuration ?? 0,
    overTime: interval === "day" ? fillDays(overTime, from, to) : overTime,
    breakdowns: {
      device: toBuckets(f.device),
      browser: toBuckets(f.browser),
      os: toBuckets(f.os),
      country: toBuckets(f.country),
      referrer: toBuckets(f.referrer),
      language: toBuckets(f.language),
    },
  };
}

const DAY_MS = 86_400_000;
const MAX_FILLED_DAYS = 400;

/** Adds zero-count days between the first and last bucket (or the requested range). */
export function fillDays(buckets: Bucket[], from?: Date, to?: Date): Bucket[] {
  if (buckets.length === 0) return buckets;
  const byDay = new Map(buckets.map((b) => [b.key, b.count]));
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const start = new Date(`${from ? ymd(from) : buckets[0]!.key}T00:00:00Z`);
  const end = new Date(
    `${to ? ymd(to) : buckets[buckets.length - 1]!.key}T00:00:00Z`,
  );
  if (
    !(start <= end) ||
    (end.getTime() - start.getTime()) / DAY_MS > MAX_FILLED_DAYS
  )
    return buckets;

  const out: Bucket[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) {
    const key = ymd(new Date(t));
    out.push({ key, count: byDay.get(key) ?? 0 });
  }
  // Keep any bucket outside the window (can happen across timezone edges).
  for (const b of buckets) if (!out.some((o) => o.key === b.key)) out.push(b);
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

// ---- Per-question statistics --------------------------------------------

const path = (id: string) => `$answers.${id}`;
const exists = (id: string): Stage => ({
  $match: { [`answers.${id}`]: { $exists: true } },
});
const countBy = (expr: unknown): Stage => ({
  $group: { _id: expr, count: { $sum: 1 } },
});

/** Field ids are validated to [A-Za-z0-9_-], so interpolating them into paths is safe. */
export function buildQuestionFacets(fields: Field[]): Record<string, Pipeline> {
  const facets: Record<string, Pipeline> = {
    _totals: [
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          ...Object.fromEntries(
            fields.map((f, i) => [
              `a${i}`,
              { $sum: { $cond: [missing(path(f.id)), 0, 1] } },
            ]),
          ),
        },
      },
    ],
  };

  for (const field of fields) {
    const id = field.id;
    switch (field.type) {
      case "select":
        facets[id] = [exists(id), countBy(path(id)), { $sort: { count: -1 } }];
        break;
      case "multi_select":
        facets[id] = [
          exists(id),
          { $unwind: path(id) },
          countBy(path(id)),
          { $sort: { count: -1 } },
        ];
        break;
      case "rating":
        facets[id] = [exists(id), countBy(path(id)), { $sort: { _id: 1 } }];
        break;
      case "number":
        facets[id] = [
          exists(id),
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              avg: { $avg: path(id) },
              min: { $min: path(id) },
              max: { $max: path(id) },
            },
          },
        ];
        facets[`${id}~hist`] = [
          exists(id),
          { $bucketAuto: { groupBy: path(id), buckets: 8 } },
        ];
        break;
      case "date":
        facets[id] = [
          exists(id),
          countBy({ $substrBytes: [path(id), 0, 7] }), // YYYY-MM
          { $sort: { _id: 1 } },
          { $limit: 60 },
        ];
        break;
      case "short_text":
        facets[id] = [
          exists(id),
          countBy(path(id)),
          { $sort: { count: -1, _id: 1 } },
          { $limit: TOP_N },
        ];
        break;
      case "long_text":
        break; // only the answered count; never dump free text into analytics
    }
  }
  return facets;
}

export interface QuestionStats {
  fieldId: string;
  label: string;
  type: Field["type"];
  answered: number;
  answerRate: number;
  [extra: string]: unknown;
}

export function shapeQuestionStats(
  fields: Field[],
  facet: Record<string, any[]> | undefined,
): { total: number; questions: QuestionStats[] } {
  const f = facet ?? {};
  const totals = f._totals?.[0] ?? {};
  const total: number = totals.total ?? 0;

  const questions = fields.map((field, i): QuestionStats => {
    const answered: number = totals[`a${i}`] ?? 0;
    const base = {
      fieldId: field.id,
      label: field.label,
      type: field.type,
      answered,
      answerRate: total ? Math.round((answered / total) * 1000) / 1000 : 0,
    };
    const rows: any[] = f[field.id] ?? [];

    switch (field.type) {
      case "select":
      case "multi_select": {
        const counts = new Map(
          rows.map((r) => [String(r._id), r.count as number]),
        );
        return {
          ...base,
          options: field.options.map((o) => ({
            id: o.id,
            label: o.label,
            count: counts.get(o.id) ?? 0,
          })),
        };
      }
      case "rating": {
        const counts = new Map(
          rows.map((r) => [Number(r._id), r.count as number]),
        );
        const distribution = Array.from({ length: field.max }, (_, k) => ({
          value: k + 1,
          count: counts.get(k + 1) ?? 0,
        }));
        const sum = distribution.reduce((s, d) => s + d.value * d.count, 0);
        return {
          ...base,
          distribution,
          average: answered ? Math.round((sum / answered) * 100) / 100 : null,
        };
      }
      case "number": {
        const s = rows[0];
        const hist: any[] = f[`${field.id}~hist`] ?? [];
        return {
          ...base,
          avg: s ? Math.round(s.avg * 100) / 100 : null,
          min: s?.min ?? null,
          max: s?.max ?? null,
          histogram: hist.map((h) => ({
            min: h._id.min,
            max: h._id.max,
            count: h.count,
          })),
        };
      }
      case "date":
        return {
          ...base,
          byMonth: rows.map((r) => ({ month: String(r._id), count: r.count })),
        };
      case "short_text":
        return {
          ...base,
          topValues: rows.map((r) => ({
            value: String(r._id),
            count: r.count,
          })),
        };
      case "long_text":
        return base;
    }
  });

  return { total, questions };
}

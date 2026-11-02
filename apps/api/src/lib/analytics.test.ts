import { describe, expect, it } from "vitest";
// The default entry point registers all MongoDB operators into its context.
import { Aggregator } from "mingo";
import { fieldSchema, type Field } from "@fb/shared";
import {
  buildQuestionFacets,
  buildSummaryFacets,
  fillDays,
  shapeOverview,
  shapeQuestionStats,
  type Pipeline,
} from "./analytics";

const f = (raw: unknown): Field => fieldSchema.parse(raw);

const fields: Field[] = [
  f({
    id: "color",
    type: "select",
    label: "Color",
    options: [
      { id: "red", label: "Red" },
      { id: "blue", label: "Blue" },
      { id: "green", label: "Green" },
    ],
  }),
  f({
    id: "tags",
    type: "multi_select",
    label: "Tags",
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
    ],
  }),
  f({ id: "score", type: "rating", label: "Score", max: 5 }),
  f({ id: "age", type: "number", label: "Age" }),
  f({ id: "when", type: "date", label: "When" }),
  f({ id: "city", type: "short_text", label: "City" }),
  f({ id: "story", type: "long_text", label: "Story" }),
];

const meta = (over: Record<string, unknown> = {}) => ({
  ipHash: "ip1",
  device: "desktop",
  browser: "Chrome",
  os: "Windows",
  country: "BD",
  language: "en-US",
  durationMs: 10_000,
  ...over,
});

const docs = [
  {
    submittedAt: new Date("2026-10-01T10:00:00Z"),
    answers: {
      color: "red",
      tags: ["a", "b"],
      score: 5,
      age: 20,
      when: "2026-01-10",
      city: "Dhaka",
      story: "x",
    },
    meta: meta(),
  },
  {
    submittedAt: new Date("2026-10-01T11:00:00Z"),
    answers: {
      color: "red",
      tags: ["a"],
      score: 4,
      age: 30,
      when: "2026-01-20",
      city: "Dhaka",
    },
    meta: meta({
      ipHash: "ip2",
      device: "mobile",
      browser: "Mobile Safari",
      os: "iOS",
      durationMs: 20_000,
    }),
  },
  {
    submittedAt: new Date("2026-10-03T09:00:00Z"),
    answers: {
      color: "blue",
      score: 4,
      age: 0,
      when: "2026-02-05",
      city: "Chattogram",
    },
    meta: meta({
      ipHash: "ip2",
      country: undefined,
      referrer: "https://example.com",
    }),
  },
  {
    submittedAt: new Date("2026-10-03T23:30:00Z"),
    answers: { color: "red" },
    meta: meta({ ipHash: "ip3", durationMs: undefined, language: undefined }),
  },
];

const run = (facets: Record<string, Pipeline>) =>
  new Aggregator([{ $facet: facets }] as never[]).run(docs)[0] as Record<
    string,
    any[]
  >;

describe("summary pipeline", () => {
  const out = run(buildSummaryFacets("+00:00", "day"));
  const o = shapeOverview(out, "day");

  it("counts totals, unique respondents and duration", () => {
    expect(o.totalResponses).toBe(4);
    expect(o.uniqueRespondents).toBe(3);
    expect(o.responsesWithDuration).toBe(3);
    expect(o.avgDurationMs).toBe(13_333);
  });

  it("buckets by day and fills empty days with zero", () => {
    expect(o.overTime).toEqual([
      { key: "2026-10-01", count: 2 },
      { key: "2026-10-02", count: 0 },
      { key: "2026-10-03", count: 2 },
    ]);
  });

  it("breaks down by header-derived dimensions with fallbacks", () => {
    expect(o.breakdowns.device).toEqual([
      { key: "desktop", count: 3 },
      { key: "mobile", count: 1 },
    ]);
    expect(o.breakdowns.country).toEqual([
      { key: "BD", count: 3 },
      { key: "Unknown", count: 1 },
    ]);
    expect(o.breakdowns.referrer).toEqual([
      { key: "Direct", count: 3 },
      { key: "https://example.com", count: 1 },
    ]);
    expect(o.breakdowns.language.find((b) => b.key === "Unknown")?.count).toBe(
      1,
    );
  });

  it("respects the requested timezone for day buckets", () => {
    // 23:30 UTC on Oct 3 is already Oct 4 in Bangladesh (UTC+6). mingo only understands offsets; MongoDB also accepts names like Asia/Dhaka.
    const dhaka = shapeOverview(
      run(buildSummaryFacets("+06:00", "day")),
      "day",
    );
    expect(dhaka.overTime.map((b) => b.key)).toContain("2026-10-04");
  });

  it("supports hourly buckets", () => {
    const hourly = shapeOverview(
      run(buildSummaryFacets("+00:00", "hour")),
      "hour",
    );
    expect(hourly.overTime[0]).toEqual({ key: "2026-10-01T10:00", count: 1 });
  });

  it("returns empty shapes for no data", () => {
    const empty = shapeOverview(undefined, "day");
    expect(empty.totalResponses).toBe(0);
    expect(empty.overTime).toEqual([]);
    expect(empty.avgDurationMs).toBeNull();
  });
});

describe("question pipelines", () => {
  const { total, questions } = shapeQuestionStats(
    fields,
    run(buildQuestionFacets(fields)),
  );
  const q = (id: string) => questions.find((x) => x.fieldId === id)!;

  it("reports answered counts and rates", () => {
    expect(total).toBe(4);
    expect(q("color").answered).toBe(4);
    expect(q("age").answered).toBe(3); // 0 counts as answered
    expect(q("age").answerRate).toBe(0.75);
    expect(q("story").answered).toBe(1);
  });

  it("counts select options, including zeros, in option order", () => {
    expect(q("color").options).toEqual([
      { id: "red", label: "Red", count: 3 },
      { id: "blue", label: "Blue", count: 1 },
      { id: "green", label: "Green", count: 0 },
    ]);
  });

  it("unwinds multi-select answers", () => {
    expect(q("tags").options).toEqual([
      { id: "a", label: "A", count: 2 },
      { id: "b", label: "B", count: 1 },
    ]);
    expect(q("tags").answered).toBe(2); // respondents, not selections
  });

  it("builds rating distribution and average", () => {
    expect(q("score").distribution).toEqual([
      { value: 1, count: 0 },
      { value: 2, count: 0 },
      { value: 3, count: 0 },
      { value: 4, count: 2 },
      { value: 5, count: 1 },
    ]);
    expect(q("score").average).toBe(4.33);
  });

  it("computes number stats and a histogram", () => {
    expect(q("age")).toMatchObject({ avg: 16.67, min: 0, max: 30 });
    const hist = q("age").histogram as { count: number }[];
    expect(hist.reduce((s, b) => s + b.count, 0)).toBe(3);
  });

  it("groups dates by month and ranks short-text values", () => {
    expect(q("when").byMonth).toEqual([
      { month: "2026-01", count: 2 },
      { month: "2026-02", count: 1 },
    ]);
    expect(q("city").topValues).toEqual([
      { value: "Dhaka", count: 2 },
      { value: "Chattogram", count: 1 },
    ]);
  });

  it("never exposes long free text", () => {
    expect(q("story")).not.toHaveProperty("topValues");
  });

  it("handles a form with no responses", () => {
    const empty = shapeQuestionStats(fields, undefined);
    expect(empty.total).toBe(0);
    expect(empty.questions[0]).toMatchObject({ answered: 0, answerRate: 0 });
  });
});

describe("fillDays", () => {
  it("fills between explicit range bounds", () => {
    const filled = fillDays(
      [{ key: "2026-10-02", count: 5 }],
      new Date("2026-10-01T00:00:00Z"),
      new Date("2026-10-03T00:00:00Z"),
    );
    expect(filled).toEqual([
      { key: "2026-10-01", count: 0 },
      { key: "2026-10-02", count: 5 },
      { key: "2026-10-03", count: 0 },
    ]);
  });

  it("leaves absurdly long ranges unfilled", () => {
    const sparse = [
      { key: "2020-01-01", count: 1 },
      { key: "2026-10-01", count: 1 },
    ];
    expect(fillDays(sparse)).toEqual(sparse);
  });
});

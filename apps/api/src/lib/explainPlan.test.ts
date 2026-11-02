import { describe, expect, it } from "vitest";
import {
  collScanFailures,
  formatReport,
  summarizePlan,
  type ComparisonRow,
  type PlanSummary,
} from "./explainPlan";

// Shapes trimmed from real MongoDB output.
const findIxscan = {
  queryPlanner: {
    winningPlan: {
      stage: "LIMIT",
      inputStage: {
        stage: "FETCH",
        inputStage: {
          stage: "IXSCAN",
          indexName: "formId_1_submittedAt_-1",
          direction: "forward",
        },
      },
    },
    rejectedPlans: [
      {
        stage: "FETCH",
        inputStage: { stage: "IXSCAN", indexName: "formId_1_version_1" },
      },
    ],
  },
  executionStats: {
    nReturned: 25,
    executionTimeMillis: 1,
    totalKeysExamined: 25,
    totalDocsExamined: 25,
  },
};

const findCollscan = {
  queryPlanner: {
    winningPlan: {
      stage: "LIMIT",
      inputStage: {
        stage: "SORT",
        inputStage: { stage: "COLLSCAN", direction: "forward" },
      },
    },
  },
  executionStats: {
    nReturned: 25,
    executionTimeMillis: 480,
    totalKeysExamined: 0,
    totalDocsExamined: 100_000,
  },
};

const aggregateFacet = {
  stages: [
    {
      $cursor: {
        queryPlanner: {
          winningPlan: {
            stage: "FETCH",
            inputStage: {
              stage: "IXSCAN",
              indexName: "formId_1_submittedAt_-1",
            },
          },
        },
        executionStats: {
          nReturned: 100_000,
          executionTimeMillis: 210,
          totalKeysExamined: 100_000,
          totalDocsExamined: 100_000,
        },
      },
    },
    { $facet: { total: [] } },
  ],
};

const slotBased = {
  queryPlanner: {
    winningPlan: {
      queryPlan: {
        stage: "FETCH",
        inputStage: { stage: "IXSCAN", indexName: "formId_1_meta.ipHash_1" },
      },
      slotBasedPlan: { slots: "$$RESULT=s5 env: { }", stages: "[1] nlj ..." },
    },
  },
  executionStats: {
    nReturned: 3,
    executionTimeMillis: 0,
    totalKeysExamined: 3,
    totalDocsExamined: 3,
  },
};

describe("summarizePlan", () => {
  it("reads a find with an index scan and ignores rejected plans", () => {
    const s = summarizePlan(findIxscan);
    expect(s.stages).toEqual(["LIMIT", "FETCH", "IXSCAN"]);
    expect(s.indexNames).toEqual(["formId_1_submittedAt_-1"]);
    expect(s).toMatchObject({
      usesCollScan: false,
      usesIndex: true,
      keysExamined: 25,
      docsExamined: 25,
      nReturned: 25,
      millis: 1,
    });
  });

  it("detects a collection scan", () => {
    const s = summarizePlan(findCollscan);
    expect(s.usesCollScan).toBe(true);
    expect(s.usesIndex).toBe(false);
    expect(s.docsExamined).toBe(100_000);
  });

  it("finds the cursor stage nested inside an aggregate with $facet", () => {
    const s = summarizePlan(aggregateFacet);
    expect(s.indexNames).toEqual(["formId_1_submittedAt_-1"]);
    expect(s.docsExamined).toBe(100_000);
    expect(s.millis).toBe(210);
  });

  it("reads slot-based plans", () => {
    const s = summarizePlan(slotBased);
    expect(s.usesIndex).toBe(true);
    expect(s.indexNames).toEqual(["formId_1_meta.ipHash_1"]);
    expect(s.docsExamined).toBe(3);
  });

  it("does not throw on empty or unexpected input", () => {
    for (const input of [
      null,
      undefined,
      {},
      [],
      "nope",
      42,
      { queryPlanner: null },
    ]) {
      const s = summarizePlan(input);
      expect(s.stages).toEqual([]);
      expect(s.usesCollScan).toBe(false);
      expect(s.docsExamined).toBeNull();
    }
  });

  it("reports missing stats as null rather than 0", () => {
    const s = summarizePlan({
      queryPlanner: { winningPlan: { stage: "IXSCAN", indexName: "x" } },
    });
    expect(s.docsExamined).toBeNull();
    expect(s.millis).toBeNull();
  });
});

const row = (
  name: string,
  chosen: PlanSummary,
  scan: PlanSummary,
): ComparisonRow => ({ name, purpose: `Purpose of ${name}`, chosen, scan });

describe("formatReport / collScanFailures", () => {
  const good = row(
    "Newest responses",
    summarizePlan(findIxscan),
    summarizePlan(findCollscan),
  );
  const bad = row(
    "Unindexed",
    summarizePlan(findCollscan),
    summarizePlan(findCollscan),
  );

  it("renders a table with the avoided-docs ratio and plan labels", () => {
    const md = formatReport({
      rows: [good],
      responses: 100_000,
      views: 150_000,
      serverVersion: "7.0.14",
      generatedAt: new Date("2026-10-29T00:00:00Z"),
    });
    expect(md).toContain("100,000 responses, 150,000 views");
    expect(md).toContain(
      "| Newest responses | IXSCAN (formId_1_submittedAt_-1) | 25 / 100,000 | 4000x fewer | 1 / 480 |",
    );
    expect(md).toContain("## Newest responses");
    expect(md).not.toContain("Warning");
  });

  it("warns when the chosen plan is a collection scan", () => {
    const md = formatReport({
      rows: [bad],
      responses: 10,
      generatedAt: new Date(),
    });
    expect(md).toContain("**Warning:**");
    expect(md).toContain("| Unindexed | COLLSCAN |");
    expect(collScanFailures([good, bad])).toEqual(["Unindexed"]);
    expect(collScanFailures([good])).toEqual([]);
  });

  it("handles missing numbers without printing NaN or undefined", () => {
    const empty = row("Mystery", summarizePlan({}), summarizePlan({}));
    const md = formatReport({
      rows: [empty],
      responses: 0,
      generatedAt: new Date(),
    });
    expect(md).not.toMatch(/NaN|undefined/);
    expect(md).toContain("n/a / n/a");
  });
});

/**
 * Reads MongoDB explain() output without depending on one exact shape.
 *
 * The shape differs by server version, by query engine (classic vs slot-based), and between find
 * and aggregate (an aggregate with $facet nests the cursor stage under `stages[0].$cursor`). So we
 * search the document for the pieces we need instead of walking a fixed path.
 */

export interface PlanSummary {
  /** Plan stages from the winning plan, outermost first, in the order they were found. */
  stages: string[];
  indexNames: string[];
  usesCollScan: boolean;
  usesIndex: boolean;
  keysExamined: number | null;
  docsExamined: number | null;
  nReturned: number | null;
  millis: number | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** First object stored under `key` anywhere in the tree (depth-first, parents before children). */
function findKey(node: unknown, key: string): unknown {
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findKey(item, key);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (!isObj(node)) return undefined;
  if (key in node) return node[key];
  for (const value of Object.values(node)) {
    const hit = findKey(value, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** Collects `stage` names and `indexName`s from a plan tree, in encounter order. */
function walkPlan(node: unknown, stages: string[], indexes: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) walkPlan(item, stages, indexes);
    return;
  }
  if (!isObj(node)) return;
  if (typeof node.stage === "string") stages.push(node.stage);
  if (typeof node.indexName === "string") indexes.push(node.indexName);
  for (const [k, v] of Object.entries(node)) {
    if (k === "rejectedPlans") continue; // only the plan that actually ran
    if (isObj(v) || Array.isArray(v)) walkPlan(v, stages, indexes);
  }
}

export function summarizePlan(explain: unknown): PlanSummary {
  const planner = findKey(explain, "queryPlanner");
  const winning = isObj(planner) ? planner.winningPlan : undefined;
  const stages: string[] = [];
  const indexes: string[] = [];
  walkPlan(winning, stages, indexes);

  const stats = findKey(explain, "executionStats");
  const s = isObj(stats) ? stats : {};

  const unique = <T>(xs: T[]) => [...new Set(xs)];
  return {
    stages,
    indexNames: unique(indexes),
    usesCollScan: stages.includes("COLLSCAN"),
    usesIndex: stages.includes("IXSCAN") || indexes.length > 0,
    keysExamined: num(s.totalKeysExamined),
    docsExamined: num(s.totalDocsExamined),
    nReturned: num(s.nReturned),
    millis: num(s.executionTimeMillis),
  };
}

// ---- Report ---------------------------------------------------------------

export interface ComparisonRow {
  name: string;
  /** What the query is for, in a few words. */
  purpose: string;
  /** The plan the server picks on its own. */
  chosen: PlanSummary;
  /** The same query forced to a full collection scan with hint({ $natural: 1 }). */
  scan: PlanSummary;
}

const fmt = (n: number | null, suffix = "") =>
  n === null ? "n/a" : `${n.toLocaleString("en-US")}${suffix}`;

const planLabel = (p: PlanSummary) => {
  if (p.usesCollScan) return "COLLSCAN";
  if (p.indexNames.length > 0) return `IXSCAN (${p.indexNames.join(", ")})`;
  return p.stages[0] ?? "unknown";
};

/** A ratio worth showing: both sides known and the indexed side non-zero. */
function ratio(scan: number | null, chosen: number | null): string {
  if (scan === null || chosen === null) return "n/a";
  if (chosen === 0) return scan === 0 ? "1x" : "all of it avoided";
  return `${(scan / chosen).toFixed(scan / chosen >= 10 ? 0 : 1)}x fewer`;
}

export function formatReport(opts: {
  rows: ComparisonRow[];
  responses: number;
  views?: number;
  serverVersion?: string;
  generatedAt: Date;
}): string {
  const { rows } = opts;
  const out: string[] = [];
  out.push("# explain() report: indexed plan vs forced full scan", "");
  out.push(
    `Collection size: ${opts.responses.toLocaleString("en-US")} responses` +
      (opts.views !== undefined
        ? `, ${opts.views.toLocaleString("en-US")} views`
        : "") +
      ".",
    `Server: ${opts.serverVersion ?? "unknown"}. Generated ${opts.generatedAt.toISOString()}.`,
    "",
    '"Chosen" is the plan MongoDB picks. "Scan" is the same query forced onto a full collection scan with `hint({ $natural: 1 })`. Timings come from a single run and include cache effects, so treat the docs-examined ratio as the stable number.',
    "",
  );

  out.push(
    "| Query | Chosen plan | Docs examined (chosen / scan) | Docs avoided | Time ms (chosen / scan) |",
  );
  out.push("| --- | --- | --- | --- | --- |");
  for (const r of rows) {
    out.push(
      `| ${r.name} | ${planLabel(r.chosen)} | ${fmt(r.chosen.docsExamined)} / ${fmt(r.scan.docsExamined)} | ${ratio(r.scan.docsExamined, r.chosen.docsExamined)} | ${fmt(r.chosen.millis)} / ${fmt(r.scan.millis)} |`,
    );
  }
  out.push("");

  for (const r of rows) {
    out.push(`## ${r.name}`, "", r.purpose, "");
    out.push(
      `- Chosen: ${planLabel(r.chosen)}; stages ${r.chosen.stages.join(" > ") || "n/a"}`,
    );
    out.push(
      `- Keys examined ${fmt(r.chosen.keysExamined)}, docs examined ${fmt(r.chosen.docsExamined)}, returned ${fmt(r.chosen.nReturned)}`,
    );
    out.push(
      `- Scan: docs examined ${fmt(r.scan.docsExamined)}, returned ${fmt(r.scan.nReturned)}`,
    );
    if (r.chosen.usesCollScan)
      out.push(
        "- **Warning:** the server chose a full collection scan. An index is missing or unusable for this query.",
      );
    out.push("");
  }
  return out.join("\n");
}

/** Names of queries whose chosen plan scans the whole collection. */
export const collScanFailures = (rows: ComparisonRow[]): string[] =>
  rows.filter((r) => r.chosen.usesCollScan).map((r) => r.name);

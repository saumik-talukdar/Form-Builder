/**
 * Compares the query plan MongoDB picks against a forced full scan, for the queries the app runs.
 * Run after seeding:
 *
 *   npm run explain -w @fb/api -- --out explain-report.md
 *   npm run explain -w @fb/api -- --check      # exit 1 if any chosen plan is a COLLSCAN
 */
import { parseArgs } from "node:util";
import { writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { config } from "../config";
import { Form } from "../models/form";
import { FormView } from "../models/formView";
import { ResponseModel } from "../models/response";
import { buildSummaryFacets } from "../lib/analytics";
import {
  collScanFailures,
  formatReport,
  summarizePlan,
  type ComparisonRow,
} from "../lib/explainPlan";
import { DEMO_SLUG, hex32 } from "../lib/seedData";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    check: { type: "boolean", default: false },
  },
});

interface Probe {
  name: string;
  purpose: string;
  run: (hint?: Record<string, 1>) => Promise<unknown>;
}

async function main() {
  await mongoose.connect(config.MONGODB_URI);
  const form = await Form.findOne({ slug: DEMO_SLUG }).lean();
  if (!form) {
    console.error(`No "${DEMO_SLUG}" form found. Run the seed script first.`);
    process.exit(1);
  }
  const formId = form._id;
  const responses = ResponseModel.collection;
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const ex = <T extends { explain(v: string): Promise<unknown> }>(cursor: T) =>
    cursor.explain("executionStats");

  const probes: Probe[] = [
    {
      name: "Newest responses",
      purpose:
        "Owner's response list: first page, newest first (formId, submittedAt desc).",
      run: (hint) =>
        ex(
          responses.find(
            { formId },
            {
              sort: { submittedAt: -1, _id: -1 },
              limit: 26,
              ...(hint && { hint }),
            },
          ),
        ),
    },
    {
      name: "Last 7 days",
      purpose: "Date-range filter used by analytics and exports.",
      run: (hint) =>
        ex(
          responses.find(
            { formId, submittedAt: { $gte: weekAgo } },
            hint ? { hint } : {},
          ),
        ),
    },
    {
      name: "Duplicate check by IP hash",
      purpose: "Soft duplicate protection on submit (formId, meta.ipHash).",
      run: (hint) =>
        ex(
          responses.find(
            { formId, "meta.ipHash": hex32(3, 1) },
            { limit: 1, ...(hint && { hint }) },
          ),
        ),
    },
    {
      name: "Per-version responses",
      purpose: "Per-question stats read one form version at a time.",
      run: (hint) =>
        ex(
          responses.find(
            { formId, version: 1 },
            { limit: 1000, ...(hint && { hint }) },
          ),
        ),
    },
    {
      name: "Analytics overview ($facet)",
      purpose:
        "The real $match + $facet pipeline behind the results dashboard (30 days).",
      run: (hint) =>
        ex(
          responses.aggregate(
            [
              {
                $match: {
                  formId,
                  submittedAt: { $gte: new Date(Date.now() - 30 * 86_400_000) },
                },
              },
              { $facet: buildSummaryFacets("+06:00", "day") },
            ],
            { allowDiskUse: true, ...(hint && { hint }) },
          ),
        ),
    },
  ];

  const rows: ComparisonRow[] = [];
  for (const p of probes) {
    const chosen = summarizePlan(await p.run());
    const scan = summarizePlan(await p.run({ $natural: 1 }));
    rows.push({ name: p.name, purpose: p.purpose, chosen, scan });
    console.log(
      `${p.name}: ${chosen.usesCollScan ? "COLLSCAN" : chosen.indexNames.join(", ") || chosen.stages[0]} | docs ${chosen.docsExamined} vs ${scan.docsExamined}`,
    );
  }

  const info = await mongoose.connection.db!.admin().serverInfo();
  const report = formatReport({
    rows,
    responses: await ResponseModel.countDocuments({ formId }),
    views: await FormView.countDocuments({ formId }),
    serverVersion: info.version,
    generatedAt: new Date(),
  });
  if (values.out) {
    await writeFile(values.out, report);
    console.log(`Report written to ${values.out}`);
  } else {
    console.log("\n" + report);
  }

  const unreadable = rows
    .filter((r) => r.chosen.stages.length === 0)
    .map((r) => r.name);
  if (values.check && unreadable.length > 0) {
    console.error(
      `No plan information returned for: ${unreadable.join(", ")} (is this a real MongoDB server?)`,
    );
    process.exitCode = 1;
  }
  const bad = collScanFailures(rows);
  if (values.check && bad.length > 0) {
    console.error(`Full collection scan chosen for: ${bad.join(", ")}`);
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

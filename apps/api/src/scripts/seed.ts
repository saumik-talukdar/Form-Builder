/**
 * Fills the database with a demo owner, a published form and a lot of fake traffic.
 *
 *   npm run seed -w @fb/api -- --count 150000 --days 90 --reset
 *
 * Documents are written with the native driver in batches, so 100k+ rows take seconds.
 * Views are kept inside 80 days so the 90-day TTL index never deletes them mid-demo.
 */
import { parseArgs } from "node:util";
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { formDefinitionSchema } from "@fb/shared";
import { config } from "../config";
import { User } from "../models/user";
import { Form } from "../models/form";
import { FormVersion } from "../models/formVersion";
import { FormView } from "../models/formView";
import { ResponseModel } from "../models/response";
import {
  DEMO_EMAIL,
  DEMO_FIELDS,
  DEMO_SLUG,
  createSeedGenerator,
} from "../lib/seedData";

const DEMO_PASSWORD = "demo-password-123";
const BATCH = 5000;
const MAX_VIEW_DAYS = 80;

const { values } = parseArgs({
  options: {
    count: { type: "string", default: "100000" },
    days: { type: "string", default: "90" },
    seed: { type: "string", default: "42" },
    reset: { type: "boolean", default: false },
  },
});
const count = Number(values.count);
const days = Number(values.days);
const seed = Number(values.seed);
if (![count, days, seed].every(Number.isInteger) || count < 1 || days < 1) {
  console.error(
    "--count, --days and --seed must be whole numbers (count and days at least 1)",
  );
  process.exit(1);
}

async function main() {
  await mongoose.connect(config.MONGODB_URI);
  console.log(`Connected to ${mongoose.connection.name}`);
  await Promise.all([
    User.init(),
    Form.init(),
    FormVersion.init(),
    ResponseModel.init(),
  ]);
  try {
    await FormView.init(); // creates the 90-day TTL index
  } catch (err) {
    // MongoDB-compatible stand-ins (FerretDB) lack TTL indexes; real MongoDB never hits this.
    if ((err as { code?: number }).code !== 238) throw err;
    console.warn(
      "Warning: this server does not support TTL indexes; seeded views will not expire",
    );
  }

  let user = await User.findOne({ email: DEMO_EMAIL });
  user ??= await User.create({
    email: DEMO_EMAIL,
    passwordHash: await bcrypt.hash(DEMO_PASSWORD, 12),
  });

  const existing = await Form.findOne({ slug: DEMO_SLUG });
  if (existing) {
    if (!values.reset) {
      console.error(
        `The "${DEMO_SLUG}" form already exists. Re-run with --reset to replace it.`,
      );
      process.exit(1);
    }
    await Promise.all([
      ResponseModel.deleteMany({ formId: existing._id }),
      FormView.deleteMany({ formId: existing._id }),
      FormVersion.deleteMany({ formId: existing._id }),
    ]);
    await existing.deleteOne();
    console.log("Removed the previous demo form and its data");
  }

  const def = formDefinitionSchema.parse({
    title: "Meetup feedback (seeded demo)",
    description: "Fake data for load testing.",
    fields: DEMO_FIELDS,
  });
  const form = await Form.create({
    ownerId: user._id,
    slug: DEMO_SLUG,
    title: def.title,
    description: def.description,
    draftFields: def.fields,
    status: "published",
    publishedVersion: 1,
    responseCount: count,
    settings: { allowMultiple: true },
  });
  await FormVersion.create({
    formId: form._id,
    version: 1,
    title: def.title,
    description: def.description,
    fields: def.fields,
  });

  const end = new Date();
  const responseGen = createSeedGenerator({
    count,
    days,
    end,
    seed,
    formId: form._id,
    version: 1,
  });
  const viewDays = Math.min(days, MAX_VIEW_DAYS);
  const viewGen = createSeedGenerator({
    count,
    days: viewDays,
    end,
    seed,
    formId: form._id,
    version: 1,
  });

  const started = Date.now();
  const responses = ResponseModel.collection;
  for (let done = 0; done < count; done += BATCH) {
    const n = Math.min(BATCH, count - done);
    await responses.insertMany(
      Array.from({ length: n }, () => responseGen.nextResponse()),
      { ordered: false },
    );
    process.stdout.write(`\rresponses ${done + n}/${count}`);
  }
  const viewCount = Math.round(count * 1.5);
  const views = FormView.collection;
  for (let done = 0; done < viewCount; done += BATCH) {
    const n = Math.min(BATCH, viewCount - done);
    await views.insertMany(
      Array.from({ length: n }, () => viewGen.nextView()),
      { ordered: false },
    );
    process.stdout.write(`\rviews ${done + n}/${viewCount}      `);
  }
  console.log(
    `\nInserted ${count} responses and ${viewCount} views in ${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
  console.log(
    `Sign in as ${DEMO_EMAIL} / ${DEMO_PASSWORD}; public form at /f/${DEMO_SLUG}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());

import { describe, expect, it } from "vitest";
import { Types } from "mongoose";
import { compileForm } from "@fb/shared";
import {
  DEMO_FIELDS,
  createSeedGenerator,
  hex32,
  makeRng,
  type SeedOptions,
  type SeedResponse,
} from "./seedData";

const FORM_ID = new Types.ObjectId("a1b2c3d4e5f6a1b2c3d4e5f6");
const END = new Date("2026-10-28T00:00:00Z");
const opts = (over: Partial<SeedOptions> = {}): SeedOptions => ({
  count: 5000,
  days: 60,
  end: END,
  seed: 7,
  formId: FORM_ID,
  version: 1,
  ...over,
});

const make = (n: number, o = opts()) => {
  const g = createSeedGenerator(o);
  return Array.from({ length: n }, () => g.nextResponse());
};

describe("makeRng", () => {
  it("is deterministic per seed and differs across seeds", () => {
    const a = makeRng(1);
    const b = makeRng(1);
    const c = makeRng(2);
    const seqA = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(seqA);
    expect(seqA.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("weighted() respects the weights", () => {
    const rng = makeRng(3);
    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 10_000; i++)
      counts[
        rng.weighted([
          ["a", 0.9],
          ["b", 0.1],
        ] as const)
      ]++;
    expect(counts.a / 10_000).toBeGreaterThan(0.87);
    expect(counts.a / 10_000).toBeLessThan(0.93);
  });
});

describe("hex32", () => {
  it("looks like the real hashes and is stable", () => {
    expect(hex32(5, 1)).toMatch(/^[a-f0-9]{32}$/);
    expect(hex32(5, 1)).toBe(hex32(5, 1));
    expect(hex32(5, 1)).not.toBe(hex32(6, 1));
    expect(hex32(5, 1)).not.toBe(hex32(5, 2));
  });
});

describe("createSeedGenerator", () => {
  it("produces the same documents for the same seed, and different ones otherwise", () => {
    const strip = (rows: SeedResponse[]) => JSON.stringify(rows);
    expect(strip(make(200))).toBe(strip(make(200)));
    expect(strip(make(200))).not.toBe(strip(make(200, opts({ seed: 8 }))));
  });

  it("only generates answers the real validator accepts", () => {
    const form = compileForm(DEMO_FIELDS);
    for (const row of make(3000)) {
      const result = form.validate(row.answers);
      if (!result.success)
        throw new Error(
          `invalid answers ${JSON.stringify(row.answers)}: ${JSON.stringify(result.errors)}`,
        );
    }
  });

  it("answers the conditional question exactly when its condition holds", () => {
    for (const row of make(2000)) {
      expect("which" in row.answers).toBe(row.answers.src === "other");
    }
  });

  it("keeps every timestamp inside the window, never in the future", () => {
    const start = END.getTime() - 60 * 86_400_000;
    for (const row of make(3000)) {
      expect(row.submittedAt.getTime()).toBeGreaterThanOrEqual(start);
      expect(row.submittedAt.getTime()).toBeLessThan(END.getTime());
    }
  });

  it("never emits undefined (the driver would store it as null)", () => {
    const hasUndefined = (v: unknown): boolean =>
      v === undefined ||
      (v !== null &&
        typeof v === "object" &&
        !(v instanceof Date) &&
        !(v instanceof Types.ObjectId) &&
        Object.values(v).some(hasUndefined));
    for (const row of make(3000)) expect(hasUndefined(row)).toBe(false);
  });

  it("has realistic proportions", () => {
    const rows = make(6000);
    const share = (pred: (r: SeedResponse) => boolean) =>
      rows.filter(pred).length / rows.length;
    expect(share((r) => r.meta.device === "mobile")).toBeGreaterThan(0.56);
    expect(share((r) => r.meta.device === "mobile")).toBeLessThan(0.68);
    expect(share((r) => r.meta.country === "BD")).toBeGreaterThan(0.66);
    expect(share((r) => r.meta.country === "BD")).toBeLessThan(0.78);
    expect(share((r) => r.meta.referrer === undefined)).toBeGreaterThan(0.4);
    expect(share((r) => r.meta.durationMs === undefined)).toBeGreaterThan(0.02);
    expect(share((r) => r.meta.durationMs === undefined)).toBeLessThan(0.09);
    const avgRating =
      rows.reduce((s, r) => s + (r.answers.rate as number), 0) / rows.length;
    expect(avgRating).toBeGreaterThan(4.0);
    expect(avgRating).toBeLessThan(4.5);
    for (const r of rows) {
      if (r.meta.durationMs !== undefined) {
        expect(r.meta.durationMs).toBeGreaterThanOrEqual(6000);
        expect(r.meta.durationMs).toBeLessThanOrEqual(1_200_000);
      }
    }
  });

  it("shares addresses between respondents, with a few very common ones", () => {
    const rows = make(6000);
    const counts = new Map<string, number>();
    for (const r of rows)
      counts.set(r.meta.ipHash, (counts.get(r.meta.ipHash) ?? 0) + 1);
    const unique = counts.size / rows.length;
    expect(unique).toBeLessThan(0.8); // repeats exist
    expect(unique).toBeGreaterThan(0.2);
    expect(Math.max(...counts.values())).toBeGreaterThan(20); // a heavily shared address
    expect(
      rows.every(
        (r) =>
          /^[a-f0-9]{32}$/.test(r.meta.ipHash) &&
          /^[a-f0-9]{32}$/.test(r.meta.tokenHash),
      ),
    ).toBe(true);
  });

  it("has a traffic shape: some days are much busier than the median", () => {
    const perDay = new Map<string, number>();
    for (const r of make(6000)) {
      const k = r.submittedAt.toISOString().slice(0, 10);
      perDay.set(k, (perDay.get(k) ?? 0) + 1);
    }
    const counts = [...perDay.values()].sort((a, b) => a - b);
    expect(counts[counts.length - 1]!).toBeGreaterThan(
      2 * counts[Math.floor(counts.length / 2)]!,
    );
  });

  it("generates views over the same window with a larger pool of visitors", () => {
    const g = createSeedGenerator(opts());
    const views = Array.from({ length: 2000 }, () => g.nextView());
    const start = END.getTime() - 60 * 86_400_000;
    expect(
      views.every(
        (v) =>
          v.createdAt.getTime() >= start &&
          v.createdAt.getTime() < END.getTime(),
      ),
    ).toBe(true);
    expect(
      views.every(
        (v) => v.formId.equals(FORM_ID) && /^[a-f0-9]{32}$/.test(v.ipHash),
      ),
    ).toBe(true);
  });

  it("works for tiny counts and one-day windows", () => {
    expect(make(5, opts({ count: 5, days: 1 })).length).toBe(5);
  });
});

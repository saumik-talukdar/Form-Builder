import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "./ttlCache";

describe("TtlCache", () => {
  it("returns the cached value until it expires", async () => {
    let t = 0;
    const cache = new TtlCache<number>(1000, 10, () => t);
    let n = 0;
    const compute = vi.fn(async () => ++n);
    expect(await cache.get("k", compute)).toBe(1);
    t = 999;
    expect(await cache.get("k", compute)).toBe(1);
    t = 1000;
    expect(await cache.get("k", compute)).toBe(2);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("shares one computation between concurrent callers", async () => {
    const cache = new TtlCache<string>(1000);
    let resolve!: (v: string) => void;
    const compute = vi.fn(() => new Promise<string>((r) => (resolve = r)));
    const a = cache.get("k", compute);
    const b = cache.get("k", compute);
    resolve("done");
    expect(await Promise.all([a, b])).toEqual(["done", "done"]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("does not cache failures", async () => {
    const cache = new TtlCache<number>(1000);
    await expect(
      cache.get("k", async () => Promise.reject(new Error("boom"))),
    ).rejects.toThrow("boom");
    expect(await cache.get("k", async () => 7)).toBe(7);
  });

  it("keeps keys separate and evicts the oldest beyond the limit", async () => {
    const cache = new TtlCache<string>(10_000, 2);
    for (const k of ["a", "b", "c"]) await cache.get(k, async () => k);
    expect(cache.size).toBe(2);
    const compute = vi.fn(async () => "again");
    await cache.get("a", compute); // evicted, recomputed
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

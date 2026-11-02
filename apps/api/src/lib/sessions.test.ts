/** Needs a real Redis: TEST_REDIS_URL=redis://127.0.0.1:6379 npm test -w @fb/api */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Redis } from "ioredis";
import { createSessionStore, type SessionStore } from "./sessions";

const URL = process.env.TEST_REDIS_URL;

describe.skipIf(!URL)("session store (real Redis)", () => {
  const redis = new Redis(URL ?? "redis://127.0.0.1:6379", {
    lazyConnect: true,
  });
  let t = 1_000_000;
  let store: SessionStore;

  beforeEach(async () => {
    if (redis.status === "wait") await redis.connect();
    await redis.flushdb();
    t = 1_000_000;
    store = createSessionStore(redis, {
      ttlSeconds: 60,
      graceMs: 10_000,
      now: () => t,
    });
  });
  afterAll(async () => {
    await redis.flushdb();
    await redis.quit();
  });

  it("rotates: each token works once and yields a new one", async () => {
    const { sessionId, refreshToken } = await store.create("u1", "Chrome");
    const r1 = await store.rotate(refreshToken);
    expect(r1).toMatchObject({ status: "ok", userId: "u1", sessionId });
    if (r1.status !== "ok") throw new Error();
    expect(r1.refreshToken).not.toBe(refreshToken);
    expect((await store.rotate(r1.refreshToken)).status).toBe("ok");
  });

  it("treats a replay after the grace window as theft and revokes the whole session", async () => {
    const { refreshToken } = await store.create("u1", "Chrome");
    const r1 = await store.rotate(refreshToken);
    if (r1.status !== "ok") throw new Error();
    t += 11_000;
    expect((await store.rotate(refreshToken)).status).toBe("reused");
    // the legitimate holder's newest token is dead too
    expect((await store.rotate(r1.refreshToken)).status).toBe("invalid");
    expect(await store.list("u1")).toEqual([]);
  });

  it("does not revoke when two tabs race inside the grace window", async () => {
    const { refreshToken } = await store.create("u1", "Chrome");
    const r1 = await store.rotate(refreshToken);
    t += 2000;
    expect((await store.rotate(refreshToken)).status).toBe("grace");
    if (r1.status !== "ok") throw new Error();
    expect((await store.rotate(r1.refreshToken)).status).toBe("ok");
  });

  it("only one of many concurrent rotations of the same token wins", async () => {
    const { refreshToken } = await store.create("u1", "Chrome");
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.rotate(refreshToken)),
    );
    expect(results.filter((r) => r.status === "ok")).toHaveLength(1);
    expect(results.filter((r) => r.status === "grace")).toHaveLength(9);
  });

  it("rejects unknown tokens", async () => {
    expect((await store.rotate("nope")).status).toBe("invalid");
  });

  it("stores only a hash of the token", async () => {
    const { refreshToken } = await store.create("u1", "Chrome");
    const keys = await redis.keys("*");
    expect(keys.some((k) => k.includes(refreshToken))).toBe(false);
  });

  it("lists, revokes one, and revokes all except the current", async () => {
    const a = await store.create("u1", "Chrome on Windows");
    t += 1000;
    const b = await store.create("u1", "Safari on iOS");
    t += 1000;
    const c = await store.create("u1", "Firefox");
    await store.create("u2", "someone else");

    const list = await store.list("u1");
    expect(list.map((s) => s.userAgent)).toEqual([
      "Firefox",
      "Safari on iOS",
      "Chrome on Windows",
    ]);

    expect(await store.revoke("u1", b.sessionId)).toBe(true);
    expect(await store.revoke("u1", b.sessionId)).toBe(false);
    expect((await store.rotate(b.refreshToken)).status).toBe("invalid");

    expect(await store.revokeAll("u1", c.sessionId)).toBe(1);
    expect((await store.rotate(a.refreshToken)).status).toBe("invalid");
    expect((await store.rotate(c.refreshToken)).status).toBe("ok");
    expect((await store.list("u2")).length).toBe(1); // other users untouched
  });

  it("a user cannot revoke someone else's session by id", async () => {
    const s = await store.create("u2", "x");
    expect(await store.revoke("u1", s.sessionId)).toBe(false);
    expect(await store.list("u2")).toHaveLength(1);
  });

  it("revokeByToken ends the session (logout)", async () => {
    const { refreshToken } = await store.create("u1", "Chrome");
    await store.revokeByToken(refreshToken);
    expect((await store.rotate(refreshToken)).status).toBe("invalid");
  });

  it("sessions expire with their TTL", async () => {
    const { sessionId } = await store.create("u1", "Chrome");
    await redis.expire(`fam:${sessionId}`, 1);
    await new Promise((r) => setTimeout(r, 1200));
    expect(await store.list("u1")).toEqual([]);
  });
});

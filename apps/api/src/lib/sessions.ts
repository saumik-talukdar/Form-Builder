import { createHash, randomBytes } from "node:crypto";
import type { Redis } from "ioredis";

/**
 * Sessions with rotating refresh tokens, stored in Redis.
 *
 * A session ("family") is one signed-in browser. It owns a chain of refresh tokens where each
 * token can be used exactly once: using it returns a fresh token and marks the old one used.
 * If an already-used token shows up again (after a short grace period for two tabs racing), the
 * token was copied, so the whole session is revoked and the real owner has to sign in again.
 *
 * Keys:
 *   rt:<sha256(token)>    hash  user, fam, used (ms timestamp once consumed)   TTL = refresh lifetime
 *   fam:<familyId>        hash  user, ua, created, lastUsed                    TTL = refresh lifetime (sliding)
 *   user:<id>:sessions    set   family ids (pruned lazily when a family has expired)
 *
 * Only a hash of each token is stored, so a Redis dump does not contain usable tokens.
 */

export interface SessionInfo {
  id: string;
  userAgent: string;
  createdAt: Date;
  lastUsedAt: Date;
}

export type RotateResult =
  | { status: "ok"; userId: string; sessionId: string; refreshToken: string }
  | { status: "reused" } // theft suspected; the session was revoked
  | { status: "grace" } // raced with another tab; nothing revoked
  | { status: "invalid" };

export interface SessionStore {
  create(
    userId: string,
    userAgent: string,
  ): Promise<{ sessionId: string; refreshToken: string }>;
  rotate(refreshToken: string): Promise<RotateResult>;
  /** Revoke the session a refresh token belongs to (used for logout). */
  revokeByToken(refreshToken: string): Promise<void>;
  revoke(userId: string, sessionId: string): Promise<boolean>;
  /** Revoke every session of a user, optionally keeping one. */
  revokeAll(userId: string, exceptSessionId?: string): Promise<number>;
  list(userId: string): Promise<SessionInfo[]>;
}

const sha = (token: string) => createHash("sha256").update(token).digest("hex");
const newToken = () => randomBytes(32).toString("base64url");
const newId = () => randomBytes(12).toString("hex");

// Atomically consume a token: KEYS[1] = rt key. ARGV = now, graceMs.
const CONSUME = `
local rec = redis.call('HMGET', KEYS[1], 'user', 'fam', 'used')
if not rec[1] then return {'invalid'} end
if redis.call('EXISTS', 'fam:' .. rec[2]) == 0 then return {'invalid'} end
if rec[3] then
  if tonumber(ARGV[1]) - tonumber(rec[3]) < tonumber(ARGV[2]) then return {'grace'} end
  return {'reused', rec[1], rec[2]}
end
redis.call('HSET', KEYS[1], 'used', ARGV[1])
return {'ok', rec[1], rec[2]}
`;

export interface SessionOptions {
  ttlSeconds: number;
  /** Two tabs refreshing at once is normal; a reuse inside this window is not treated as theft. */
  graceMs?: number;
  now?: () => number;
}

export function createSessionStore(
  redis: Redis,
  opts: SessionOptions,
): SessionStore {
  const { ttlSeconds } = opts;
  const graceMs = opts.graceMs ?? 10_000;
  const now = opts.now ?? Date.now;

  async function issue(userId: string, familyId: string): Promise<string> {
    const token = newToken();
    await redis
      .multi()
      .hset(`rt:${sha(token)}`, { user: userId, fam: familyId })
      .expire(`rt:${sha(token)}`, ttlSeconds)
      .exec();
    return token;
  }

  async function revokeFamily(
    userId: string,
    familyId: string,
  ): Promise<boolean> {
    const [deleted] = await Promise.all([
      redis.del(`fam:${familyId}`),
      redis.srem(`user:${userId}:sessions`, familyId),
    ]);
    return deleted > 0;
  }

  return {
    async create(userId, userAgent) {
      const sessionId = newId();
      const t = String(now());
      await redis
        .multi()
        .hset(`fam:${sessionId}`, {
          user: userId,
          ua: userAgent.slice(0, 300),
          created: t,
          lastUsed: t,
        })
        .expire(`fam:${sessionId}`, ttlSeconds)
        .sadd(`user:${userId}:sessions`, sessionId)
        .exec();
      return { sessionId, refreshToken: await issue(userId, sessionId) };
    },

    async rotate(refreshToken) {
      const res = (await redis.eval(
        CONSUME,
        1,
        `rt:${sha(refreshToken)}`,
        String(now()),
        String(graceMs),
      )) as string[];
      const [status, userId, familyId] = res;
      if (status === "ok" && userId && familyId) {
        await redis
          .multi()
          .hset(`fam:${familyId}`, { lastUsed: String(now()) })
          .expire(`fam:${familyId}`, ttlSeconds)
          .exec();
        return {
          status: "ok",
          userId,
          sessionId: familyId,
          refreshToken: await issue(userId, familyId),
        };
      }
      if (status === "reused" && userId && familyId) {
        await revokeFamily(userId, familyId);
        return { status: "reused" };
      }
      return { status: status === "grace" ? "grace" : "invalid" };
    },

    async revokeByToken(refreshToken) {
      const [userId, familyId] = await redis.hmget(
        `rt:${sha(refreshToken)}`,
        "user",
        "fam",
      );
      if (userId && familyId) await revokeFamily(userId, familyId);
    },

    async revoke(userId, sessionId) {
      // Ownership check: ids are random, but a user must never be able to end someone else's session.
      if ((await redis.hget(`fam:${sessionId}`, "user")) !== userId)
        return false;
      return revokeFamily(userId, sessionId);
    },

    async revokeAll(userId, exceptSessionId) {
      const ids = (await redis.smembers(`user:${userId}:sessions`)).filter(
        (id) => id !== exceptSessionId,
      );
      await Promise.all(ids.map((id) => revokeFamily(userId, id)));
      return ids.length;
    },

    async list(userId) {
      const ids = await redis.smembers(`user:${userId}:sessions`);
      const rows = await Promise.all(
        ids.map(async (id) => ({ id, rec: await redis.hgetall(`fam:${id}`) })),
      );
      const live: SessionInfo[] = [];
      for (const { id, rec } of rows) {
        if (!rec.user) {
          await redis.srem(`user:${userId}:sessions`, id); // expired
          continue;
        }
        live.push({
          id,
          userAgent: rec.ua ?? "",
          createdAt: new Date(Number(rec.created)),
          lastUsedAt: new Date(Number(rec.lastUsed)),
        });
      }
      return live.sort(
        (a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime(),
      );
    },
  };
}

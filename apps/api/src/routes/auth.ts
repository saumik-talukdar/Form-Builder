import { Router, type Request, type Response } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { User } from "../models/user";
import { Form } from "../models/form";
import { FormVersion } from "../models/formVersion";
import { FormView } from "../models/formView";
import { ResponseModel } from "../models/response";
import {
  AUTH_COOKIE,
  REFRESH_COOKIE,
  requireAuth,
  signAccessToken,
} from "../middleware/auth";
import { badRequest, conflict, notFound, unauthorized } from "../lib/errors";
import { config, isProd } from "../config";
import { getRedis } from "../lib/redis";
import { createSessionStore, type SessionStore } from "../lib/sessions";

export const authRouter = Router();

let sessionStore: SessionStore | null = null;
/** Created on first use so importing this module never opens a connection. */
export const sessions = (): SessionStore =>
  (sessionStore ??= createSessionStore(getRedis(), {
    ttlSeconds: config.REFRESH_TOKEN_TTL_DAYS * 86_400,
    graceMs: config.REFRESH_REUSE_GRACE_MS,
  }));
export const resetSessionStore = () => {
  sessionStore = null;
};

const password = z.string().min(8).max(72); // bcrypt truncates beyond 72 bytes
const email = z.string().trim().toLowerCase().email().max(254);
const credentials = z.object({ email, password });

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.AUTH_RATE_LIMIT_PER_15MIN,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});
const refreshLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: config.READ_RATE_LIMIT_PER_MIN,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});

const base = { httpOnly: true, sameSite: "lax" as const, secure: isProd };
const accessCookie = {
  ...base,
  maxAge: config.ACCESS_TOKEN_TTL_SECONDS * 1000,
  path: "/",
};
// The refresh token is only ever sent to the auth endpoints.
const refreshCookie = {
  ...base,
  maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86_400_000,
  path: "/api/auth",
};

function setSession(
  res: Response,
  userId: string,
  sessionId: string,
  refreshToken: string,
) {
  res.cookie(AUTH_COOKIE, signAccessToken(userId, sessionId), accessCookie);
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookie);
}
function clearSession(res: Response) {
  res.clearCookie(AUTH_COOKIE, { ...base, path: "/" });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: "/api/auth" });
}
async function startSession(req: Request, res: Response, userId: string) {
  const { sessionId, refreshToken } = await sessions().create(
    userId,
    req.get("user-agent") ?? "",
  );
  setSession(res, userId, sessionId, refreshToken);
}

// Compared against when the email is unknown, so timing doesn't reveal accounts.
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);

const publicUser = (u: { _id: unknown; email: string; createdAt?: Date }) => ({
  id: String(u._id),
  email: u.email,
  createdAt: u.createdAt,
});

// ---- Sign up / in / out ----------------------------------------------------

authRouter.post("/register", limiter, async (req, res) => {
  const body = credentials.parse(req.body);
  const passwordHash = await bcrypt.hash(body.password, 12);
  try {
    const user = await User.create({ email: body.email, passwordHash });
    await startSession(req, res, user.id);
    res.status(201).json(publicUser(user));
  } catch (err) {
    if ((err as { code?: number }).code === 11000)
      throw conflict("Email already registered");
    throw err;
  }
});

authRouter.post("/login", limiter, async (req, res) => {
  const body = credentials.parse(req.body);
  const user = await User.findOne({ email: body.email });
  const ok = await bcrypt.compare(
    body.password,
    user?.passwordHash ?? DUMMY_HASH,
  );
  if (!user || !ok) throw unauthorized("Invalid email or password");
  await startSession(req, res, user.id);
  res.json(publicUser(user));
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (typeof token === "string") await sessions().revokeByToken(token);
  clearSession(res);
  res.status(204).end();
});

/** Trade a refresh token for a new access token and a new refresh token (the old one is spent). */
authRouter.post("/refresh", refreshLimiter, async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (typeof token !== "string") throw unauthorized("No session");
  const result = await sessions().rotate(token);
  if (result.status === "grace") {
    // Another tab just rotated this token; its new cookies are on the way. Not an error worth signing out for.
    res
      .status(409)
      .json({ error: "Session refresh already in progress, retry" });
    return;
  }
  if (result.status !== "ok") {
    clearSession(res);
    throw unauthorized(
      result.status === "reused"
        ? "Session ended for your security, please sign in again"
        : "Session expired",
    );
  }
  setSession(res, result.userId, result.sessionId, result.refreshToken);
  res.status(204).end();
});

// ---- Profile -----------------------------------------------------------------

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await User.findById(req.userId).lean();
  if (!user) throw unauthorized();
  res.json(publicUser(user));
});

async function verifyPassword(userId: string | undefined, given: string) {
  const user = await User.findById(userId);
  if (!user) throw unauthorized();
  if (!(await bcrypt.compare(given, user.passwordHash)))
    throw badRequest("Current password is incorrect");
  return user;
}

authRouter.patch("/me", requireAuth, limiter, async (req, res) => {
  const body = z
    .object({ email, currentPassword: z.string().min(1).max(72) })
    .strict()
    .parse(req.body);
  const user = await verifyPassword(req.userId, body.currentPassword);
  if (await User.exists({ email: body.email, _id: { $ne: user._id } }))
    throw conflict("Email already registered");
  user.email = body.email;
  try {
    await user.save();
  } catch (err) {
    if ((err as { code?: number }).code === 11000)
      throw conflict("Email already registered");
    throw err;
  }
  res.json(publicUser(user));
});

authRouter.post("/password", requireAuth, limiter, async (req, res) => {
  const body = z
    .object({
      currentPassword: z.string().min(1).max(72),
      newPassword: password,
    })
    .strict()
    .parse(req.body);
  if (body.currentPassword === body.newPassword)
    throw badRequest("Choose a different password");
  const user = await verifyPassword(req.userId, body.currentPassword);
  user.passwordHash = await bcrypt.hash(body.newPassword, 12);
  await user.save();
  // Everyone else is signed out; this browser stays signed in.
  const ended = await sessions().revokeAll(user.id, req.sessionId);
  res.json({ signedOutElsewhere: ended });
});

authRouter.delete("/me", requireAuth, limiter, async (req, res) => {
  const body = z
    .object({ password: z.string().min(1).max(72) })
    .strict()
    .parse(req.body);
  const user = await verifyPassword(req.userId, body.password);
  const formIds = (
    await Form.find({ ownerId: user._id }).select("_id").lean()
  ).map((f) => f._id);
  await Promise.all([
    ResponseModel.deleteMany({ formId: { $in: formIds } }),
    FormView.deleteMany({ formId: { $in: formIds } }),
    FormVersion.deleteMany({ formId: { $in: formIds } }),
  ]);
  await Form.deleteMany({ ownerId: user._id });
  await user.deleteOne();
  await sessions().revokeAll(user.id);
  clearSession(res);
  res.status(204).end();
});

// ---- Sessions --------------------------------------------------------------

authRouter.get("/sessions", requireAuth, async (req, res) => {
  const list = await sessions().list(req.userId!);
  res.json(
    list.map((s) => ({
      id: s.id,
      current: s.id === req.sessionId,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastUsedAt: s.lastUsedAt,
    })),
  );
});

authRouter.post("/sessions/revoke-others", requireAuth, async (req, res) => {
  res.json({ revoked: await sessions().revokeAll(req.userId!, req.sessionId) });
});

authRouter.delete("/sessions/:id", requireAuth, async (req, res) => {
  const id = String(req.params.id);
  if (!/^[a-f0-9]{24}$/.test(id)) throw notFound("Session not found");
  if (!(await sessions().revoke(req.userId!, id)))
    throw notFound("Session not found");
  if (id === req.sessionId) clearSession(res);
  res.status(204).end();
});

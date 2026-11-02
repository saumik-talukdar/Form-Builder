import type { RequestHandler } from "express";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { unauthorized } from "../lib/errors";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireAuth for form owners. Respondents are anonymous. */
      userId?: string;
      /** The session (refresh-token family) this access token was issued for. */
      sessionId?: string;
    }
  }
}

export const AUTH_COOKIE = "fb_token";
export const REFRESH_COOKIE = "fb_refresh";

export function signAccessToken(userId: string, sessionId: string): string {
  return jwt.sign({ sid: sessionId }, config.JWT_SECRET, {
    subject: userId,
    expiresIn: config.ACCESS_TOKEN_TTL_SECONDS,
  });
}

/**
 * Access tokens are verified without touching the database, so a revoked session's access token
 * keeps working until it expires (at most ACCESS_TOKEN_TTL_SECONDS). Refreshing is what is revoked.
 */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.get("authorization");
  const token =
    req.cookies?.[AUTH_COOKIE] ??
    (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
  if (!token) throw unauthorized();

  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    if (typeof payload === "string" || !payload.sub) throw unauthorized();
    req.userId = payload.sub;
    req.sessionId = typeof payload.sid === "string" ? payload.sid : undefined;
    next();
  } catch {
    throw unauthorized("Invalid or expired session");
  }
};

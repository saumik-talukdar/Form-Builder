import type { Request } from "express";
import UAParser from "ua-parser-js";
import { hmac } from "./hash";
import type { IResponseMeta } from "../models/response";

export const RESPONDENT_COOKIE = "fb_rt";

const COUNTRY_HEADERS = [
  "cf-ipcountry",
  "x-vercel-ip-country",
  "cloudfront-viewer-country",
];

function clip(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  const v = value.trim().slice(0, max);
  return v || undefined;
}

function toOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin.slice(0, 200);
  } catch {
    return undefined;
  }
}

function readCountry(req: Request): string | undefined {
  for (const h of COUNTRY_HEADERS) {
    const v = req.get(h)?.toUpperCase();
    if (v && /^[A-Z]{2}$/.test(v) && v !== "XX" && v !== "T1") return v;
  }
  return undefined;
}

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

export interface ClientHints {
  /** ms epoch when the respondent opened the form (client-reported, clamped) */
  startedAt?: number;
  /** document.referrer as seen by the web app (the API's own Referer is the app itself) */
  referrer?: string;
}

/** Collects anonymous request analytics. Raw IP is never stored. */
export function captureMeta(
  req: Request,
  hints: ClientHints = {},
): IResponseMeta {
  const ua = req.get("user-agent");
  const parsed = ua ? new UAParser(ua).getResult() : undefined;
  const deviceType = parsed?.device.type;
  const device: IResponseMeta["device"] = !ua
    ? "other"
    : deviceType === "mobile"
      ? "mobile"
      : deviceType === "tablet"
        ? "tablet"
        : deviceType
          ? "other"
          : "desktop";

  const token = req.cookies?.[RESPONDENT_COOKIE];
  const now = Date.now();
  const durationMs =
    hints.startedAt !== undefined &&
    hints.startedAt <= now &&
    now - hints.startedAt < 1000 * 60 * 60 * 24
      ? now - hints.startedAt
      : undefined;

  return {
    ipHash: hmac(clientIp(req)),
    tokenHash:
      typeof token === "string" && token ? hmac(`rt:${token}`) : undefined,
    userAgent: clip(ua, 300),
    browser: clip(parsed?.browser.name, 50),
    os: clip(parsed?.os.name, 50),
    device,
    language: clip(req.get("accept-language")?.split(",")[0], 20),
    referrer: toOrigin(hints.referrer) ?? toOrigin(req.get("referer")),
    country: readCountry(req),
    durationMs,
  };
}

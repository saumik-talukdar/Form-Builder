import { Schema, model, Types } from "mongoose";
import type { Answers } from "@fb/shared";

export interface IResponseMeta {
  /** HMAC of the client IP: usable for dedupe/unique counts, not reversible. */
  ipHash: string;
  /** HMAC of the per-browser respondent cookie. */
  tokenHash?: string;
  userAgent?: string;
  browser?: string;
  os?: string;
  device: "desktop" | "mobile" | "tablet" | "other";
  language?: string;
  referrer?: string;
  country?: string;
  durationMs?: number;
}

export interface IResponse {
  formId: Types.ObjectId;
  version: number;
  answers: Answers;
  submittedAt: Date;
  meta: IResponseMeta;
}

const responseSchema = new Schema<IResponse>(
  {
    formId: { type: Schema.Types.ObjectId, ref: "Form", required: true },
    version: { type: Number, required: true },
    answers: { type: Schema.Types.Mixed, required: true },
    submittedAt: { type: Date, default: () => new Date() },
    meta: {
      ipHash: { type: String, required: true },
      tokenHash: String,
      userAgent: String,
      browser: String,
      os: String,
      device: {
        type: String,
        enum: ["desktop", "mobile", "tablet", "other"],
        default: "other",
      },
      language: String,
      referrer: String,
      country: String,
      durationMs: Number,
    },
  },
  { minimize: false },
);

// Listing / time-series analytics for a form
responseSchema.index({ formId: 1, submittedAt: -1 });
// Duplicate protection and unique-respondent counts
responseSchema.index({ formId: 1, "meta.ipHash": 1 });
responseSchema.index({ formId: 1, "meta.tokenHash": 1 }, { sparse: true });
// Per-version analytics
responseSchema.index({ formId: 1, version: 1 });

export const ResponseModel = model<IResponse>("Response", responseSchema);

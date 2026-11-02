import { Schema, model, Types } from "mongoose";
import type { Field } from "@fb/shared";

export interface IFormVersion {
  formId: Types.ObjectId;
  version: number;
  title: string;
  description?: string;
  /** Embedded: fields are always read together with their version. */
  fields: Field[];
  publishedAt: Date;
}

const formVersionSchema = new Schema<IFormVersion>({
  formId: { type: Schema.Types.ObjectId, ref: "Form", required: true },
  version: { type: Number, required: true },
  title: { type: String, required: true },
  description: String,
  // Mixed holding an array: validated by Zod before the version is created.
  fields: { type: Schema.Types.Mixed, default: () => [] },
  publishedAt: { type: Date, default: () => new Date() },
});

formVersionSchema.index({ formId: 1, version: -1 }, { unique: true });

export const FormVersion = model<IFormVersion>(
  "FormVersion",
  formVersionSchema,
);

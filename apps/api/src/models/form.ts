import { Schema, model, Types } from "mongoose";
import type { Field } from "@fb/shared";

export type FormStatus = "draft" | "published" | "closed";

export interface IForm {
  ownerId: Types.ObjectId;
  slug: string;
  status: FormStatus;
  /** Working copy; copied into an immutable FormVersion on publish. */
  title: string;
  description?: string;
  draftFields: Field[];
  /** 0 = never published */
  publishedVersion: number;
  settings: {
    allowMultiple: boolean;
    closesAt?: Date | null;
    maxResponses?: number | null;
  };
  responseCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const formSchema = new Schema<IForm>(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    slug: { type: String, required: true, unique: true },
    status: {
      type: String,
      enum: ["draft", "published", "closed"],
      default: "draft",
    },
    title: { type: String, required: true },
    description: String,
    // Mixed holding an array: validated by Zod (formDefinitionSchema) before every write.
    draftFields: { type: Schema.Types.Mixed, default: () => [] },
    publishedVersion: { type: Number, default: 0 },
    settings: {
      allowMultiple: { type: Boolean, default: true },
      closesAt: { type: Date, default: null },
      maxResponses: { type: Number, default: null },
    },
    responseCount: { type: Number, default: 0 },
  },
  { timestamps: true, minimize: false },
);

formSchema.index({ ownerId: 1, updatedAt: -1 });

export const Form = model<IForm>("Form", formSchema);

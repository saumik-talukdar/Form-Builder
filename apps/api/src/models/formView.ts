import { Schema, model, Types } from "mongoose";

export interface IFormView {
  formId: Types.ObjectId;
  ipHash: string;
  createdAt: Date;
}

const formViewSchema = new Schema<IFormView>({
  formId: { type: Schema.Types.ObjectId, ref: "Form", required: true },
  ipHash: { type: String, required: true },
  createdAt: { type: Date, default: () => new Date() },
});

formViewSchema.index({ formId: 1, createdAt: -1 });
// Views are only needed for the funnel; expire after 90 days.
formViewSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 60 * 60 * 24 * 90 },
);

export const FormView = model<IFormView>("FormView", formViewSchema);

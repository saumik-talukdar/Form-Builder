import { isValidObjectId, Types } from "mongoose";
import { Form } from "../models/form";
import { notFound } from "./errors";

export function objectId(raw: string | undefined): Types.ObjectId {
  if (!raw || !isValidObjectId(raw)) throw notFound("Form not found");
  return new Types.ObjectId(raw);
}

/** Loads a form only if the signed-in user owns it; otherwise 404 (never reveals existence). */
export async function loadOwnedForm(
  id: string | undefined,
  userId: string | undefined,
) {
  const form = await Form.findOne({ _id: objectId(id), ownerId: userId });
  if (!form) throw notFound("Form not found");
  return form;
}

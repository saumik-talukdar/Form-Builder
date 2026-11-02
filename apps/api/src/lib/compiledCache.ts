import { compileForm, type CompiledForm } from "@fb/shared";
import type { Types } from "mongoose";
import { FormVersion } from "../models/formVersion";

/**
 * Published versions are immutable, so a compiled validator for
 * `formId:version` never goes stale. Small LRU keeps memory bounded.
 */
const MAX_ENTRIES = 500;
const cache = new Map<string, CompiledForm>();

export async function getCompiledForm(
  formId: Types.ObjectId,
  version: number,
): Promise<CompiledForm | null> {
  const key = `${formId.toString()}:${version}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // refresh recency
    cache.set(key, hit);
    return hit;
  }

  const doc = await FormVersion.findOne({ formId, version }).lean();
  if (!doc) return null;

  const compiled = compileForm(doc.fields);
  cache.set(key, compiled);
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return compiled;
}

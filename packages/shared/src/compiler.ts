import { z } from "zod";
import type { Condition, Field } from "./fields";

/**
 * Schema compiler: turns a list of field definitions into a validator for
 * answers submitted against that exact version of a form.
 *
 * compileForm() does the expensive work once (one Zod schema per field) so
 * the result can be cached per `formId:version`.
 */

export type AnswerError = { fieldId: string; message: string };
export type AnswerValue = string | number | string[];
export type Answers = Record<string, AnswerValue>;

export type ValidationResult =
  | { success: true; data: Answers }
  | { success: false; errors: AnswerError[] };

export interface CompiledForm {
  validate(raw: unknown): ValidationResult;
}

/** Empty-ish values count as "not answered". */
function isAbsent(v: unknown): boolean {
  return (
    v === undefined ||
    v === null ||
    (typeof v === "string" && v.trim() === "") ||
    (Array.isArray(v) && v.length === 0)
  );
}

function isValidIsoDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Builds the Zod schema for a single, present (non-empty) answer. */
function buildFieldSchema(field: Field): z.ZodTypeAny {
  switch (field.type) {
    case "short_text": {
      let s = z.string().trim();
      if (field.minLength !== undefined) s = s.min(field.minLength);
      s = s.max(field.maxLength ?? 500);
      if (field.pattern) {
        const re = new RegExp(field.pattern);
        return s.refine((v) => re.test(v), "Does not match the required format");
      }
      return s;
    }
    case "long_text": {
      let s = z.string().trim();
      if (field.minLength !== undefined) s = s.min(field.minLength);
      return s.max(field.maxLength ?? 10000);
    }
    case "number": {
      // Only override the type error: a plain string here would also replace the min/max/int messages.
      let n = z
        .number({ error: (iss) => (iss.code === "invalid_type" ? "Must be a number" : undefined) })
        .finite();
      if (field.integer) n = n.int("Must be a whole number");
      if (field.min !== undefined) n = n.min(field.min);
      if (field.max !== undefined) n = n.max(field.max);
      return n;
    }
    case "select": {
      const ids = new Set(field.options.map((o) => o.id));
      return z.string().refine((v) => ids.has(v), "Not a valid option");
    }
    case "multi_select": {
      const ids = new Set(field.options.map((o) => o.id));
      let a = z
        .array(z.string())
        .refine((arr) => arr.every((v) => ids.has(v)), "Contains an invalid option")
        .refine((arr) => new Set(arr).size === arr.length, "Duplicate selections");
      if (field.minSelected !== undefined) {
        const min = field.minSelected;
        a = a.refine((arr) => arr.length >= min, `Select at least ${min}`);
      }
      if (field.maxSelected !== undefined) {
        const max = field.maxSelected;
        a = a.refine((arr) => arr.length <= max, `Select at most ${max}`);
      }
      return a;
    }
    case "rating":
      return z.number().int().min(1).max(field.max);
    case "date": {
      const { min, max } = field;
      return z
        .string()
        .refine(isValidIsoDate, "Must be a valid date (YYYY-MM-DD)")
        .refine((v) => min === undefined || v >= min, `Must be on or after ${min}`)
        .refine((v) => max === undefined || v <= max, `Must be on or before ${max}`);
    }
  }
}

/** Evaluates a showIf condition against the raw (client-sent) answers. */
export function evaluateCondition(cond: Condition, answers: Record<string, unknown>): boolean {
  const actual = answers[cond.fieldId];
  switch (cond.op) {
    case "answered":
      return !isAbsent(actual);
    case "eq":
      return Array.isArray(actual)
        ? actual.includes(cond.value as string)
        : actual === cond.value;
    case "neq":
      return Array.isArray(actual)
        ? !actual.includes(cond.value as string)
        : actual !== cond.value;
    case "in":
      return (
        Array.isArray(cond.value) &&
        (Array.isArray(actual)
          ? actual.some((a) => (cond.value as unknown[]).includes(a))
          : (cond.value as unknown[]).includes(actual))
      );
    case "gt":
      return typeof actual === "number" && typeof cond.value === "number" && actual > cond.value;
    case "lt":
      return typeof actual === "number" && typeof cond.value === "number" && actual < cond.value;
  }
}

/**
 * Ids of the fields a respondent can currently see. A field whose showIf
 * depends on a hidden field is hidden too, so hiding cascades. The server and
 * the browser both use this, so what the form shows is what gets validated.
 */
export function visibleFieldIds(fields: Field[], input: Record<string, unknown>): Set<string> {
  const visible = new Set<string>();
  for (const f of fields) {
    if (!f.showIf || (visible.has(f.showIf.fieldId) && evaluateCondition(f.showIf, input))) {
      visible.add(f.id);
    }
  }
  return visible;
}

export function compileForm(fields: Field[]): CompiledForm {
  const compiled = fields.map((field) => ({ field, schema: buildFieldSchema(field) }));
  const knownIds = new Set(fields.map((f) => f.id));

  return {
    validate(raw: unknown): ValidationResult {
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { success: false, errors: [{ fieldId: "_root", message: "Answers must be an object" }] };
      }
      const input = raw as Record<string, unknown>;
      const errors: AnswerError[] = [];
      const data: Answers = {};

      for (const key of Object.keys(input)) {
        if (!knownIds.has(key)) errors.push({ fieldId: key, message: "Unknown field" });
      }

      // Visibility is decided from what the respondent sent, in field order.
      const visible = visibleFieldIds(fields, input);

      for (const { field, schema } of compiled) {
        if (!visible.has(field.id)) continue; // hidden fields are never required and their answers are dropped

        const value = input[field.id];
        if (isAbsent(value)) {
          if (field.required) errors.push({ fieldId: field.id, message: "This field is required" });
          continue;
        }

        const parsed = schema.safeParse(value);
        if (parsed.success) {
          data[field.id] = parsed.data as AnswerValue;
        } else {
          errors.push({
            fieldId: field.id,
            message: parsed.error.issues[0]?.message ?? "Invalid value",
          });
        }
      }

      return errors.length > 0 ? { success: false, errors } : { success: true, data };
    },
  };
}

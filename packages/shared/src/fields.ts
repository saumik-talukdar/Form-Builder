import { z } from "zod";

/**
 * Field definitions: the single source of truth for what a form looks like.
 * Types are derived with z.infer, so the API, Mongoose layer and React
 * builder all share the same shapes.
 */

export const FIELD_TYPES = [
  "short_text",
  "long_text",
  "number",
  "select",
  "multi_select",
  "rating",
  "date",
] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

const idSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, "Only letters, numbers, _ and - are allowed");

/** Show a field only when another (earlier) field's answer matches. */
export const conditionSchema = z.object({
  fieldId: idSchema,
  op: z.enum(["eq", "neq", "in", "gt", "lt", "answered"]),
  value: z.unknown().optional(),
});
export type Condition = z.infer<typeof conditionSchema>;

const optionSchema = z.object({
  id: idSchema,
  label: z.string().min(1).max(200),
});
export type FieldOption = z.infer<typeof optionSchema>;

const baseShape = {
  id: idSchema,
  label: z.string().min(1).max(300),
  description: z.string().max(1000).optional(),
  required: z.boolean().default(false),
  showIf: conditionSchema.optional(),
};

const shortText = z.object({
  ...baseShape,
  type: z.literal("short_text"),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).max(1000).optional(),
  pattern: z.string().max(200).optional(),
});

const longText = z.object({
  ...baseShape,
  type: z.literal("long_text"),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(1).max(10000).optional(),
});

const numberField = z.object({
  ...baseShape,
  type: z.literal("number"),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
});

const selectField = z.object({
  ...baseShape,
  type: z.literal("select"),
  options: z.array(optionSchema).min(1).max(100),
});

const multiSelectField = z.object({
  ...baseShape,
  type: z.literal("multi_select"),
  options: z.array(optionSchema).min(1).max(100),
  minSelected: z.number().int().min(0).optional(),
  maxSelected: z.number().int().min(1).optional(),
});

const ratingField = z.object({
  ...baseShape,
  type: z.literal("rating"),
  max: z.number().int().min(3).max(10).default(5),
});

const dateField = z.object({
  ...baseShape,
  type: z.literal("date"),
  /** ISO dates (YYYY-MM-DD) */
  min: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  max: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const fieldSchema = z.discriminatedUnion("type", [
  shortText,
  longText,
  numberField,
  selectField,
  multiSelectField,
  ratingField,
  dateField,
]);
export type Field = z.infer<typeof fieldSchema>;
export type FieldOf<T extends FieldType> = Extract<Field, { type: T }>;

export const MAX_FIELDS = 100;

/**
 * A form definition (title + ordered fields). Cross-field rules live in
 * superRefine because refinements can't sit on discriminated union members.
 */
export const formDefinitionSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    fields: z.array(fieldSchema).max(MAX_FIELDS),
  })
  .superRefine((def, ctx) => {
    const seen = new Map<string, number>();

    def.fields.forEach((field, index) => {
      const path = ["fields", index];

      if (seen.has(field.id)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "id"],
          message: `Duplicate field id "${field.id}"`,
        });
      }

      if ("options" in field) {
        const optionIds = new Set<string>();
        field.options.forEach((opt, oi) => {
          if (optionIds.has(opt.id)) {
            ctx.addIssue({
              code: "custom",
              path: [...path, "options", oi, "id"],
              message: `Duplicate option id "${opt.id}"`,
            });
          }
          optionIds.add(opt.id);
        });
      }

      if (field.type === "short_text" || field.type === "long_text") {
        if (
          field.minLength !== undefined &&
          field.maxLength !== undefined &&
          field.minLength > field.maxLength
        ) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "minLength"],
            message: "minLength cannot exceed maxLength",
          });
        }
      }
      if (field.type === "short_text" && field.pattern !== undefined) {
        try {
          new RegExp(field.pattern);
        } catch {
          ctx.addIssue({
            code: "custom",
            path: [...path, "pattern"],
            message: "pattern is not a valid regular expression",
          });
        }
      }
      if (
        field.type === "number" &&
        field.min !== undefined &&
        field.max !== undefined &&
        field.min > field.max
      ) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "min"],
          message: "min cannot exceed max",
        });
      }
      if (
        field.type === "date" &&
        field.min &&
        field.max &&
        field.min > field.max
      ) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "min"],
          message: "min cannot exceed max",
        });
      }
      if (field.type === "multi_select") {
        const { minSelected, maxSelected, options } = field;
        if (
          minSelected !== undefined &&
          maxSelected !== undefined &&
          minSelected > maxSelected
        ) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "minSelected"],
            message: "minSelected cannot exceed maxSelected",
          });
        }
        if (minSelected !== undefined && minSelected > options.length) {
          ctx.addIssue({
            code: "custom",
            path: [...path, "minSelected"],
            message: "minSelected exceeds the number of options",
          });
        }
      }

      // Conditions may only reference EARLIER fields: no forward refs, no cycles.
      if (field.showIf && !seen.has(field.showIf.fieldId)) {
        ctx.addIssue({
          code: "custom",
          path: [...path, "showIf", "fieldId"],
          message:
            "Its condition must depend on a question that comes before it. Move this question down, or change the condition",
        });
      }

      seen.set(field.id, index);
    });
  });

export type FormDefinition = z.infer<typeof formDefinitionSchema>;

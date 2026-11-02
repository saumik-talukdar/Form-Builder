import { describe, expect, it } from "vitest";
import { compileForm, evaluateCondition } from "./compiler";
import { formDefinitionSchema, fieldSchema, type Field } from "./fields";

const f = (raw: unknown): Field => fieldSchema.parse(raw);

const fields: Field[] = [
  f({
    id: "name",
    type: "short_text",
    label: "Name",
    required: true,
    maxLength: 20,
  }),
  f({
    id: "age",
    type: "number",
    label: "Age",
    min: 0,
    max: 120,
    integer: true,
  }),
  f({
    id: "color",
    type: "select",
    label: "Color",
    required: true,
    options: [
      { id: "red", label: "Red" },
      { id: "blue", label: "Blue" },
      { id: "other", label: "Other" },
    ],
  }),
  f({
    id: "other_text",
    type: "short_text",
    label: "Which?",
    required: true,
    showIf: { fieldId: "color", op: "eq", value: "other" },
  }),
  f({
    id: "tags",
    type: "multi_select",
    label: "Tags",
    minSelected: 1,
    maxSelected: 2,
    options: [
      { id: "a", label: "A" },
      { id: "b", label: "B" },
      { id: "c", label: "C" },
    ],
  }),
  f({ id: "score", type: "rating", label: "Score" }),
  f({
    id: "when",
    type: "date",
    label: "When",
    min: "2026-01-01",
    max: "2026-12-31",
  }),
];

const form = compileForm(fields);

describe("compileForm.validate", () => {
  it("accepts a valid submission and keeps only visible answers", () => {
    const res = form.validate({
      name: "  Ada ",
      age: 36,
      color: "red",
      other_text: "should be dropped (hidden)",
      tags: ["a", "c"],
      score: 4,
      when: "2026-06-15",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.name).toBe("Ada");
      expect(res.data).not.toHaveProperty("other_text");
    }
  });

  it("requires visible required fields", () => {
    const res = form.validate({});
    expect(res.success).toBe(false);
    if (!res.success) {
      const ids = res.errors.map((e) => e.fieldId);
      expect(ids).toContain("name");
      expect(ids).toContain("color");
      expect(ids).not.toContain("other_text"); // hidden, so not required
    }
  });

  it("requires a conditional field once its condition is met", () => {
    const res = form.validate({ name: "A", color: "other" });
    expect(res.success).toBe(false);
    if (!res.success)
      expect(res.errors.map((e) => e.fieldId)).toEqual(["other_text"]);
  });

  it("treats empty strings and empty arrays as unanswered", () => {
    const res = form.validate({ name: "A", color: "red", age: "", tags: [] });
    expect(res.success).toBe(true);
  });

  it("rejects unknown field ids", () => {
    const res = form.validate({ name: "A", color: "red", hacker: "x" });
    expect(res.success).toBe(false);
    if (!res.success)
      expect(res.errors[0]).toMatchObject({ fieldId: "hacker" });
  });

  it("gives specific messages for number problems", () => {
    const msg = (age: unknown) => {
      const r = form.validate({ name: "A", color: "red", age });
      return r.success ? null : r.errors[0]?.message;
    };
    expect(msg("abc")).toBe("Must be a number");
    expect(msg(121)).toMatch(/120/);
    expect(msg(-1)).toMatch(/0/);
    expect(msg(3.5)).toBe("Must be a whole number");
  });

  it("rejects wrong types and out-of-range numbers", () => {
    const res = form.validate({ name: "A", color: "red", age: "36" });
    expect(res.success).toBe(false);
    const res2 = form.validate({ name: "A", color: "red", age: 3.5 });
    expect(res2.success).toBe(false);
    const res3 = form.validate({ name: "A", color: "red", age: 121 });
    expect(res3.success).toBe(false);
  });

  it("rejects invalid options and bad multi-select counts", () => {
    expect(form.validate({ name: "A", color: "green" }).success).toBe(false);
    expect(
      form.validate({ name: "A", color: "red", tags: ["a", "b", "c"] }).success,
    ).toBe(false);
    expect(
      form.validate({ name: "A", color: "red", tags: ["a", "a"] }).success,
    ).toBe(false);
    expect(
      form.validate({ name: "A", color: "red", tags: ["zzz"] }).success,
    ).toBe(false);
  });

  it("validates ratings and dates", () => {
    expect(form.validate({ name: "A", color: "red", score: 6 }).success).toBe(
      false,
    );
    expect(form.validate({ name: "A", color: "red", score: 0 }).success).toBe(
      false,
    );
    expect(
      form.validate({ name: "A", color: "red", when: "2026-02-30" }).success,
    ).toBe(false);
    expect(
      form.validate({ name: "A", color: "red", when: "2025-12-31" }).success,
    ).toBe(false);
    expect(
      form.validate({ name: "A", color: "red", when: "2026-12-31" }).success,
    ).toBe(true);
  });

  it("enforces text max length", () => {
    expect(form.validate({ name: "x".repeat(21), color: "red" }).success).toBe(
      false,
    );
  });

  it("rejects non-object payloads", () => {
    expect(form.validate(null).success).toBe(false);
    expect(form.validate([]).success).toBe(false);
    expect(form.validate("hi").success).toBe(false);
  });

  it("cascades hiding: a field depending on a hidden field is hidden too", () => {
    const chain = compileForm([
      f({ id: "a", type: "short_text", label: "A" }),
      f({
        id: "b",
        type: "short_text",
        label: "B",
        showIf: { fieldId: "a", op: "answered" },
      }),
      f({
        id: "c",
        type: "short_text",
        label: "C",
        required: true,
        showIf: { fieldId: "b", op: "answered" },
      }),
    ]);
    // a is empty -> b hidden -> c hidden (even if the client sends a value for b)
    expect(chain.validate({ b: "sneaky" }).success).toBe(true);
    const res = chain.validate({ a: "x", b: "y" });
    expect(res.success).toBe(false);
  });

  it("supports a safe custom regex pattern", () => {
    const f2 = compileForm([
      f({ id: "zip", type: "short_text", label: "Zip", pattern: "^\\d{4}$" }),
    ]);
    expect(f2.validate({ zip: "4000" }).success).toBe(true);
    expect(f2.validate({ zip: "40a0" }).success).toBe(false);
  });
});

describe("evaluateCondition", () => {
  it("handles each operator", () => {
    expect(
      evaluateCondition({ fieldId: "x", op: "gt", value: 3 }, { x: 5 }),
    ).toBe(true);
    expect(
      evaluateCondition({ fieldId: "x", op: "lt", value: 3 }, { x: 5 }),
    ).toBe(false);
    expect(
      evaluateCondition(
        { fieldId: "x", op: "in", value: ["a", "b"] },
        { x: "b" },
      ),
    ).toBe(true);
    expect(
      evaluateCondition(
        { fieldId: "x", op: "eq", value: "a" },
        { x: ["a", "b"] },
      ),
    ).toBe(true);
    expect(
      evaluateCondition({ fieldId: "x", op: "neq", value: "a" }, { x: "b" }),
    ).toBe(true);
    expect(evaluateCondition({ fieldId: "x", op: "answered" }, {})).toBe(false);
  });
});

describe("formDefinitionSchema", () => {
  const base = { title: "Survey" };

  it("accepts a valid definition and applies defaults", () => {
    const def = formDefinitionSchema.parse({
      ...base,
      fields: [{ id: "q1", type: "rating", label: "Rate us" }],
    });
    const first = def.fields[0]!;
    expect(first.required).toBe(false);
    expect(first.type === "rating" && first.max).toBe(5);
  });

  it("rejects duplicate field ids and option ids", () => {
    const dup = formDefinitionSchema.safeParse({
      ...base,
      fields: [
        { id: "q", type: "short_text", label: "A" },
        { id: "q", type: "short_text", label: "B" },
      ],
    });
    expect(dup.success).toBe(false);

    const dupOpt = formDefinitionSchema.safeParse({
      ...base,
      fields: [
        {
          id: "s",
          type: "select",
          label: "S",
          options: [
            { id: "x", label: "1" },
            { id: "x", label: "2" },
          ],
        },
      ],
    });
    expect(dupOpt.success).toBe(false);
  });

  it("rejects forward and unknown showIf references", () => {
    const forward = formDefinitionSchema.safeParse({
      ...base,
      fields: [
        {
          id: "a",
          type: "short_text",
          label: "A",
          showIf: { fieldId: "b", op: "answered" },
        },
        { id: "b", type: "short_text", label: "B" },
      ],
    });
    expect(forward.success).toBe(false);
  });

  it("rejects invalid ranges and bad regex", () => {
    expect(
      formDefinitionSchema.safeParse({
        ...base,
        fields: [{ id: "n", type: "number", label: "N", min: 10, max: 1 }],
      }).success,
    ).toBe(false);
    expect(
      formDefinitionSchema.safeParse({
        ...base,
        fields: [{ id: "t", type: "short_text", label: "T", pattern: "(" }],
      }).success,
    ).toBe(false);
  });

  it("rejects unknown field types", () => {
    expect(
      formDefinitionSchema.safeParse({
        ...base,
        fields: [{ id: "t", type: "video", label: "T" }],
      }).success,
    ).toBe(false);
  });
});

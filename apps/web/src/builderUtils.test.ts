import { describe, expect, it } from "vitest";
import { fieldSchema, formDefinitionSchema, type Field } from "@fb/shared";
import {
  ADD_ORDER,
  duplicateField,
  fromLocalInput,
  moveField,
  newField,
  removeField,
  reorderField,
  toLocalInput,
} from "./builderUtils";

const f = (raw: unknown): Field => fieldSchema.parse(raw);

describe("newField", () => {
  it.each(ADD_ORDER)("creates a valid %s question", (type) => {
    const field = newField(type, []);
    expect(
      formDefinitionSchema.safeParse({ title: "T", fields: [field] }).success,
    ).toBe(true);
    expect(field.type).toBe(type);
  });

  it("never reuses an existing id", () => {
    const existing: Field[] = [];
    for (let i = 0; i < 50; i++)
      existing.push(newField("short_text", existing));
    expect(new Set(existing.map((x) => x.id)).size).toBe(50);
  });
});

describe("duplicateField", () => {
  it("gets fresh field and option ids and stays valid in the form", () => {
    const original = f({
      id: "q1",
      type: "select",
      label: "Colour",
      required: true,
      options: [
        { id: "red", label: "Red" },
        { id: "blue", label: "Blue" },
      ],
    });
    const copy = duplicateField(original, [original]);
    expect(copy.id).not.toBe(original.id);
    expect(copy.label).toBe("Colour (copy)");
    if (copy.type === "select" && original.type === "select") {
      expect(copy.options.map((o) => o.id)).not.toEqual(
        original.options.map((o) => o.id),
      );
      expect(copy.options.map((o) => o.label)).toEqual(["Red", "Blue"]);
    }
    expect(
      formDefinitionSchema.safeParse({ title: "T", fields: [original, copy] })
        .success,
    ).toBe(true);
  });
});

describe("removeField", () => {
  const fields = [
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
      showIf: { fieldId: "b", op: "answered" },
    }),
  ];

  it("clears conditions that pointed at the removed question so the form stays valid", () => {
    const next = removeField(fields, "a");
    expect(next.map((x) => x.id)).toEqual(["b", "c"]);
    expect(next[0]!.showIf).toBeUndefined();
    expect(next[1]!.showIf?.fieldId).toBe("b"); // unrelated condition untouched
    expect(
      formDefinitionSchema.safeParse({ title: "T", fields: next }).success,
    ).toBe(true);
  });
});

describe("reorderField", () => {
  const list = ["a", "b", "c", "d"].map(
    (id) => ({ id, type: "short_text", label: id, required: false }) as Field,
  );
  const ids = (fs: Field[]) => fs.map((f) => f.id).join("");

  it("moves an item forwards and backwards", () => {
    expect(ids(reorderField(list, 0, 2))).toBe("bcad");
    expect(ids(reorderField(list, 3, 1))).toBe("adbc");
    expect(ids(reorderField(list, 1, 0))).toBe("bacd");
  });
  it("returns the same array for no-ops and out-of-range indexes, and never mutates", () => {
    for (const [from, to] of [
      [1, 1],
      [-1, 2],
      [0, 4],
      [4, 0],
      [0, -1],
    ] as const)
      expect(reorderField(list, from, to)).toBe(list);
    reorderField(list, 0, 3);
    expect(ids(list)).toBe("abcd");
  });
});

describe("moveField", () => {
  const fields = ["a", "b", "c"].map((id) =>
    f({ id, type: "short_text", label: id }),
  );
  const ids = (x: Field[]) => x.map((y) => y.id).join("");

  it("swaps neighbours and ignores moves off either end", () => {
    expect(ids(moveField(fields, 1, -1))).toBe("bac");
    expect(ids(moveField(fields, 1, 1))).toBe("acb");
    expect(moveField(fields, 0, -1)).toBe(fields);
    expect(moveField(fields, 2, 1)).toBe(fields);
  });

  it("does not mutate its input", () => {
    moveField(fields, 0, 1);
    expect(ids(fields)).toBe("abc");
  });

  it("lets the form validator catch a condition moved above its source", () => {
    const withCond = [
      f({ id: "a", type: "short_text", label: "A" }),
      f({
        id: "b",
        type: "short_text",
        label: "B",
        showIf: { fieldId: "a", op: "answered" },
      }),
    ];
    const moved = moveField(withCond, 1, -1);
    const res = formDefinitionSchema.safeParse({ title: "T", fields: moved });
    expect(res.success).toBe(false);
  });
});

describe("local date-time helpers", () => {
  it("round-trips an instant through the datetime-local format", () => {
    const iso = "2026-12-31T10:30:00.000Z";
    expect(fromLocalInput(toLocalInput(iso))).toBe(iso);
  });

  it("handles empty and invalid input", () => {
    expect(toLocalInput(null)).toBe("");
    expect(toLocalInput("nonsense")).toBe("");
    expect(fromLocalInput("")).toBeNull();
    expect(fromLocalInput("nonsense")).toBeNull();
  });
});

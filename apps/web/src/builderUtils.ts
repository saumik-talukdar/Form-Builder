import type { Field, FieldType } from "@fb/shared";

export const TYPE_LABEL: Record<FieldType, string> = {
  short_text: "Short answer",
  long_text: "Long answer",
  number: "Number",
  select: "Choose one",
  multi_select: "Choose many",
  rating: "Rating",
  date: "Date",
};

export const ADD_ORDER: FieldType[] = [
  "short_text",
  "long_text",
  "select",
  "multi_select",
  "rating",
  "number",
  "date",
];

export function uid(prefix: string, taken: Set<string> = new Set()): string {
  let id: string;
  do {
    id = `${prefix}_${Math.random().toString(36).slice(2, 8)}`;
  } while (taken.has(id));
  return id;
}

export const idsOf = (fields: Field[]) => new Set(fields.map((f) => f.id));

export function newField(type: FieldType, fields: Field[]): Field {
  const taken = idsOf(fields);
  const base = {
    id: uid("q", taken),
    label: "Untitled question",
    required: false,
  };
  switch (type) {
    case "select":
    case "multi_select":
      return {
        ...base,
        type,
        options: [
          { id: uid("o"), label: "Option 1" },
          { id: uid("o"), label: "Option 2" },
        ],
      };
    case "rating":
      return { ...base, type, max: 5 };
    default:
      return { ...base, type };
  }
}

export function duplicateField(field: Field, fields: Field[]): Field {
  const copy = structuredClone(field) as Field;
  copy.id = uid("q", idsOf(fields));
  copy.label = `${field.label} (copy)`;
  if ("options" in copy)
    copy.options = copy.options.map((o) => ({ ...o, id: uid("o") }));
  return copy;
}

/** Removes a field and any condition that pointed at it. */
export function removeField(fields: Field[], id: string): Field[] {
  return fields
    .filter((f) => f.id !== id)
    .map((f) =>
      f.showIf?.fieldId === id ? ({ ...f, showIf: undefined } as Field) : f,
    );
}

/** Moves the field at `from` so it ends up at index `to`. Out-of-range or no-op moves return the same array. */
export function reorderField(
  fields: Field[],
  from: number,
  to: number,
): Field[] {
  if (
    from === to ||
    from < 0 ||
    to < 0 ||
    from >= fields.length ||
    to >= fields.length
  )
    return fields;
  const next = fields.slice();
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

export const moveField = (
  fields: Field[],
  index: number,
  dir: -1 | 1,
): Field[] => reorderField(fields, index, index + dir);

export function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

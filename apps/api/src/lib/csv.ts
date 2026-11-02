import type { Field } from "@fb/shared";

/**
 * CSV helpers for response export.
 * - RFC 4180 quoting
 * - formula-injection guard: text cells starting with = + - @ tab or CR get a
 *   leading apostrophe so Excel/Sheets don't evaluate respondent input
 */

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);

  let s =
    value instanceof Date
      ? value.toISOString()
      : Array.isArray(value)
        ? value.join("; ")
        : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const csvLine = (cells: unknown[]) =>
  cells.map(csvCell).join(",") + "\r\n";

const META_COLUMNS = [
  "device",
  "browser",
  "os",
  "country",
  "language",
  "referrer",
  "duration_ms",
] as const;

export function csvHeader(fields: Field[]): string {
  return csvLine([
    "response_id",
    "submitted_at",
    "version",
    ...fields.map((f) => f.label),
    ...META_COLUMNS,
  ]);
}

interface ExportDoc {
  _id: unknown;
  submittedAt: Date;
  version: number;
  answers: Record<string, unknown>;
  meta: {
    device?: string;
    browser?: string;
    os?: string;
    country?: string;
    language?: string;
    referrer?: string;
    durationMs?: number;
  };
}

/** Returns a row builder; select options are exported by label, not id. */
export function makeCsvRow(fields: Field[]) {
  const labels = new Map<string, Map<string, string>>();
  for (const f of fields) {
    if (f.type === "select" || f.type === "multi_select") {
      labels.set(f.id, new Map(f.options.map((o) => [o.id, o.label])));
    }
  }

  return (doc: ExportDoc): string => {
    const answerCells = fields.map((f) => {
      const v = doc.answers[f.id];
      const map = labels.get(f.id);
      if (!map || v === undefined) return v;
      return Array.isArray(v)
        ? v.map((x) => map.get(String(x)) ?? x)
        : (map.get(String(v)) ?? v);
    });
    const m = doc.meta ?? {};
    return csvLine([
      String(doc._id),
      doc.submittedAt,
      doc.version,
      ...answerCells,
      m.device,
      m.browser,
      m.os,
      m.country,
      m.language,
      m.referrer,
      m.durationMs,
    ]);
  };
}

import { describe, expect, it } from "vitest";
import { fieldSchema, type Field } from "@fb/shared";
import { csvCell, csvHeader, makeCsvRow } from "./csv";

describe("csvCell", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("neutralises spreadsheet formulas in text", () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(
      `"'=HYPERLINK(""http://evil"")"`,
    );
    expect(csvCell("+1+1")).toBe("'+1+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("-2+3")).toBe("'-2+3");
  });

  it("does not mangle real numbers, including negatives", () => {
    expect(csvCell(-5)).toBe("-5");
    expect(csvCell(0)).toBe("0");
  });

  it("handles empty values, arrays and dates", () => {
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(null)).toBe("");
    expect(csvCell(["a", "b"])).toBe("a; b");
    expect(csvCell(new Date("2026-10-01T00:00:00Z"))).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });
});

describe("export rows", () => {
  const fields: Field[] = [
    fieldSchema.parse({
      id: "c",
      type: "select",
      label: "Color",
      options: [{ id: "r", label: "Red, dark" }],
    }),
    fieldSchema.parse({
      id: "t",
      type: "multi_select",
      label: "Tags",
      options: [
        { id: "a", label: "A" },
        { id: "b", label: "B" },
      ],
    }),
    fieldSchema.parse({ id: "n", type: "short_text", label: "Name" }),
  ];

  it("writes a header with labels and meta columns", () => {
    expect(csvHeader(fields)).toBe(
      "response_id,submitted_at,version,Color,Tags,Name,device,browser,os,country,language,referrer,duration_ms\r\n",
    );
  });

  it("exports option labels, joins multi-selects and guards injection", () => {
    const row = makeCsvRow(fields)({
      _id: "abc",
      submittedAt: new Date("2026-10-01T00:00:00Z"),
      version: 2,
      answers: { c: "r", t: ["a", "b"], n: "=cmd" },
      meta: { device: "mobile", durationMs: 4200 },
    });
    expect(row).toBe(
      'abc,2026-10-01T00:00:00.000Z,2,"Red, dark",A; B,\'=cmd,mobile,,,,,,4200\r\n',
    );
  });

  it("leaves unanswered columns blank", () => {
    const row = makeCsvRow(fields)({
      _id: "x",
      submittedAt: new Date(0),
      version: 1,
      answers: {},
      meta: {},
    });
    expect(row).toBe("x,1970-01-01T00:00:00.000Z,1,,,,,,,,,,\r\n");
  });
});

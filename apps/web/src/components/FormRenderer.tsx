import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  compileForm,
  visibleFieldIds,
  type AnswerError,
  type Field,
} from "@fb/shared";

type Answers = Record<string, unknown>;

export interface RenderSubmitMeta {
  startedAt: number;
  /** Honeypot value; real people leave it empty. */
  website: string;
}

interface Props {
  fields: Field[];
  /** Omit for a preview: the form is fully interactive but nothing is sent. */
  onSubmit?: (
    answers: Record<string, unknown>,
    meta: RenderSubmitMeta,
  ) => Promise<void> | void;
  submitLabel?: string;
  /** Per-field errors returned by the server (422), shown next to the field. */
  serverErrors?: AnswerError[];
}

/** Number inputs hold raw text while typing; convert to numbers before validating. */
function normalize(fields: Field[], answers: Answers): Answers {
  const out: Answers = { ...answers };
  for (const f of fields) {
    if (f.type !== "number") continue;
    const v = out[f.id];
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v);
      out[f.id] = Number.isNaN(n) ? v : n;
    }
  }
  return out;
}

const SELECT_AS_RADIOS_MAX = 7;
const qid = (id: string) => `q-${id}`;

export function FormRenderer({
  fields,
  onSubmit,
  submitLabel = "Submit",
  serverErrors,
}: Props) {
  const compiled = useMemo(() => compileForm(fields), [fields]);
  const [answers, setAnswers] = useState<Answers>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [website, setWebsite] = useState("");
  const [busy, setBusy] = useState(false);
  const startedAt = useRef(Date.now());
  const formRef = useRef<HTMLFormElement>(null);

  const visible = useMemo(
    () => visibleFieldIds(fields, normalize(fields, answers)),
    [fields, answers],
  );

  useEffect(() => {
    if (serverErrors && serverErrors.length > 0) {
      setErrors(
        Object.fromEntries(serverErrors.map((e) => [e.fieldId, e.message])),
      );
    }
  }, [serverErrors]);

  function focusField(id: string) {
    formRef.current
      ?.querySelector<HTMLElement>(
        `[data-field="${id}"] :is(input, textarea, select)`,
      )
      ?.focus();
  }

  function setValue(id: string, value: unknown) {
    const next = { ...answers, [id]: value };
    setAnswers(next);
    // Once a field has an error, re-check it as the person fixes it.
    if (errors[id]) {
      const result = compiled.validate(normalize(fields, next));
      const still = result.success
        ? undefined
        : result.errors.find((e) => e.fieldId === id);
      setErrors((prev) => {
        const copy = { ...prev };
        if (still) copy[id] = still.message;
        else delete copy[id];
        return copy;
      });
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const result = compiled.validate(normalize(fields, answers));
    if (!result.success) {
      setErrors(
        Object.fromEntries(result.errors.map((er) => [er.fieldId, er.message])),
      );
      const first = fields.find((f) =>
        result.errors.some((er) => er.fieldId === f.id),
      );
      if (first) focusField(first.id);
      return;
    }
    setErrors({});
    if (!onSubmit) return;
    setBusy(true);
    try {
      await onSubmit(result.data, { startedAt: startedAt.current, website });
    } finally {
      setBusy(false);
    }
  }

  let number = 0;
  const shown = fields.filter((f) => visible.has(f.id));
  const errorCount = shown.filter((f) => errors[f.id]).length;

  return (
    <form ref={formRef} onSubmit={handleSubmit} noValidate>
      <div className="questions">
        {shown.map((field) => {
          number += 1;
          const error = errors[field.id];
          const errId = `${qid(field.id)}-err`;
          const descId = `${qid(field.id)}-desc`;
          const describedBy =
            [field.description ? descId : "", error ? errId : ""]
              .filter(Boolean)
              .join(" ") || undefined;
          const isGroup =
            field.type === "select" ||
            field.type === "multi_select" ||
            field.type === "rating";
          const Label = isGroup ? "legend" : "label";
          const Wrapper = isGroup ? "fieldset" : "div";

          return (
            <Wrapper key={field.id} className="question" data-field={field.id}>
              <span className="q-num" aria-hidden="true">
                {number}.
              </span>
              <div className="q-body">
                <Label
                  className="q-label"
                  {...(isGroup ? {} : { htmlFor: qid(field.id) })}
                >
                  {field.label}
                  {!field.required && (
                    <span className="q-required">optional</span>
                  )}
                </Label>
                {field.description && (
                  <p className="q-desc" id={descId}>
                    {field.description}
                  </p>
                )}
                <Control
                  field={field}
                  value={answers[field.id]}
                  invalid={Boolean(error)}
                  describedBy={describedBy}
                  onChange={(v) => setValue(field.id, v)}
                />
                {error && (
                  <p className="q-error" id={errId} role="alert">
                    {error}
                  </p>
                )}
              </div>
            </Wrapper>
          );
        })}
      </div>

      <div className="hp" aria-hidden="true">
        <label>
          Leave this field empty
          <input
            type="text"
            name="website"
            tabIndex={-1}
            autoComplete="off"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
          />
        </label>
      </div>

      <div className="submit-row">
        <button type="submit" className="btn mark" disabled={busy}>
          {busy ? "Sending…" : submitLabel}
        </button>
        {errorCount > 0 && (
          <p className="q-error" role="status">
            {errorCount === 1
              ? "1 answer needs attention."
              : `${errorCount} answers need attention.`}
          </p>
        )}
      </div>
    </form>
  );
}

interface ControlProps {
  field: Field;
  value: unknown;
  invalid: boolean;
  describedBy?: string;
  onChange: (value: unknown) => void;
}

function Control({
  field,
  value,
  invalid,
  describedBy,
  onChange,
}: ControlProps) {
  const common = {
    id: qid(field.id),
    className: "input",
    "aria-invalid": invalid || undefined,
    "aria-describedby": describedBy,
    "aria-required": field.required || undefined,
  } as const;

  switch (field.type) {
    case "short_text":
      return (
        <div className="q-control">
          <input
            {...common}
            type="text"
            maxLength={field.maxLength}
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "long_text":
      return (
        <div className="q-control">
          <textarea
            {...common}
            maxLength={field.maxLength}
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "number":
      return (
        <div className="q-control" style={{ maxWidth: 240 }}>
          <input
            {...common}
            type="number"
            inputMode={field.integer ? "numeric" : "decimal"}
            step={field.integer ? 1 : "any"}
            min={field.min}
            max={field.max}
            value={(value as string | number | undefined) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "date":
      return (
        <div className="q-control" style={{ maxWidth: 240 }}>
          <input
            {...common}
            type="date"
            min={field.min}
            max={field.max}
            value={(value as string) ?? ""}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      );
    case "select": {
      if (field.options.length > SELECT_AS_RADIOS_MAX) {
        return (
          <div className="q-control">
            <select
              {...common}
              value={(value as string) ?? ""}
              onChange={(e) => onChange(e.target.value)}
            >
              <option value="">Choose one</option>
              {field.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        );
      }
      return (
        <div className="choices" aria-describedby={describedBy}>
          {field.options.map((o) => (
            <label className="choice" key={o.id}>
              <input
                type="radio"
                name={qid(field.id)}
                checked={value === o.id}
                onChange={() => onChange(o.id)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    }
    case "multi_select": {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      const toggle = (id: string) =>
        onChange(
          selected.includes(id)
            ? selected.filter((x) => x !== id)
            : [...selected, id],
        );
      return (
        <div className="choices" aria-describedby={describedBy}>
          {field.options.map((o) => (
            <label className="choice" key={o.id}>
              <input
                type="checkbox"
                checked={selected.includes(o.id)}
                onChange={() => toggle(o.id)}
              />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      );
    }
    case "rating":
      return (
        <div className="scale" aria-describedby={describedBy}>
          {Array.from({ length: field.max }, (_, i) => i + 1).map((n) => (
            <label key={n}>
              <input
                type="radio"
                name={qid(field.id)}
                checked={value === n}
                onChange={() => onChange(n)}
              />
              <span>{n}</span>
            </label>
          ))}
        </div>
      );
  }
}

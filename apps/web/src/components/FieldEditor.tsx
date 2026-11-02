import { useId, type ReactNode } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Condition, Field } from "@fb/shared";
import { TYPE_LABEL, uid } from "../builderUtils";

interface Props {
  field: Field;
  index: number;
  total: number;
  /** Fields before this one: the only ones a condition may depend on. */
  earlier: Field[];
  open: boolean;
  onToggle: () => void;
  onChange: (next: Field) => void;
  onMove: (dir: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function FieldEditor({
  field,
  index,
  total,
  earlier,
  open,
  onToggle,
  onChange,
  onMove,
  onDuplicate,
  onDelete,
}: Props) {
  const panelId = useId();
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: field.id });
  return (
    <li
      ref={setNodeRef}
      className={`${open ? "bfield open" : "bfield"}${isDragging ? " dragging" : ""}`}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <div className="bfield-head">
        <button
          type="button"
          ref={setActivatorNodeRef}
          className="btn quiet icon drag-handle"
          aria-label={`Drag to reorder question ${index + 1}`}
          {...attributes}
          {...listeners}
        >
          ⠿
        </button>
        <button
          type="button"
          className="bfield-toggle"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={onToggle}
        >
          <span className="q-num">{index + 1}.</span>
          <span className="bfield-label">
            {field.label || "Untitled question"}
          </span>
          <span className="bfield-type muted small">
            {TYPE_LABEL[field.type]}
            {field.required ? ", required" : ""}
            {field.showIf ? ", conditional" : ""}
          </span>
        </button>
        <div className="bfield-tools">
          <button
            type="button"
            className="btn quiet icon"
            aria-label={`Move question ${index + 1} up`}
            disabled={index === 0}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="btn quiet icon"
            aria-label={`Move question ${index + 1} down`}
            disabled={index === total - 1}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
        </div>
      </div>

      {open && (
        <div className="bfield-panel" id={panelId}>
          <Labeled label="Question">
            {(id) => (
              <input
                id={id}
                className="input"
                value={field.label}
                maxLength={300}
                onChange={(e) => onChange({ ...field, label: e.target.value })}
              />
            )}
          </Labeled>
          <Labeled label="Help text (optional)">
            {(id) => (
              <input
                id={id}
                className="input"
                value={field.description ?? ""}
                maxLength={1000}
                onChange={(e) =>
                  onChange({
                    ...field,
                    description: e.target.value || undefined,
                  })
                }
              />
            )}
          </Labeled>

          <label className="check">
            <input
              type="checkbox"
              checked={field.required}
              onChange={(e) =>
                onChange({ ...field, required: e.target.checked })
              }
            />
            <span>Required</span>
          </label>

          <TypeSettings field={field} onChange={onChange} />
          <ConditionEditor
            field={field}
            earlier={earlier}
            onChange={onChange}
          />

          <div className="bfield-actions">
            <button type="button" className="btn small" onClick={onDuplicate}>
              Duplicate
            </button>
            <button
              type="button"
              className="btn small danger"
              onClick={onDelete}
            >
              Delete question
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function Labeled({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className="setting">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  min?: number;
  max?: number;
}) {
  return (
    <Labeled label={label}>
      {(id) => (
        <input
          id={id}
          className="input"
          type="number"
          min={min}
          max={max}
          value={value ?? ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? undefined : Number(e.target.value))
          }
        />
      )}
    </Labeled>
  );
}

function TypeSettings({
  field,
  onChange,
}: {
  field: Field;
  onChange: (f: Field) => void;
}) {
  switch (field.type) {
    case "short_text":
      return (
        <div className="setting-grid">
          <NumberInput
            label="Longest answer (characters)"
            value={field.maxLength}
            min={1}
            max={1000}
            onChange={(n) => onChange({ ...field, maxLength: n })}
          />
          <Labeled
            label="Required format"
            hint="A regular expression, for example ^\d{4}$ for four digits."
          >
            {(id) => (
              <input
                id={id}
                className="input"
                value={field.pattern ?? ""}
                maxLength={200}
                onChange={(e) =>
                  onChange({ ...field, pattern: e.target.value || undefined })
                }
              />
            )}
          </Labeled>
        </div>
      );
    case "long_text":
      return (
        <div className="setting-grid">
          <NumberInput
            label="Longest answer (characters)"
            value={field.maxLength}
            min={1}
            max={10000}
            onChange={(n) => onChange({ ...field, maxLength: n })}
          />
        </div>
      );
    case "number":
      return (
        <div className="setting-grid">
          <NumberInput
            label="Smallest allowed"
            value={field.min}
            onChange={(n) => onChange({ ...field, min: n })}
          />
          <NumberInput
            label="Largest allowed"
            value={field.max}
            onChange={(n) => onChange({ ...field, max: n })}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={field.integer ?? false}
              onChange={(e) =>
                onChange({ ...field, integer: e.target.checked || undefined })
              }
            />
            <span>Whole numbers only</span>
          </label>
        </div>
      );
    case "date":
      return (
        <div className="setting-grid">
          <Labeled label="Earliest date">
            {(id) => (
              <input
                id={id}
                className="input"
                type="date"
                value={field.min ?? ""}
                onChange={(e) =>
                  onChange({ ...field, min: e.target.value || undefined })
                }
              />
            )}
          </Labeled>
          <Labeled label="Latest date">
            {(id) => (
              <input
                id={id}
                className="input"
                type="date"
                value={field.max ?? ""}
                onChange={(e) =>
                  onChange({ ...field, max: e.target.value || undefined })
                }
              />
            )}
          </Labeled>
        </div>
      );
    case "rating":
      return (
        <Labeled label="Scale">
          {(id) => (
            <select
              id={id}
              className="input"
              value={field.max}
              onChange={(e) =>
                onChange({ ...field, max: Number(e.target.value) })
              }
            >
              {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
                <option key={n} value={n}>
                  1 to {n}
                </option>
              ))}
            </select>
          )}
        </Labeled>
      );
    case "select":
    case "multi_select":
      return (
        <>
          <OptionsEditor field={field} onChange={onChange} />
          {field.type === "multi_select" && (
            <div className="setting-grid">
              <NumberInput
                label="Choose at least"
                value={field.minSelected}
                min={0}
                onChange={(n) => onChange({ ...field, minSelected: n })}
              />
              <NumberInput
                label="Choose at most"
                value={field.maxSelected}
                min={1}
                onChange={(n) => onChange({ ...field, maxSelected: n })}
              />
            </div>
          )}
        </>
      );
  }
}

function OptionsEditor({
  field,
  onChange,
}: {
  field: Extract<Field, { options: unknown }>;
  onChange: (f: Field) => void;
}) {
  const setOptions = (options: typeof field.options) =>
    onChange({ ...field, options });
  return (
    <div className="setting">
      <p className="field-label" id={`${field.id}-opts`}>
        Choices
      </p>
      <ul className="options" aria-labelledby={`${field.id}-opts`}>
        {field.options.map((o, i) => (
          <li key={o.id}>
            <input
              className="input"
              aria-label={`Choice ${i + 1}`}
              value={o.label}
              maxLength={200}
              onChange={(e) =>
                setOptions(
                  field.options.map((x) =>
                    x.id === o.id ? { ...x, label: e.target.value } : x,
                  ),
                )
              }
            />
            <button
              type="button"
              className="btn quiet icon"
              aria-label={`Remove choice ${i + 1}`}
              disabled={field.options.length <= 1}
              onClick={() =>
                setOptions(field.options.filter((x) => x.id !== o.id))
              }
            >
              ×
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="btn small"
        disabled={field.options.length >= 100}
        onClick={() =>
          setOptions([
            ...field.options,
            {
              id: uid("o", new Set(field.options.map((o) => o.id))),
              label: `Option ${field.options.length + 1}`,
            },
          ])
        }
      >
        Add a choice
      </button>
    </div>
  );
}

const OP_LABEL: Record<Condition["op"], string> = {
  eq: "is",
  neq: "is not",
  in: "is one of",
  gt: "is more than",
  lt: "is less than",
  answered: "has an answer",
};

function opsFor(source: Field): Condition["op"][] {
  switch (source.type) {
    case "select":
    case "multi_select":
      return ["eq", "neq", "answered"];
    case "number":
    case "rating":
      return ["eq", "neq", "gt", "lt", "answered"];
    default:
      return ["answered", "eq", "neq"];
  }
}

function defaultCondition(source: Field): Condition {
  if (source.type === "select" || source.type === "multi_select")
    return { fieldId: source.id, op: "eq", value: source.options[0]?.id };
  if (source.type === "rating")
    return { fieldId: source.id, op: "gt", value: Math.ceil(source.max / 2) };
  return { fieldId: source.id, op: "answered" };
}

function ConditionEditor({
  field,
  earlier,
  onChange,
}: {
  field: Field;
  earlier: Field[];
  onChange: (f: Field) => void;
}) {
  const cond = field.showIf;
  const set = (showIf: Condition | undefined) =>
    onChange({ ...field, showIf } as Field);
  const source = cond ? earlier.find((f) => f.id === cond.fieldId) : undefined;

  if (earlier.length === 0) {
    return (
      <p className="hint">
        Conditions become available once there's a question before this one.
      </p>
    );
  }

  return (
    <fieldset className="condition">
      <legend className="field-label">When to show this question</legend>
      <label className="check">
        <input
          type="radio"
          name={`${field.id}-when`}
          checked={!cond}
          onChange={() => set(undefined)}
        />
        <span>Always</span>
      </label>
      <label className="check">
        <input
          type="radio"
          name={`${field.id}-when`}
          checked={Boolean(cond)}
          onChange={() => set(defaultCondition(earlier[0]!))}
        />
        <span>Only when an earlier answer matches</span>
      </label>

      {cond && (
        <div className="condition-row">
          <select
            className="input"
            aria-label="Earlier question"
            value={cond.fieldId}
            onChange={(e) => {
              const next = earlier.find((f) => f.id === e.target.value);
              if (next) set(defaultCondition(next));
            }}
          >
            {earlier.map((f, i) => (
              <option key={f.id} value={f.id}>
                {i + 1}. {f.label || "Untitled question"}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label="Comparison"
            value={cond.op}
            onChange={(e) =>
              set({ ...cond, op: e.target.value as Condition["op"] })
            }
          >
            {(source ? opsFor(source) : (["answered"] as const)).map((op) => (
              <option key={op} value={op}>
                {OP_LABEL[op]}
              </option>
            ))}
          </select>
          {cond.op !== "answered" && source && (
            <ConditionValue
              source={source}
              cond={cond}
              onChange={(value) => set({ ...cond, value })}
            />
          )}
        </div>
      )}
    </fieldset>
  );
}

function ConditionValue({
  source,
  cond,
  onChange,
}: {
  source: Field;
  cond: Condition;
  onChange: (v: unknown) => void;
}) {
  if (source.type === "select" || source.type === "multi_select") {
    return (
      <select
        className="input"
        aria-label="Value"
        value={String(cond.value ?? "")}
        onChange={(e) => onChange(e.target.value)}
      >
        {source.options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (source.type === "rating") {
    return (
      <select
        className="input"
        aria-label="Value"
        value={String(cond.value ?? "")}
        onChange={(e) => onChange(Number(e.target.value))}
      >
        {Array.from({ length: source.max }, (_, i) => i + 1).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
    );
  }
  if (source.type === "number") {
    return (
      <input
        className="input"
        type="number"
        aria-label="Value"
        value={typeof cond.value === "number" ? cond.value : ""}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : Number(e.target.value))
        }
      />
    );
  }
  return (
    <input
      className="input"
      aria-label="Value"
      value={String(cond.value ?? "")}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

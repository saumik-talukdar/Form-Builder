import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { Link, useNavigate, useParams } from "react-router-dom";
import { formDefinitionSchema, type Field, type FieldType } from "@fb/shared";
import { ApiError, api, describeError } from "../api";
import { AutoTextarea } from "../components/AutoTextarea";
import { FieldEditor } from "../components/FieldEditor";
import { FormRenderer } from "../components/FormRenderer";
import {
  ADD_ORDER,
  TYPE_LABEL,
  duplicateField,
  fromLocalInput,
  moveField,
  newField,
  removeField,
  reorderField,
  toLocalInput,
} from "../builderUtils";
import type { FormDetail, FormSettings } from "../types";

interface Draft {
  title: string;
  description: string;
  fields: Field[];
  settings: FormSettings;
}

const toDraft = (f: FormDetail): Draft => ({
  title: f.title,
  description: f.description ?? "",
  fields: f.fields ?? [],
  settings: f.settings,
});

/** Turns schema issues into one sentence a person can act on. */
function firstProblem(draft: Draft): string | null {
  const result = formDefinitionSchema.safeParse({
    title: draft.title,
    description: draft.description || undefined,
    fields: draft.fields,
  });
  if (result.success) return null;
  const issue = result.error.issues[0]!;
  const [head, index] = issue.path;
  if (head === "fields" && typeof index === "number")
    return `Question ${index + 1}: ${issue.message}`;
  if (head === "title") return "Give the form a title.";
  return issue.message;
}

export function BuilderPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [form, setForm] = useState<FormDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [busy, setBusy] = useState<"save" | "publish" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<FormDetail>(`/forms/${id}`)
      .then((f) => {
        setForm(f);
        const d = toDraft(f);
        setDraft(d);
        setSaved(JSON.stringify(d));
      })
      .catch((e) =>
        setLoadError(
          e instanceof ApiError && e.status === 404
            ? "This form doesn't exist, or it belongs to another account."
            : describeError(e),
        ),
      );
  }, [id]);

  const dirty = draft !== null && JSON.stringify(draft) !== saved;

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  // Pointer drags need a small movement first so clicking the handle doesn't start one; the keyboard works too.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );
  function onDragEnd(e: DragEndEvent) {
    if (!draft || !e.over || e.active.id === e.over.id) return;
    const from = draft.fields.findIndex((f) => f.id === e.active.id);
    const to = draft.fields.findIndex((f) => f.id === e.over!.id);
    update({ fields: reorderField(draft.fields, from, to) });
  }

  const update = useCallback((patch: Partial<Draft>) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    setNotice(null);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return false;
    const problem = firstProblem(draft);
    if (problem) {
      setError(problem);
      return false;
    }
    setError(null);
    try {
      const updated = await api.patch<FormDetail>(`/forms/${id}`, {
        title: draft.title,
        description: draft.description || null,
        fields: draft.fields,
        settings: draft.settings,
      });
      setForm(updated);
      const d = toDraft(updated);
      setDraft(d);
      setSaved(JSON.stringify(d));
      return true;
    } catch (e) {
      setError(describeError(e));
      return false;
    }
  }, [draft, id]);

  async function onSave() {
    setBusy("save");
    setNotice(null);
    if (await save()) setNotice("Draft saved.");
    setBusy(null);
  }

  async function onPublish() {
    setBusy("publish");
    setNotice(null);
    try {
      if (dirty && !(await save())) return;
      const updated = await api.post<FormDetail>(`/forms/${id}/publish`);
      setForm((prev) =>
        prev ? { ...prev, ...updated, fields: prev.fields } : prev,
      );
      setNotice(
        `Published as version ${updated.publishedVersion}. The link is live.`,
      );
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 409 &&
        /No changes/i.test(e.message)
      ) {
        setNotice(`${e.message}. The published form is already up to date.`);
      } else {
        setError(describeError(e));
      }
    } finally {
      setBusy(null);
    }
  }

  async function onClose() {
    try {
      const updated = await api.post<FormDetail>(`/forms/${id}/close`);
      setForm((prev) =>
        prev ? { ...prev, ...updated, fields: prev.fields } : prev,
      );
      setNotice("Closed. New responses are blocked until you publish again.");
    } catch (e) {
      setError(describeError(e));
    }
  }

  async function onDelete() {
    if (
      !window.confirm(
        "Delete this form and all of its responses? This can't be undone.",
      )
    )
      return;
    try {
      await api.delete(`/forms/${id}`);
      navigate("/", { replace: true });
    } catch (e) {
      setError(describeError(e));
    }
  }

  const shareUrl = useMemo(
    () => (form ? `${window.location.origin}/f/${form.slug}` : ""),
    [form],
  );

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Couldn't copy automatically. Select the link and copy it.");
    }
  }

  if (loadError)
    return (
      <main className="container narrow">
        <p className="banner error" role="alert">
          {loadError}
        </p>
        <p style={{ marginTop: 16 }}>
          <Link to="/">Back to your forms</Link>
        </p>
      </main>
    );
  if (!form || !draft)
    return <main className="container narrow muted">Loading…</main>;

  const live = form.status === "published";
  const setField = (index: number, next: Field) =>
    update({ fields: draft.fields.map((f, i) => (i === index ? next : f)) });

  function addField(type: FieldType) {
    const field = newField(type, draft!.fields);
    update({ fields: [...draft!.fields, field] });
    setOpenId(field.id);
  }

  return (
    <main className="container narrow">
      <div className="actionbar">
        <div className="actionbar-left">
          <span className={live ? "chip live" : "chip"}>
            {live ? "Published" : form.status === "closed" ? "Closed" : "Draft"}
          </span>
          {dirty ? (
            <span className="muted small">Unsaved changes</span>
          ) : (
            form.publishedVersion > 0 && (
              <span className="muted small">
                Version {form.publishedVersion}
              </span>
            )
          )}
        </div>
        <div className="actionbar-right">
          <div className="seg" role="group" aria-label="View">
            <button
              type="button"
              className="btn small"
              aria-pressed={mode === "edit"}
              onClick={() => setMode("edit")}
            >
              Edit
            </button>
            <button
              type="button"
              className="btn small"
              aria-pressed={mode === "preview"}
              onClick={() => setMode("preview")}
            >
              Preview
            </button>
          </div>
          <Link className="btn small" to={`/forms/${form.id}/results`}>
            Results
          </Link>
          <button
            className="btn small"
            onClick={() => void onSave()}
            disabled={busy !== null || !dirty}
          >
            {busy === "save" ? "Saving…" : "Save draft"}
          </button>
          <button
            className="btn small mark"
            onClick={() => void onPublish()}
            disabled={busy !== null || draft.fields.length === 0}
          >
            {busy === "publish"
              ? "Publishing…"
              : live
                ? "Publish changes"
                : form.status === "closed"
                  ? "Reopen"
                  : "Publish"}
          </button>
        </div>
      </div>

      {error && (
        <p className="banner error" role="alert" style={{ marginBottom: 12 }}>
          {error}
        </p>
      )}
      {notice && (
        <p className="banner ok" role="status" style={{ marginBottom: 12 }}>
          {notice}
        </p>
      )}

      {form.publishedVersion > 0 && (
        <div className="share">
          <label className="field-label" htmlFor="share-url">
            Link for respondents
          </label>
          <div className="share-row">
            <input
              id="share-url"
              className="input"
              readOnly
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button className="btn small" onClick={() => void copyLink()}>
              {copied ? "Copied" : "Copy link"}
            </button>
            {live && (
              <button className="btn small" onClick={() => void onClose()}>
                Close form
              </button>
            )}
          </div>
          {!live && form.status === "closed" && (
            <p className="hint">
              This form is closed, so the link shows a closed message.
            </p>
          )}
          {dirty && live && (
            <p className="hint">
              The live form keeps its current version until you publish your
              changes.
            </p>
          )}
        </div>
      )}

      <article className="sheet">
        {mode === "preview" ? (
          <>
            <h1 className="sheet-title">{draft.title || "Untitled form"}</h1>
            {draft.description && (
              <p className="sheet-desc">{draft.description}</p>
            )}
            <p className="banner mark" style={{ marginTop: 16 }}>
              Preview only. Nothing you enter here is sent.
            </p>
            {draft.fields.length === 0 ? (
              <p className="muted" style={{ marginTop: 24 }}>
                Add a question to see it here.
              </p>
            ) : (
              <FormRenderer
                key={JSON.stringify(draft.fields)}
                fields={draft.fields}
                submitLabel="Submit (preview)"
              />
            )}
          </>
        ) : (
          <>
            <label className="sr-only" htmlFor="form-title">
              Form title
            </label>
            <AutoTextarea
              id="form-title"
              className="title-input"
              placeholder="Form title"
              value={draft.title}
              maxLength={200}
              onChange={(e) =>
                update({ title: e.target.value.replace(/\n/g, " ") })
              }
              onKeyDown={(e) => e.key === "Enter" && e.preventDefault()}
            />
            <label className="sr-only" htmlFor="form-desc">
              Description
            </label>
            <AutoTextarea
              id="form-desc"
              className="desc-input"
              placeholder="Say what this form is for (optional)"
              value={draft.description}
              maxLength={2000}
              onChange={(e) => update({ description: e.target.value })}
            />

            {draft.fields.length === 0 ? (
              <div className="empty-fields">
                <p>No questions yet. Add the first one below.</p>
              </div>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
              >
                <SortableContext
                  items={draft.fields.map((f) => f.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ol className="bfields">
                    {draft.fields.map((field, i) => (
                      <FieldEditor
                        key={field.id}
                        field={field}
                        index={i}
                        total={draft.fields.length}
                        earlier={draft.fields.slice(0, i)}
                        open={openId === field.id}
                        onToggle={() =>
                          setOpenId(openId === field.id ? null : field.id)
                        }
                        onChange={(next) => setField(i, next)}
                        onMove={(dir) =>
                          update({ fields: moveField(draft.fields, i, dir) })
                        }
                        onDuplicate={() => {
                          const copy = duplicateField(field, draft.fields);
                          const fields = draft.fields.slice();
                          fields.splice(i + 1, 0, copy);
                          update({ fields });
                          setOpenId(copy.id);
                        }}
                        onDelete={() => {
                          update({
                            fields: removeField(draft.fields, field.id),
                          });
                          setOpenId(null);
                        }}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            )}

            <div className="palette">
              <p className="field-label" id="add-label">
                Add a question
              </p>
              <div
                className="palette-row"
                role="group"
                aria-labelledby="add-label"
              >
                {ADD_ORDER.map((t) => (
                  <button
                    key={t}
                    type="button"
                    className="btn small"
                    onClick={() => addField(t)}
                    disabled={draft.fields.length >= 100}
                  >
                    {TYPE_LABEL[t]}
                  </button>
                ))}
              </div>
            </div>

            <details className="settings">
              <summary>Form settings</summary>
              <div className="settings-body">
                <label className="check">
                  <input
                    type="checkbox"
                    checked={draft.settings.allowMultiple}
                    onChange={(e) =>
                      update({
                        settings: {
                          ...draft.settings,
                          allowMultiple: e.target.checked,
                        },
                      })
                    }
                  />
                  <span>Let the same person respond more than once</span>
                </label>
                {!draft.settings.allowMultiple && (
                  <p className="hint">
                    Repeats are detected with a browser cookie and network
                    address. It stops casual repeats, not determined ones.
                  </p>
                )}
                <div className="setting-grid">
                  <div className="setting">
                    <label className="field-label" htmlFor="closes">
                      Stop accepting responses at
                    </label>
                    <input
                      id="closes"
                      className="input"
                      type="datetime-local"
                      value={toLocalInput(draft.settings.closesAt)}
                      onChange={(e) =>
                        update({
                          settings: {
                            ...draft.settings,
                            closesAt: fromLocalInput(e.target.value),
                          },
                        })
                      }
                    />
                  </div>
                  <div className="setting">
                    <label className="field-label" htmlFor="max">
                      Maximum responses
                    </label>
                    <input
                      id="max"
                      className="input"
                      type="number"
                      min={1}
                      placeholder="No limit"
                      value={draft.settings.maxResponses ?? ""}
                      onChange={(e) =>
                        update({
                          settings: {
                            ...draft.settings,
                            maxResponses:
                              e.target.value === ""
                                ? null
                                : Number(e.target.value),
                          },
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            </details>
          </>
        )}
      </article>

      <p style={{ marginTop: 24 }}>
        <button className="btn small danger" onClick={() => void onDelete()}>
          Delete form
        </button>
      </p>
    </main>
  );
}

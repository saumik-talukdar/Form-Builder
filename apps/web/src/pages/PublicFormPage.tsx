import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import type { AnswerError } from "@fb/shared";
import { ApiError, api, describeError } from "../api";
import {
  FormRenderer,
  type RenderSubmitMeta,
} from "../components/FormRenderer";
import type { PublicForm } from "../types";

type Load =
  | { state: "loading" }
  | { state: "ready"; form: PublicForm }
  | { state: "missing" }
  | { state: "closed" }
  | { state: "error"; message: string };

export function PublicFormPage() {
  const { slug } = useParams<{ slug: string }>();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [done, setDone] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<AnswerError[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoad({ state: "loading" });
    api
      .get<PublicForm>(`/public/forms/${slug}`)
      .then((form) => !cancelled && setLoad({ state: "ready", form }))
      .catch((e) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 404)
          setLoad({ state: "missing" });
        else if (e instanceof ApiError && e.status === 410)
          setLoad({ state: "closed" });
        else setLoad({ state: "error", message: describeError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  useEffect(() => {
    if (load.state === "ready") document.title = load.form.title;
  }, [load]);

  async function submit(
    answers: Record<string, unknown>,
    meta: RenderSubmitMeta,
  ) {
    if (load.state !== "ready") return;
    setBanner(null);
    setServerErrors([]);
    try {
      await api.post(`/public/forms/${slug}/responses`, {
        answers,
        version: load.form.version,
        startedAt: meta.startedAt,
        referrer: document.referrer || undefined,
        website: meta.website || undefined,
      });
      setDone(true);
      window.scrollTo({ top: 0 });
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status === 422 &&
        Array.isArray(e.details)
      ) {
        setServerErrors(e.details as AnswerError[]);
        setBanner("Some answers need another look. They're marked below.");
      } else if (
        e instanceof ApiError &&
        e.status === 409 &&
        /updated/i.test(e.message)
      ) {
        setBanner(
          "The owner changed this form while you were filling it in. Reload the page to see the latest questions.",
        );
      } else if (e instanceof ApiError && e.status === 410) {
        setLoad({ state: "closed" });
      } else {
        setBanner(describeError(e));
      }
    }
  }

  if (load.state === "loading")
    return (
      <Frame>
        <p className="muted">Loading…</p>
      </Frame>
    );

  if (load.state === "missing")
    return (
      <Frame>
        <div className="thanks">
          <h1>This form isn't here</h1>
          <p className="muted">
            The link may be mistyped, or the owner hasn't published it yet.
          </p>
        </div>
      </Frame>
    );

  if (load.state === "closed")
    return (
      <Frame>
        <div className="thanks">
          <h1>This form is closed</h1>
          <p className="muted">
            It's no longer accepting responses. If you think that's a mistake,
            contact whoever sent you the link.
          </p>
        </div>
      </Frame>
    );

  if (load.state === "error")
    return (
      <Frame>
        <p className="banner error" role="alert">
          {load.message}
        </p>
      </Frame>
    );

  const { form } = load;

  if (done)
    return (
      <Frame>
        <div className="thanks">
          <h1>Thanks, your answers are in</h1>
          <p className="muted">You can close this page.</p>
        </div>
      </Frame>
    );

  return (
    <Frame>
      <article className="sheet">
        <h1 className="sheet-title">{form.title}</h1>
        {form.description && <p className="sheet-desc">{form.description}</p>}
        {banner && (
          <p className="banner error" role="alert" style={{ marginTop: 20 }}>
            {banner}
          </p>
        )}
        <FormRenderer
          fields={form.fields}
          onSubmit={submit}
          serverErrors={serverErrors}
        />
      </article>
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <main className="public-wrap">
      {children}
      <p className="public-foot">Made with Tallymark</p>
    </main>
  );
}

import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, describeError } from "../api";
import type { FormSummary } from "../types";

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

export function FormsPage() {
  const navigate = useNavigate();
  const [forms, setForms] = useState<FormSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api
      .get<FormSummary[]>("/forms")
      .then(setForms)
      .catch((e) => setError(describeError(e)));
  }, []);

  async function create() {
    setCreating(true);
    setError(null);
    try {
      const form = await api.post<FormSummary>("/forms", {
        title: "Untitled form",
        fields: [],
      });
      navigate(`/forms/${form.id}`);
    } catch (e) {
      setError(describeError(e));
      setCreating(false);
    }
  }

  return (
    <main className="container">
      <div className="page-head">
        <h1>Your forms</h1>
        {forms && forms.length > 0 && (
          <button
            className="btn primary"
            onClick={() => void create()}
            disabled={creating}
          >
            New form
          </button>
        )}
      </div>

      {error && (
        <p className="banner error" role="alert">
          {error}
        </p>
      )}

      {forms === null && !error && <p className="muted">Loading…</p>}

      {forms && forms.length === 0 && (
        <div className="empty">
          <h2>Make your first form</h2>
          <p className="muted">
            Add a few questions, publish, and share the link. People answer
            without signing up, and you see the results as they arrive.
          </p>
          <button
            className="btn mark"
            onClick={() => void create()}
            disabled={creating}
          >
            Create a form
          </button>
        </div>
      )}

      {forms && forms.length > 0 && (
        <ul className="rows">
          {forms.map((f) => (
            <li className="row" key={f.id}>
              <div>
                <Link className="row-title" to={`/forms/${f.id}`}>
                  {f.title}
                </Link>
                <div className="row-meta">
                  <span
                    className={f.status === "published" ? "chip live" : "chip"}
                  >
                    {f.status === "published"
                      ? "Published"
                      : f.status === "closed"
                        ? "Closed"
                        : "Draft"}
                  </span>
                  <span>
                    {f.responseCount}{" "}
                    {f.responseCount === 1 ? "response" : "responses"}
                  </span>
                  <span>Edited {dateFmt.format(new Date(f.updatedAt))}</span>
                </div>
              </div>
              <div className="row-actions">
                <Link className="btn small" to={`/forms/${f.id}`}>
                  Edit
                </Link>
                <Link className="btn small" to={`/forms/${f.id}/results`}>
                  Results
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

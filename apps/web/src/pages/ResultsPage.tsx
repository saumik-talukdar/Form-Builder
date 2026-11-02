import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { io } from "socket.io-client";
import { ApiError, api, describeError, refreshSession } from "../api";
import { TallyMarks } from "../components/TallyMarks";

import {
  BarList,
  Timeline,
  fmtDuration,
  fmtNum,
  fmtPct,
  type BarItem,
} from "../components/charts";

import type {
  Analytics,
  FormDetail,
  LiveEvent,
  QuestionStat,
  ResponseRow,
} from "../types";

type Range = "7" | "30" | "90" | "all";
const RANGE_LABEL: Record<Range, string> = {
  "7": "Last 7 days",
  "30": "Last 30 days",
  "90": "Last 90 days",
  all: "All time",
};
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const when = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

interface VersionRow {
  version: number;
  title: string;
}

interface ResponsePage {
  items: ResponseRow[];
  nextCursor: string | null;
}

export function ResultsPage() {
  const { id } = useParams<{ id: string }>();

  const [form, setForm] = useState<FormDetail | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [version, setVersion] = useState<number | null>(null);
  const [range, setRange] = useState<Range>("30");
  const [data, setData] = useState<Analytics | null>(null);
  const [rows, setRows] = useState<ResponseRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [liveCount, setLiveCount] = useState<number | null>(null);
  const [pulse, setPulse] = useState(0);
  const [connected, setConnected] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Form + versions, once.
  useEffect(() => {
    api
      .get<FormDetail>(`/forms/${id}`)
      .then((f) => {
        setForm(f);
        setLiveCount(f.responseCount);
      })
      .catch((e) =>
        setLoadError(
          e instanceof ApiError && e.status === 404
            ? "This form doesn't exist, or it belongs to another account."
            : describeError(e),
        ),
      );
    api
      .get<VersionRow[]>(`/forms/${id}/versions`)
      .then(setVersions)
      .catch(() => setVersions([]));
  }, [id]);

  // Analytics + newest responses whenever the view changes or a live response arrives.
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ timezone, interval: "day" });
    if (range !== "all") {
      // Round to the hour so repeated loads send the same query and can be served from the server cache.
      const hour = 3_600_000;
      params.set(
        "from",
        new Date(
          Math.floor((Date.now() - Number(range) * 86_400_000) / hour) * hour,
        ).toISOString(),
      );
    }
    if (version) params.set("version", String(version));

    Promise.all([
      api.get<Analytics>(`/forms/${id}/analytics?${params}`),
      api.get<ResponsePage>(`/forms/${id}/responses?limit=25`),
    ])
      .then(([a, r]) => {
        if (cancelled) return;
        setData(a);
        setRows(r.items);
        setCursor(r.nextCursor);
        setError(null);
      })
      .catch((e) => !cancelled && setError(describeError(e)));
    return () => {
      cancelled = true;
    };
  }, [id, range, version, refreshKey]);

  // Live updates: subscribe to this form's room; refresh (debounced to 5s, matching the server cache) when a response lands.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!id) return;
    const socket = io({ withCredentials: true });
    socket.on("connect", () => {
      socket.emit("subscribe", id, (res: { ok: boolean }) =>
        setConnected(res.ok),
      );
    });
    socket.on("disconnect", () => setConnected(false));
    socket.on("connect_error", () => {
      setConnected(false);
      // The handshake uses the short-lived access cookie; renew it, then let the socket retry.
      void refreshSession();
    });
    socket.on("response:new", (ev: LiveEvent) => {
      setLiveCount((c) => Math.max(c ?? 0, ev.count));
      setPulse((p) => p + 1);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setRefreshKey((k) => k + 1), 5000);
    });
    return () => {
      clearTimeout(timer.current);
      socket.close();
    };
  }, [id]);

  const loadMore = useCallback(async () => {
    if (!cursor) return;
    try {
      const page = await api.get<ResponsePage>(
        `/forms/${id}/responses?limit=25&cursor=${encodeURIComponent(cursor)}`,
      );
      setRows((r) => [...r, ...page.items]);
      setCursor(page.nextCursor);
    } catch (e) {
      setError(describeError(e));
    }
  }, [cursor, id]);

  const labels = useMemo(() => {
    const byField = new Map<string, QuestionStat>();
    data?.questions.items.forEach((q) => byField.set(q.fieldId, q));
    return byField;
  }, [data]);

  if (loadError)
    return (
      <main className="container">
        <p className="banner error" role="alert">
          {loadError}
        </p>
        <p style={{ marginTop: 16 }}>
          <Link to="/">Back to your forms</Link>
        </p>
      </main>
    );
  if (!form) return <main className="container muted">Loading…</main>;

  const total = liveCount ?? form.responseCount;
  const exportHref = `/api/forms/${form.id}/export.csv${version ? `?version=${version}` : ""}`;
  const published = form.status === "published";

  return (
    <main className="container">
      <div className="dash-head">
        <div>
          <h1>{form.title}</h1>
          <p className="muted">
            <Link to={`/forms/${form.id}`}>Edit form</Link>
          </p>
        </div>
        <div className="dash-actions">
          <a className="btn" href={exportHref} download>
            Download CSV
          </a>
        </div>
      </div>

      {error && (
        <p className="banner error" role="alert" style={{ margin: "12px 0" }}>
          {error}
        </p>
      )}

      <section className="counter" aria-label="Total responses">
        <div>
          <div className="counter-number" aria-live="polite">
            {fmtNum(total)}
          </div>
          <div className="counter-label">
            {total === 1 ? "response so far" : "responses so far"}
          </div>
          <div className="live-note">
            <span className={connected ? "dot on" : "dot"} aria-hidden="true" />
            {connected
              ? "Live: new responses appear as they arrive"
              : published
                ? "Reconnecting to live updates…"
                : "Live updates start once the form is published"}
          </div>
        </div>
        <TallyMarks count={total} pulse={pulse} />
      </section>

      <div className="range">
        <label className="field-label" htmlFor="range" style={{ margin: 0 }}>
          Show
        </label>
        <select
          id="range"
          className="input"
          value={range}
          onChange={(e) => setRange(e.target.value as Range)}
        >
          {(Object.keys(RANGE_LABEL) as Range[]).map((r) => (
            <option key={r} value={r}>
              {RANGE_LABEL[r]}
            </option>
          ))}
        </select>
        {versions.length > 1 && (
          <>
            <label
              className="field-label"
              htmlFor="version"
              style={{ margin: "0 0 0 8px" }}
            >
              Question stats for
            </label>
            <select
              id="version"
              className="input"
              value={version ?? ""}
              onChange={(e) =>
                setVersion(e.target.value ? Number(e.target.value) : null)
              }
            >
              <option value="">Current version</option>
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  Version {v.version}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      {!data && !error && (
        <p className="muted" style={{ marginTop: 24 }}>
          Loading results…
        </p>
      )}

      {data && (
        <>
          <div className="stats" style={{ marginTop: 16 }}>
            <Stat
              value={fmtNum(data.summary.totalResponses)}
              label={`Responses, ${RANGE_LABEL[range].toLowerCase()}`}
            />
            <Stat
              value={fmtNum(data.summary.uniqueRespondents)}
              label="Distinct people (by network address)"
            />
            <Stat
              value={fmtDuration(data.summary.medianDurationMs)}
              label="Median time to finish"
            />
            <Stat
              value={fmtPct(data.funnel.conversionRate)}
              label="Of views became responses"
            />
          </div>

          {data.summary.totalResponses === 0 ? (
            <div className="empty">
              <h2>
                {total === 0
                  ? "No responses yet"
                  : "No responses in this period"}
              </h2>
              <p className="muted">
                {total === 0
                  ? published
                    ? "Share the link and answers will show up here as they arrive."
                    : "Publish the form and share the link. Answers show up here as they arrive."
                  : "Try a longer time range to see earlier responses."}
              </p>
              {total === 0 && (
                <Link className="btn mark" to={`/forms/${form.id}`}>
                  {published ? "Get the link" : "Go to the form"}
                </Link>
              )}
            </div>
          ) : (
            <>
              <section className="dash-section">
                <h2>Responses over time</h2>
                <p className="sub">
                  One bar per day, in your time zone ({timezone}).
                </p>
                <Timeline data={data.overTime} />
              </section>

              <section className="dash-section">
                <h2>Who answered, and from where</h2>
                <p className="sub">
                  Read from request headers. Network addresses are never stored,
                  only a keyed hash.
                </p>
                <div className="cols">
                  <Breakdown title="Device" items={data.breakdowns.device} />
                  <Breakdown title="Browser" items={data.breakdowns.browser} />
                  <Breakdown
                    title="Operating system"
                    items={data.breakdowns.os}
                  />
                  <Breakdown title="Country" items={data.breakdowns.country} />
                  <Breakdown
                    title="Came from"
                    items={data.breakdowns.referrer}
                  />
                  <Breakdown
                    title="Language"
                    items={data.breakdowns.language}
                  />
                </div>
              </section>

              <section className="dash-section">
                <h2>From view to response</h2>
                <p className="sub">
                  Covers{" "}
                  {Math.max(
                    1,
                    Math.round(
                      (new Date(data.funnel.windowTo).getTime() -
                        new Date(data.funnel.windowFrom).getTime()) /
                        86_400_000,
                    ),
                  )}{" "}
                  days. Views are kept for {data.funnel.viewsRetentionDays}{" "}
                  days.
                </p>
                <div className="funnel">
                  <BarList
                    plain
                    items={[
                      {
                        key: "views",
                        label: "Opened the form",
                        count: data.funnel.views,
                      },
                      {
                        key: "unique",
                        label: "Different visitors",
                        count: data.funnel.uniqueViews,
                      },
                      {
                        key: "subs",
                        label: "Sent a response",
                        count: data.funnel.submissions,
                      },
                    ]}
                  />
                </div>
              </section>

              <section className="dash-section">
                <h2>Answers by question</h2>
                <p className="sub">
                  {data.questions.totalResponses}{" "}
                  {data.questions.totalResponses === 1
                    ? "response"
                    : "responses"}{" "}
                  to version {data.questions.version ?? "–"}.
                </p>
                {data.questions.items.map((q, i) => (
                  <Question
                    key={q.fieldId}
                    q={q}
                    index={i}
                    total={data.questions.totalResponses}
                  />
                ))}
              </section>

              <section className="dash-section">
                <h2>Latest responses</h2>
                <div className="table-wrap" style={{ marginTop: 12 }}>
                  <table className="responses">
                    <thead>
                      <tr>
                        <th scope="col">Received</th>
                        <th scope="col">From</th>
                        <th scope="col">Answers</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>{when.format(new Date(r.submittedAt))}</td>
                          <td>
                            {[r.meta.device, r.meta.browser, r.meta.country]
                              .filter(Boolean)
                              .join(", ") || "–"}
                          </td>
                          <td>
                            <AnswerSummary
                              answers={r.answers}
                              labels={labels}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {cursor && (
                  <p style={{ marginTop: 16 }}>
                    <button className="btn" onClick={() => void loadMore()}>
                      Show older responses
                    </button>
                  </p>
                )}
              </section>
            </>
          )}
        </>
      )}
    </main>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

/** "https://www.facebook.com" reads better as "facebook.com"; other values pass through. */
function prettyKey(key: string): string {
  if (!/^https?:\/\//.test(key)) return key;
  try {
    return new URL(key).host.replace(/^www\./, "");
  } catch {
    return key;
  }
}

function Breakdown({
  title,
  items,
}: {
  title: string;
  items: { key: string; count: number }[];
}) {
  if (items.length === 0) return null;
  return (
    <div className="breakdown">
      <h3>{title}</h3>
      <BarList
        items={items.map((i) => ({
          key: i.key,
          label: prettyKey(i.key),
          count: i.count,
        }))}
      />
    </div>
  );
}

function Question({
  q,
  index,
  total,
}: {
  q: QuestionStat;
  index: number;
  total: number;
}) {
  return (
    <div className="question-stat">
      <h3>
        {index + 1}. {q.label}
      </h3>
      <p className="meta">
        {q.answered} of {total} answered ({fmtPct(q.answerRate)})
      </p>
      <QuestionBody q={q} />
    </div>
  );
}

function QuestionBody({ q }: { q: QuestionStat }) {
  if (q.answered === 0) return <p className="muted small">No answers yet.</p>;

  switch (q.type) {
    case "select":
    case "multi_select":
      return (
        <BarList
          markLeader
          total={q.answered}
          items={(q.options ?? []).map((o) => ({
            key: o.id,
            label: o.label,
            count: o.count,
          }))}
        />
      );
    case "rating":
      return (
        <>
          <p className="big-inline">{q.average ?? "–"} average</p>
          <BarList
            markLeader
            total={q.answered}
            items={(q.distribution ?? []).map((d) => ({
              key: String(d.value),
              label: String(d.value),
              count: d.count,
            }))}
          />
        </>
      );
    case "number":
      return (
        <>
          <p className="big-inline">
            {q.avg} average{" "}
            <span className="muted small">
              between {q.min} and {q.max}
            </span>
          </p>
          <BarList
            plain
            items={(q.histogram ?? []).map((h, i) => ({
              key: String(i),
              label: h.min === h.max ? String(h.min) : `${h.min} to ${h.max}`,
              count: h.count,
            }))}
          />
        </>
      );
    case "date":
      return (
        <BarList
          plain
          items={(q.byMonth ?? []).map((m) => ({
            key: m.month,
            label: m.month,
            count: m.count,
          }))}
        />
      );
    case "short_text":
      return (
        <BarList
          plain
          items={(q.topValues ?? []).map((v) => ({
            key: v.value,
            label: v.value,
            count: v.count,
          }))}
        />
      );
    case "long_text":
      return (
        <p className="muted small">Long answers are in the CSV download.</p>
      );
  }
}

function AnswerSummary({
  answers,
  labels,
}: {
  answers: Record<string, unknown>;
  labels: Map<string, QuestionStat>;
}) {
  const entries = Object.entries(answers);
  if (entries.length === 0) return <span className="muted">–</span>;
  return (
    <>
      {entries.map(([fieldId, value]) => {
        const q = labels.get(fieldId);
        const optionLabel = (v: unknown) =>
          q?.options?.find((o) => o.id === v)?.label ?? String(v);
        const text = Array.isArray(value)
          ? value.map(optionLabel).join(", ")
          : q?.options
            ? optionLabel(value)
            : String(value);
        return (
          <div key={fieldId}>
            <span className="muted">{q?.label ?? fieldId}: </span>
            {text}
          </div>
        );
      })}
    </>
  );
}

export type { BarItem };

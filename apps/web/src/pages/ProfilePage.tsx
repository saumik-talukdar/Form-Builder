import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, describeError } from "../api";
import { useAuth, type User } from "../auth";

interface SessionRow {
  id: string;
  current: boolean;
  userAgent: string;
  createdAt: string;
  lastUsedAt: string;
}

/** "Chrome on Windows" from a raw user-agent string, good enough for a device list. */
export function describeDevice(ua: string): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\//.test(ua)
      ? "Opera"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Chrome\//.test(ua)
          ? "Chrome"
          : /Safari\//.test(ua)
            ? "Safari"
            : "Browser";
  const os = /Windows/.test(ua)
    ? "Windows"
    : /Android/.test(ua)
      ? "Android"
      : /iPhone|iPad|iOS/.test(ua)
        ? "iOS"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /Linux/.test(ua)
            ? "Linux"
            : "";
  return os ? `${browser} on ${os}` : browser;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

type Notice = { kind: "ok" | "error"; text: string } | null;

function Banner({ notice }: { notice: Notice }) {
  if (!notice) return null;
  return (
    <p
      className={`banner ${notice.kind}`}
      role={notice.kind === "error" ? "alert" : "status"}
    >
      {notice.text}
    </p>
  );
}

export function ProfilePage() {
  const { user, setUser, logout } = useAuth();
  const navigate = useNavigate();

  const [sessions, setSessions] = useState<SessionRow[] | null>(null);
  const [sessionsNotice, setSessionsNotice] = useState<Notice>(null);

  const loadSessions = useCallback(async () => {
    try {
      setSessions(await api.get<SessionRow[]>("/auth/sessions"));
    } catch (err) {
      setSessionsNotice({ kind: "error", text: describeError(err) });
    }
  }, []);
  useEffect(() => void loadSessions(), [loadSessions]);

  // Email
  const [email, setEmail] = useState(user?.email ?? "");
  const [emailPw, setEmailPw] = useState("");
  const [emailNotice, setEmailNotice] = useState<Notice>(null);
  async function saveEmail(e: FormEvent) {
    e.preventDefault();
    setEmailNotice(null);
    try {
      setUser(
        await api.patch<User>("/auth/me", { email, currentPassword: emailPw }),
      );
      setEmailPw("");
      setEmailNotice({ kind: "ok", text: "Email updated." });
    } catch (err) {
      setEmailNotice({ kind: "error", text: describeError(err) });
    }
  }

  // Password
  const [curPw, setCurPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [pwNotice, setPwNotice] = useState<Notice>(null);
  async function savePassword(e: FormEvent) {
    e.preventDefault();
    setPwNotice(null);
    try {
      const r = await api.post<{ signedOutElsewhere: number }>(
        "/auth/password",
        { currentPassword: curPw, newPassword: newPw },
      );
      setCurPw("");
      setNewPw("");
      setPwNotice({
        kind: "ok",
        text:
          r.signedOutElsewhere > 0
            ? `Password changed. ${r.signedOutElsewhere} other device${r.signedOutElsewhere === 1 ? "" : "s"} signed out.`
            : "Password changed.",
      });
      void loadSessions();
    } catch (err) {
      setPwNotice({ kind: "error", text: describeError(err) });
    }
  }

  // Devices
  async function endSession(s: SessionRow) {
    setSessionsNotice(null);
    try {
      await api.delete(`/auth/sessions/${s.id}`);
      await loadSessions();
    } catch (err) {
      setSessionsNotice({ kind: "error", text: describeError(err) });
    }
  }
  async function endOthers() {
    setSessionsNotice(null);
    try {
      const r = await api.post<{ revoked: number }>(
        "/auth/sessions/revoke-others",
      );
      setSessionsNotice({
        kind: "ok",
        text: `Signed out ${r.revoked} other device${r.revoked === 1 ? "" : "s"}.`,
      });
      await loadSessions();
    } catch (err) {
      setSessionsNotice({ kind: "error", text: describeError(err) });
    }
  }

  // Delete account
  const [delPw, setDelPw] = useState("");
  const [delConfirm, setDelConfirm] = useState("");
  const [delNotice, setDelNotice] = useState<Notice>(null);
  async function deleteAccount(e: FormEvent) {
    e.preventDefault();
    setDelNotice(null);
    try {
      await api.delete("/auth/me", { password: delPw });
      await logout().catch(() => undefined); // the cookies are already gone; this just clears local state
      navigate("/login", { replace: true });
    } catch (err) {
      setDelNotice({ kind: "error", text: describeError(err) });
    }
  }

  if (!user) return null;
  const others = (sessions ?? []).filter((s) => !s.current).length;

  return (
    <main className="container narrow">
      <div className="page-head">
        <div>
          <h1>Account</h1>
          <p className="muted small">
            {user.email}
            {user.createdAt
              ? ` · member since ${new Date(user.createdAt).toLocaleDateString(undefined, { dateStyle: "medium" })}`
              : ""}
          </p>
        </div>
      </div>

      <section className="panel">
        <h2>Email</h2>
        <form onSubmit={saveEmail} className="stack">
          <div>
            <label className="field-label" htmlFor="acct-email">
              New email
            </label>
            <input
              id="acct-email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="acct-email-pw">
              Current password
            </label>
            <input
              id="acct-email-pw"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={emailPw}
              onChange={(e) => setEmailPw(e.target.value)}
            />
          </div>
          <Banner notice={emailNotice} />
          <div>
            <button
              className="btn primary"
              type="submit"
              disabled={email === user.email || !emailPw}
            >
              Update email
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <h2>Password</h2>
        <form onSubmit={savePassword} className="stack">
          <div>
            <label className="field-label" htmlFor="cur-pw">
              Current password
            </label>
            <input
              id="cur-pw"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={curPw}
              onChange={(e) => setCurPw(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="new-pw">
              New password
            </label>
            <input
              id="new-pw"
              className="input"
              type="password"
              autoComplete="new-password"
              minLength={8}
              maxLength={72}
              required
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
            />
            <p className="muted small">
              At least 8 characters. Other devices are signed out when you
              change it.
            </p>
          </div>
          <Banner notice={pwNotice} />
          <div>
            <button className="btn primary" type="submit">
              Change password
            </button>
          </div>
        </form>
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>Where you're signed in</h2>
          {others > 0 && (
            <button className="btn small" onClick={() => void endOthers()}>
              Sign out other devices
            </button>
          )}
        </div>
        <Banner notice={sessionsNotice} />
        {sessions === null ? (
          <p className="muted">Loading…</p>
        ) : (
          <ul className="rows">
            {sessions.map((s) => (
              <li className="row" key={s.id}>
                <div>
                  <div className="row-title">
                    {describeDevice(s.userAgent)}{" "}
                    {s.current && (
                      <span className="chip live">This device</span>
                    )}
                  </div>
                  <div className="row-meta muted small">
                    Signed in {when(s.createdAt)} · last active{" "}
                    {when(s.lastUsedAt)}
                  </div>
                </div>
                {!s.current && (
                  <div className="row-actions">
                    <button
                      className="btn small"
                      onClick={() => void endSession(s)}
                    >
                      Sign out
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel danger-zone">
        <h2>Delete account</h2>
        <p className="muted">
          This permanently deletes your account, every form you built, and all
          of their responses. It can't be undone.
        </p>
        <form onSubmit={deleteAccount} className="stack">
          <div>
            <label className="field-label" htmlFor="del-pw">
              Password
            </label>
            <input
              id="del-pw"
              className="input"
              type="password"
              autoComplete="current-password"
              required
              value={delPw}
              onChange={(e) => setDelPw(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="del-confirm">
              Type DELETE to confirm
            </label>
            <input
              id="del-confirm"
              className="input"
              autoComplete="off"
              value={delConfirm}
              onChange={(e) => setDelConfirm(e.target.value)}
            />
          </div>
          <Banner notice={delNotice} />
          <div>
            <button
              className="btn danger"
              type="submit"
              disabled={delConfirm !== "DELETE" || !delPw}
            >
              Delete my account
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}

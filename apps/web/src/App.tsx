import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { useAuth } from "./auth";
import { LogoMark } from "./components/Logo";
import { AuthPage } from "./pages/AuthPage";
import { FormsPage } from "./pages/FormsPage";
import { BuilderPage } from "./pages/BuilderPage";
import { ResultsPage } from "./pages/ResultsPage";
import { ProfilePage } from "./pages/ProfilePage";
import { PublicFormPage } from "./pages/PublicFormPage";

function Shell() {
  const { user, logout } = useAuth();
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="wordmark">
            <LogoMark />
            Tallymark
          </Link>
          {user && (
            <div className="topbar-user">
              <Link to="/account" className="email muted small">
                {user.email}
              </Link>
              <button className="btn quiet" onClick={() => void logout()}>
                Log out
              </button>
            </div>
          )}
        </div>
      </header>
      <Outlet />
    </>
  );
}

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="container muted">Loading…</p>;
  if (!user)
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}

export function App() {
  return (
    <Routes>
      {/* Respondents: no account, no app chrome. */}
      <Route path="/f/:slug" element={<PublicFormPage />} />

      <Route element={<Shell />}>
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route element={<RequireAuth />}>
          <Route path="/" element={<FormsPage />} />
          <Route path="/account" element={<ProfilePage />} />
          <Route path="/forms/:id" element={<BuilderPage />} />
          <Route path="/forms/:id/results" element={<ResultsPage />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

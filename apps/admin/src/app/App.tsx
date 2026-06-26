import { useAdminAuth } from "../auth/useAdminAuth.js";
import { adminAuthApi } from "../auth/adminAuthApi.js";
import { LoginScreen } from "../auth/LoginScreen.js";
import { Sidebar } from "../components/layout/Sidebar.js";
import { TopBar } from "../components/layout/TopBar.js";
import { OverviewScreen } from "../screens/OverviewScreen.js";
import { routes, useHashRoute } from "./routes.js";

function passwordLoginEnabled(): boolean {
  return (
    window.__TARMOTO_ADMIN_CONFIG__?.passwordLoginEnabled ?? import.meta.env.DEV
  );
}

export function App() {
  const auth = useAdminAuth();
  const { active, navigate } = useHashRoute();

  if (auth.status === "loading") {
    return <div className="app-loading">Loading…</div>;
  }

  if (auth.status === "unauthenticated" || !auth.user) {
    const hasSsoError =
      new URLSearchParams(window.location.search).get("adminAuthError") !==
      null;
    const ssoError = hasSsoError
      ? "GitHub sign-in failed. Please try again."
      : null;
    return (
      <LoginScreen
        onPasswordLogin={auth.loginWithPassword}
        onGithubSso={adminAuthApi.startGithubSso}
        error={auth.error ?? ssoError}
        passwordLoginEnabled={passwordLoginEnabled()}
      />
    );
  }

  return (
    <div className="layout">
      <Sidebar active={active} onNavigate={navigate} />
      <div className="layout__main">
        <TopBar
          email={auth.user.email}
          role={auth.user.role}
          onLogout={auth.logout}
        />
        <main className="layout__content">
          {active === "overview" ? (
            <OverviewScreen />
          ) : (
            <section>
              <h2>{routes.find((r) => r.key === active)?.label ?? active}</h2>
              <p>Coming soon.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

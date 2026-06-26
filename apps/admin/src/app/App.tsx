import { useAdminAuth } from "../auth/useAdminAuth.js";
import { adminAuthApi } from "../auth/adminAuthApi.js";
import { LoginScreen } from "../auth/LoginScreen.js";
import { Sidebar } from "../components/layout/Sidebar.js";
import { TopBar } from "../components/layout/TopBar.js";
import { OverviewScreen } from "../screens/OverviewScreen.js";
import { useHashRoute } from "./routes.js";

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
    return (
      <LoginScreen
        onPasswordLogin={auth.loginWithPassword}
        onGithubSso={adminAuthApi.startGithubSso}
        error={auth.error}
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
              <h2>{active}</h2>
              <p>Coming soon.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

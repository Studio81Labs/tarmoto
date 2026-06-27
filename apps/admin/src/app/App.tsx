import { useEffect, useState } from "react";
import { Heading } from "@tarmoto/ui";
import { useAdminAuth } from "../auth/useAdminAuth.js";
import { adminAuthApi } from "../auth/adminAuthApi.js";
import { LoginScreen } from "../auth/LoginScreen.js";
import { Sidebar } from "../components/layout/Sidebar.js";
import { TopBar } from "../components/layout/TopBar.js";
import { OverviewScreen } from "../screens/OverviewScreen.js";
import { routes, useHashRoute } from "./routes.js";

// Priority: injected window config > fetched endpoint value > dev fallback.
const injectedPasswordLoginEnabled =
  window.__TARMOTO_ADMIN_CONFIG__?.passwordLoginEnabled;

export function App() {
  const auth = useAdminAuth();
  const { active, navigate } = useHashRoute();
  const [passwordLoginEnabled, setPasswordLoginEnabled] = useState<boolean>(
    injectedPasswordLoginEnabled ?? import.meta.env.DEV,
  );

  useEffect(() => {
    if (injectedPasswordLoginEnabled !== undefined) return;
    adminAuthApi.getConfig().then(({ passwordLoginEnabled: enabled }) => {
      setPasswordLoginEnabled(enabled);
    });
  }, []);

  if (auth.status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-cream text-sm text-fg-dim">
        Loading…
      </div>
    );
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
        passwordLoginEnabled={passwordLoginEnabled}
      />
    );
  }

  return (
    <div className="flex min-h-dvh bg-cream">
      <Sidebar active={active} onNavigate={navigate} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          email={auth.user.email}
          role={auth.user.role}
          onLogout={auth.logout}
        />
        <main className="flex-1 overflow-auto p-6">
          {active === "overview" ? (
            <OverviewScreen />
          ) : (
            <section>
              <Heading as="h2">
                {routes.find((r) => r.key === active)?.label ?? active}
              </Heading>
              <p className="mt-2 text-sm text-fg-dim">Coming soon.</p>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}

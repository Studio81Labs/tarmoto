// `UpgradePrompt` pulls in `tierLabel` from `@/lib/entitlements`, which
// imports `ApiError` from `@/services/api` — and that module's real
// `typedClient` chain drags in `react-native-mmkv`'s native NitroModules
// binding, unavailable under Jest. Mock the same seam
// `src/lib/__tests__/entitlements.test.ts` mocks so this plain-render test
// doesn't need any native modules.
jest.mock("@/services/typedClient", () => ({
  client: {
    GET: jest.fn(),
    POST: jest.fn(),
    PATCH: jest.fn(),
    PUT: jest.fn(),
    DELETE: jest.fn(),
  },
  clearTokens: jest.fn(),
  getAccessToken: jest.fn(() => null),
  getAuthenticatedUserId: jest.fn(() => null),
  getCachedUser: jest.fn(() => null),
  isAuthenticated: jest.fn(() => false),
  setCachedUser: jest.fn(),
  setAuthenticatedUserId: jest.fn(),
  storeTokens: jest.fn(),
  rawFetch: jest.fn(),
}));

jest.mock("@/services/pushRegistration", () => ({
  registerForPush: jest.fn(),
  unregisterPush: jest.fn(),
}));

import { render, screen } from "@testing-library/react-native";
import { I18nProvider } from "@/i18n/I18nProvider";
import { UpgradePrompt } from "@/components/entitlements/UpgradePrompt";

// `render` is async in the installed @testing-library/react-native (14.x)
// — see useCommute.test.tsx / ReviewFormModal.test.tsx for the same
// idiom used elsewhere in this repo.
const wrap = (ui: React.ReactElement) =>
  render(<I18nProvider>{ui}</I18nProvider>);

it("shows the upgrade title when a higher tier can lift the cap", async () => {
  await wrap(
    <UpgradePrompt
      visible
      capability={{ feature: "gpx_export" }}
      currentTier="free"
      message="GPX export is a Pro feature."
      onClose={() => {}}
    />,
  );
  expect(screen.getByText("Upgrade required")).toBeTruthy();
  expect(screen.getByText("GPX export is a Pro feature.")).toBeTruthy();
});

it("shows the neutral title when no upgrade can lift it (suppressed/override)", async () => {
  await wrap(
    <UpgradePrompt
      visible
      capability={{ limit: "max_trip_collaborators", resolvedLimit: 5 }}
      currentTier="pro"
      message="Owner is at the collaborator limit."
      onClose={() => {}}
      suppressUpgrade
    />,
  );
  expect(screen.getByText("Limit reached")).toBeTruthy();
});

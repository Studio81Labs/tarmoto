/**
 * `gpx_export` gate on the planned-trip GPX exporter (PR #1086 — Codex
 * P1). The trip GPX is rendered entirely client-side (there is no
 * server endpoint to enforce the entitlement), so the gate must fail
 * closed: disabled while the entitlement snapshot is unresolved, and a
 * resolved non-entitled rider gets the upgrade prompt instead of a file.
 */

import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";

// See RideDetailScreen.test: the bundled react-native-renderer's React
// drifts from the hoisted React in jest, so the real TouchableOpacity
// init fails. Swap in a Pressable that passes props through unchanged.
jest.mock(
  "react-native/Libraries/Components/Touchable/TouchableOpacity",
  () => {
    const ReactLib = require("react");
    const { Pressable } = require("react-native");
    return {
      __esModule: true,
      default: function TouchableOpacityStub(
        props: Record<string, unknown> & { children?: React.ReactNode },
      ) {
        return ReactLib.createElement(Pressable, props, props.children);
      },
    };
  },
);

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

// Native modules the screen imports at module load — stub so importing
// `ExportGpxAction` doesn't drag in real native bindings.
jest.mock("react-native-fs", () => ({
  __esModule: true,
  default: { TemporaryDirectoryPath: "/tmp", writeFile: jest.fn() },
}));
const mockShareOpen = jest.fn().mockResolvedValue({ success: true });
jest.mock("react-native-share", () => ({
  __esModule: true,
  default: { open: (...args: unknown[]) => mockShareOpen(...args) },
}));
jest.mock("@/services/api", () => ({ api: {} }));
// ESM packages the screen imports at module load — never exercised by the
// isolated `ExportGpxAction` render, but they must parse under jest.
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({}),
  useRoute: () => ({ params: {} }),
}));

import { ExportGpxAction } from "../TripDetailScreen";
import { useAuthStore } from "@/stores";
import type { Trip } from "@/types";

const TRIP = {
  id: "trip-1",
  title: "Alps loop",
  days: [
    {
      route_geometry: [
        [10, 46],
        [10.1, 46.1],
      ],
    },
  ],
} as unknown as Trip;

const baseUser = {
  id: "u1",
  subscription_tier: "free",
  features: { gpx_export: true },
  limits: {},
};

const EXPORT_LABEL = "Export trip as GPX";
const UPGRADE_MSG = "GPX export is a Pro feature.";

afterEach(() => {
  useAuthStore.setState({ user: null });
  mockShareOpen.mockClear();
});

it("enables the export button for an entitled rider", async () => {
  useAuthStore.setState({ user: baseUser as never });
  await render(<ExportGpxAction trip={TRIP} />);
  const btn = await screen.findByLabelText(EXPORT_LABEL);
  expect(btn.props.accessibilityState?.disabled).toBe(false);
  expect(screen.queryByText(UPGRADE_MSG)).toBeNull();
});

it("prompts to upgrade instead of exporting when gpx_export is disabled", async () => {
  useAuthStore.setState({
    user: { ...baseUser, features: { gpx_export: false } } as never,
  });
  await render(<ExportGpxAction trip={TRIP} />);
  await fireEvent.press(screen.getByLabelText(EXPORT_LABEL));
  await waitFor(() => expect(screen.getByText(UPGRADE_MSG)).toBeTruthy());
  expect(mockShareOpen).not.toHaveBeenCalled();
});

it("fails closed: the button is disabled while the snapshot is unresolved", async () => {
  // A logged-out / snapshot-less rider — no `features` slice.
  useAuthStore.setState({ user: { id: "u1" } as never });
  await render(<ExportGpxAction trip={TRIP} />);
  const btn = await screen.findByLabelText(EXPORT_LABEL);
  expect(btn.props.accessibilityState?.disabled).toBe(true);
  await fireEvent.press(btn);
  expect(mockShareOpen).not.toHaveBeenCalled();
  expect(screen.queryByText(UPGRADE_MSG)).toBeNull();
});

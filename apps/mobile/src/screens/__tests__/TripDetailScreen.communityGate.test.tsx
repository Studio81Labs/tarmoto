/**
 * `community_access` kill switch on the trip member row (SP4 PR2 — Codex P2).
 *
 * MemberRow cross-tab navigates into ProfileTab > ViewProfile. When the switch
 * is off the tap must be inert: letting it through switches tabs BEFORE
 * ViewProfileScreen's navigate-back fires, stranding the rider on their own
 * Profile tab instead of this trip. Verify the navigation is not issued.
 */

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";

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
  const ReactLib = require("react");
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

jest.mock("react-native-fs", () => ({
  __esModule: true,
  default: { TemporaryDirectoryPath: "/tmp", writeFile: jest.fn() },
}));
jest.mock("react-native-share", () => ({
  __esModule: true,
  default: { open: jest.fn() },
}));
jest.mock("@/services/api", () => ({ api: {} }));

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({ params: {} }),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

import { MemberRow } from "../TripDetailScreen";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import type { TripMember } from "@/types";

const member = {
  user_id: "rider-9",
  display_name: "Jane Rider",
  role: "editor",
} as unknown as TripMember;

beforeEach(() => {
  mockNavigate.mockReset();
  (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
});

it("opens the rider's profile cross-tab when community_access is enabled", async () => {
  await render(<MemberRow member={member} />);
  await fireEvent.press(screen.getByLabelText("Open Jane Rider's profile"));
  expect(mockNavigate).toHaveBeenCalledWith("ProfileTab", {
    screen: "ViewProfile",
    params: { userId: "rider-9" },
  });
});

it("does NOT navigate (preserves the trip tab) when community_access is killed", async () => {
  (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
  await render(<MemberRow member={member} />);

  // The profile affordance is gone — the row renders as plain text.
  expect(screen.queryByLabelText("Open Jane Rider's profile")).toBeNull();
  // Pressing the (now inert) row must not cross-tab navigate.
  await fireEvent.press(screen.getByText("Jane Rider"));
  expect(mockNavigate).not.toHaveBeenCalled();
});

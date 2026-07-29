/**
 * `community_access` kill switch on the road-review author link (SP4 PR2 —
 * Codex P2). ReviewRow cross-tab navigates into ProfileTab > ViewProfile; when
 * the switch is off the reviewer name must render as plain text (no cross-tab
 * jump), so a killed community affordance can't destroy the road-preview tab
 * context by stranding the rider on their own Profile tab.
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

jest.mock("react-native-svg", () => {
  const ReactLib = require("react");
  const { View } = require("react-native");
  const Stub = (props: Record<string, unknown>) =>
    ReactLib.createElement(View, props);
  return { __esModule: true, default: Stub, Path: Stub };
});

jest.mock("@/services/api", () => ({ api: {} }));

const mockNavigate = jest.fn();
jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({ params: {} }),
}));

jest.mock("@/hooks/useFeatureKillSwitch", () => ({
  useFeatureKillSwitchActive: jest.fn(() => true),
}));

import { ReviewRow } from "../RoadPreviewScreen";
import { useFeatureKillSwitchActive } from "@/hooks/useFeatureKillSwitch";
import type { RoadReview } from "@/types";

const review = {
  id: "rev-1",
  user_id: "rider-9",
  user_display_name: "Jane Rider",
  is_mine: false,
  rating: 4,
  comment: null,
  photos: [],
  upvotes: 0,
  downvotes: 0,
  my_vote: null,
} as unknown as RoadReview;

beforeEach(() => {
  mockNavigate.mockReset();
  (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(true);
});

it("links the reviewer's profile cross-tab when community_access is enabled", async () => {
  await render(<ReviewRow review={review} onVoteChange={jest.fn()} />);
  await fireEvent.press(screen.getByLabelText("Open Jane Rider's profile"));
  expect(mockNavigate).toHaveBeenCalledWith("ProfileTab", {
    screen: "ViewProfile",
    params: { userId: "rider-9" },
  });
});

it("renders the reviewer as plain text (no cross-tab nav) when community_access is killed", async () => {
  (useFeatureKillSwitchActive as jest.Mock).mockReturnValue(false);
  await render(<ReviewRow review={review} onVoteChange={jest.fn()} />);

  expect(screen.queryByLabelText("Open Jane Rider's profile")).toBeNull();
  // The name still shows, but as static text with no navigation.
  expect(screen.getByText("Jane Rider")).toBeTruthy();
  expect(mockNavigate).not.toHaveBeenCalled();
});

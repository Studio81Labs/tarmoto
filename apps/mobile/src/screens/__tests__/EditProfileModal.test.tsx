import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import EditProfileModal from "../EditProfileModal";
import { api } from "@/services/api";

const mockGoBack = jest.fn();
const mockSetUser = jest.fn();

jest.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
}));

jest.mock("@/services/api", () => ({
  api: { updateProfile: jest.fn() },
}));

jest.mock("@/stores", () => ({
  useAuthStore: (
    selector: (state: {
      user: {
        display_name: string;
        bio: null;
        home_region: null;
      };
      setUser: typeof mockSetUser;
    }) => unknown,
  ) =>
    selector({
      user: {
        display_name: "Rider One",
        bio: null,
        home_region: null,
      },
      setUser: mockSetUser,
    }),
}));

describe("EditProfileModal", () => {
  beforeEach(() => {
    mockGoBack.mockReset();
    mockSetUser.mockReset();
    jest.mocked(api.updateProfile).mockReset();
  });

  it("renders the cataloged required-name validation", async () => {
    await render(<EditProfileModal />);

    await fireEvent.changeText(screen.getByLabelText("Display name"), "   ");
    await fireEvent.press(screen.getByLabelText("Save profile"));

    expect(screen.getByText("Display name is required.")).toBeTruthy();
    expect(api.updateProfile).not.toHaveBeenCalled();
  });
});

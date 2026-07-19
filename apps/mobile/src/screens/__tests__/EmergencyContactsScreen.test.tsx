/**
 * EmergencyContactsScreen — US-12 AC #4 contact CRUD wiring.
 *
 * Tests the network shape between the screen and `api.listContacts /
 * addContact / updateContact / deleteContact`. The screen owns enough
 * branching (loading / error / empty / list / form modal) that we drive
 * the network layer through `@/services/api` mocks rather than HTTP.
 */
import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react-native";
import { Alert } from "react-native";
import EmergencyContactsScreen from "../EmergencyContactsScreen";
import { api } from "@/services/api";

jest.mock("@/components/Icon", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require("react");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name?: string }) =>
    ReactLib.createElement(Text, null, `icon:${name ?? ""}`);
  return { Icon: MockIcon };
});

jest.mock("@/services/api", () => ({
  api: {
    listContacts: jest.fn(),
    addContact: jest.fn(),
    updateContact: jest.fn(),
    deleteContact: jest.fn(),
  },
}));

const mockedApi = api as jest.Mocked<typeof api>;

describe("EmergencyContactsScreen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedApi.listContacts.mockResolvedValue([
      {
        id: "c1",
        name: "Jane Doe",
        phone: "+420111",
        is_emergency: true,
        created_at: "2026-04-25T10:00:00Z",
      },
      {
        id: "c2",
        name: "John Doe",
        phone: "+420222",
        is_emergency: false,
        created_at: "2026-04-25T09:00:00Z",
      },
    ]);
  });

  it("renders contacts after loading", async () => {
    await render(<EmergencyContactsScreen />);
    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeTruthy());
    expect(screen.getByText("John Doe")).toBeTruthy();
    expect(screen.getByText("Will not be alerted")).toBeTruthy();
  });

  it("creates a new contact via the form modal", async () => {
    mockedApi.addContact.mockResolvedValue({
      id: "c3",
      name: "Mom",
      phone: "+420333",
      is_emergency: true,
      created_at: "2026-04-25T11:00:00Z",
    });

    await render(<EmergencyContactsScreen />);
    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Add emergency contact"));

    await fireEvent.changeText(screen.getByLabelText("Contact name"), "Mom");
    await fireEvent.changeText(
      screen.getByLabelText("Contact phone"),
      "+420333",
    );

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Save contact"));
    });

    await waitFor(() =>
      expect(mockedApi.addContact).toHaveBeenCalledWith({
        name: "Mom",
        phone: "+420333",
        is_emergency: true,
      }),
    );
    await waitFor(() => expect(screen.getByText("Mom")).toBeTruthy());
  });

  it("sends is_emergency:false when the alert toggle is switched off", async () => {
    // Guards the brand Toggle integration: the default is on, so pressing
    // it must flip the saved notification flag (a broken onToggle wiring
    // would silently keep the default `true`).
    mockedApi.addContact.mockResolvedValue({
      id: "c4",
      name: "Dad",
      phone: "+420444",
      is_emergency: false,
      created_at: "2026-04-25T12:00:00Z",
    });

    await render(<EmergencyContactsScreen />);
    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Add emergency contact"));
    await fireEvent.changeText(screen.getByLabelText("Contact name"), "Dad");
    await fireEvent.changeText(
      screen.getByLabelText("Contact phone"),
      "+420444",
    );

    const alertToggle = screen.getByLabelText("Alert this contact in a crash");
    expect(alertToggle.props.accessibilityState).toMatchObject({
      checked: true,
    });
    await fireEvent.press(alertToggle);

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Save contact"));
    });

    await waitFor(() =>
      expect(mockedApi.addContact).toHaveBeenCalledWith({
        name: "Dad",
        phone: "+420444",
        is_emergency: false,
      }),
    );
  });

  it("validates that name and phone are required", async () => {
    await render(<EmergencyContactsScreen />);
    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Add emergency contact"));
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Save contact"));
    });

    await waitFor(() =>
      expect(screen.getByText(/name is required/i)).toBeTruthy(),
    );
    expect(mockedApi.addContact).not.toHaveBeenCalled();
  });

  it("updates an existing contact", async () => {
    mockedApi.updateContact.mockResolvedValue({
      id: "c1",
      name: "Janet Doe",
      phone: "+420111",
      is_emergency: true,
      created_at: "2026-04-25T10:00:00Z",
    });

    await render(<EmergencyContactsScreen />);
    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeTruthy());

    await fireEvent.press(screen.getByLabelText("Edit Jane Doe"));

    await fireEvent.changeText(
      screen.getByLabelText("Contact name"),
      "Janet Doe",
    );
    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Save contact"));
    });

    await waitFor(() =>
      expect(mockedApi.updateContact).toHaveBeenCalledWith("c1", {
        name: "Janet Doe",
        phone: "+420111",
        is_emergency: true,
      }),
    );
    await waitFor(() => expect(screen.getByText("Janet Doe")).toBeTruthy());
  });

  it("deletes a contact after confirming", async () => {
    mockedApi.deleteContact.mockResolvedValue();
    // RN's Alert is a static — intercept and auto-press the destructive
    // option so the assertion exercises the delete path.
    jest.spyOn(Alert, "alert").mockImplementation((_title, _msg, buttons) => {
      const destructive = buttons?.find((b) => b.style === "destructive");
      destructive?.onPress?.();
    });

    await render(<EmergencyContactsScreen />);
    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeTruthy());

    await act(async () => {
      await fireEvent.press(screen.getByLabelText("Delete Jane Doe"));
    });

    await waitFor(() =>
      expect(mockedApi.deleteContact).toHaveBeenCalledWith("c1"),
    );
    await waitFor(() => expect(screen.queryByText("Jane Doe")).toBeNull());
  });

  it("surfaces a load error and offers retry", async () => {
    mockedApi.listContacts.mockRejectedValueOnce(new Error("offline"));

    await render(<EmergencyContactsScreen />);
    await waitFor(() => expect(screen.getByText(/offline/i)).toBeTruthy());

    mockedApi.listContacts.mockResolvedValueOnce([
      {
        id: "c1",
        name: "Jane Doe",
        phone: "+420111",
        is_emergency: true,
        created_at: "2026-04-25T10:00:00Z",
      },
    ]);

    await fireEvent.press(screen.getByText("Retry"));
    await waitFor(() => expect(screen.getByText("Jane Doe")).toBeTruthy());
  });
});

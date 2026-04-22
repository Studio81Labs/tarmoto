import { fireEvent, render, screen } from "@testing-library/react";
import { PassesPanel } from "./PassesPanel";
import { usePasses } from "@/hooks/usePasses";

vi.mock("@/hooks/usePasses", () => ({
  usePasses: vi.fn(),
}));

describe("PassesPanel", () => {
  const usePassesMock = vi.mocked(usePasses);

  beforeEach(() => {
    usePassesMock.mockReset();
    usePassesMock.mockReturnValue({
      passes: [],
      loading: false,
      error: null,
    });
  });

  it("delegates month changes when used as a controlled component", () => {
    const onMonthChange = vi.fn();

    render(<PassesPanel month={7} onMonthChange={onMonthChange} />);

    fireEvent.change(screen.getByLabelText("Travel month"), {
      target: { value: "8" },
    });

    expect(onMonthChange).toHaveBeenCalledWith(8);
  });

  it("disables month changes when a value is forced without a change handler", () => {
    render(<PassesPanel month={7} />);

    expect(screen.getByLabelText("Travel month")).toBeDisabled();
  });
});

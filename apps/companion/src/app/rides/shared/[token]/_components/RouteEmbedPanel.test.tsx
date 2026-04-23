import { fireEvent, render, screen } from "@testing-library/react";
import { RouteEmbedPanel } from "./RouteEmbedPanel";

describe("RouteEmbedPanel", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("renders analytics totals and a default iframe snippet", () => {
    render(
      <RouteEmbedPanel
        origin="https://tarmoto.app"
        token="abc123"
        rideLabel="John Rider · Alpine loop"
        views={128}
        clicks={14}
      />,
    );

    expect(screen.getByText("128 views")).toBeInTheDocument();
    expect(screen.getByText("14 clicks")).toBeInTheDocument();
    expect(
      (screen.getByLabelText("Embed code") as HTMLTextAreaElement).value,
    ).toContain("https://tarmoto.app/embed/rides/abc123?variant=compact");
  });

  it("updates the iframe snippet when the landscape variant is selected and can copy it", async () => {
    render(
      <RouteEmbedPanel
        origin="https://tarmoto.app"
        token="abc123"
        rideLabel="John Rider · Alpine loop"
        views={128}
        clicks={14}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Landscape" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy embed code" }));

    expect(await screen.findByText("Embed code copied")).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      expect.stringContaining(
        "https://tarmoto.app/embed/rides/abc123?variant=landscape",
      ),
    );
  });
});

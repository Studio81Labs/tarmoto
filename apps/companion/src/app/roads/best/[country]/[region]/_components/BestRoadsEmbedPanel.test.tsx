import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BestRoadsEmbedPanel } from "./BestRoadsEmbedPanel";

describe("BestRoadsEmbedPanel", () => {
  const clipboardWriteText = vi.fn();

  beforeEach(() => {
    clipboardWriteText.mockReset();
    Object.assign(navigator, {
      clipboard: {
        writeText: clipboardWriteText,
      },
    });
  });

  it("renders a default iframe snippet for the region widget", () => {
    render(
      <BestRoadsEmbedPanel
        origin="https://tarmoto.app"
        country="at"
        region="tyrol"
        regionName="Tyrol"
      />,
    );

    const snippet = screen.getByLabelText("Embed code");
    expect((snippet as HTMLTextAreaElement).value).toContain(
      "https://tarmoto.app/embed/roads/at/tyrol?variant=compact",
    );
    expect((snippet as HTMLTextAreaElement).value).toContain("height:320px");
  });

  it("updates the snippet and copies it after switching widget size", async () => {
    clipboardWriteText.mockResolvedValueOnce(undefined);

    render(
      <BestRoadsEmbedPanel
        origin="https://tarmoto.app"
        country="at"
        region="tyrol"
        subregion="alpine-passes"
        regionName="Alpine passes"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Landscape" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy embed code" }));

    await waitFor(() =>
      expect(clipboardWriteText).toHaveBeenCalledWith(
        expect.stringContaining(
          "https://tarmoto.app/embed/roads/at/tyrol/alpine-passes?variant=landscape",
        ),
      ),
    );
    expect(clipboardWriteText).toHaveBeenCalledWith(
      expect.stringContaining("height:420px"),
    );
    expect(screen.getByText("Embed code copied")).toBeInTheDocument();
  });
});

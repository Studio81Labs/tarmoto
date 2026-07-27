import React from "react";
import { fireEvent, render, screen } from "@testing-library/react-native";
import FuelRangePicker from "../FuelRangePicker";
import { setActiveFormatContext } from "@/format";
import { FormatProvider } from "@/format/FormatProvider";

describe("FuelRangePicker", () => {
  beforeEach(() => {
    setActiveFormatContext({
      locale: "en-US",
      timeZone: "UTC",
      units: "metric",
    });
  });

  it("keeps the header, pills, and accessibility value in metric units", async () => {
    await render(
      <FuelRangePicker value={200} onChange={jest.fn()} label="Fuel range" />,
    );

    expect(screen.getAllByText("200 km")).toHaveLength(2);
    expect(screen.getByLabelText("200 km")).toBeTruthy();
  });

  it("converts visible and announced choices while preserving kilometre values", async () => {
    const onChange = jest.fn();
    await render(
      <FormatProvider locale="en-US" timeZone="UTC" units="imperial">
        <FuelRangePicker value={200} onChange={onChange} label="Fuel range" />
      </FormatProvider>,
    );

    expect(screen.getAllByText("124.3 mi")).toHaveLength(2);
    const selectedPill = screen.getByLabelText("124.3 mi");
    expect(selectedPill.props.accessibilityState).toEqual({ selected: true });
    fireEvent.press(screen.getByLabelText("155.3 mi"));
    expect(onChange).toHaveBeenCalledWith(250);
    expect(screen.queryByText("200")).toBeNull();
  });
});

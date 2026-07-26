import { render, screen } from "@testing-library/react";
import { MetricTile, type MetricTileProps } from "../MetricTile";

// @ts-expect-error Numeric values must carry an explicit locale-bound formatter.
const invalidNumericProps: MetricTileProps = { label: "Rides", value: 1234 };
void invalidNumericProps;

test("formats numeric values only through the supplied regional formatter", () => {
  const formatValue = vi.fn(() => "1.234");

  render(<MetricTile label="Rides" value={1234} formatValue={formatValue} />);

  expect(formatValue).toHaveBeenCalledWith(1234);
  expect(screen.getByText("1.234")).toBeInTheDocument();
});

test("renders preformatted values without invoking a numeric formatter", () => {
  render(<MetricTile label="Distance" value="1,5 km" />);

  expect(screen.getByText("1,5 km")).toBeInTheDocument();
});

test("renders a locale-leading unit in the dedicated unit slot", () => {
  render(
    <MetricTile
      label="Ride time"
      value="12.5"
      unit="saa"
      unitPosition="before"
    />,
  );

  expect(screen.getByText("saa").nextElementSibling).toHaveTextContent("12.5");
});

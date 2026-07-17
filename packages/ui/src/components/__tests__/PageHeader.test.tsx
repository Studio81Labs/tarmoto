import { act, render, screen } from "@testing-library/react";
import { PageHeader } from "../PageHeader";

// jsdom has no IntersectionObserver; install a stub that captures the
// callback so tests can drive the header in and out of view.
type IOCallback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;
let ioCallback: IOCallback | null = null;
let observed = 0;
let disconnected = 0;

beforeEach(() => {
  ioCallback = null;
  observed = 0;
  disconnected = 0;
  class StubObserver {
    constructor(callback: IntersectionObserverCallback) {
      ioCallback = callback as unknown as IOCallback;
    }
    observe() {
      observed += 1;
    }
    disconnect() {
      disconnected += 1;
    }
    unobserve() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", StubObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function scrollHeaderAway() {
  act(() => {
    ioCallback?.([{ isIntersecting: false }]);
  });
}

test("renders stamp, single h1 title, sub, and the right slot", () => {
  render(
    <PageHeader
      stamp="Ride history"
      title="Ride History"
      sub="Browse every recorded ride."
      right={<button type="button">Record</button>}
    />,
  );
  expect(
    screen.getByRole("heading", { level: 1, name: "Ride History" }),
  ).toBeInTheDocument();
  expect(screen.getByText("Ride history")).toBeInTheDocument();
  expect(screen.getByText("Browse every recorded ride.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Record" })).toBeInTheDocument();
  // The condensed bar mounts only once the header scrolls away.
  expect(screen.getAllByText("Ride History")).toHaveLength(1);
});

test("condensed bar appears when the header leaves the viewport and hides on return", () => {
  render(
    <PageHeader
      title="Trips"
      right={<button type="button">New trip</button>}
    />,
  );
  expect(screen.getAllByText("Trips")).toHaveLength(1);

  scrollHeaderAway();
  // Title now also lives in the bar (as plain text, not a second heading),
  // and the action slot is duplicated so it stays reachable.
  expect(screen.getAllByText("Trips")).toHaveLength(2);
  expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "New trip" })).toHaveLength(2);

  act(() => {
    ioCallback?.([{ isIntersecting: true }]);
  });
  expect(screen.getAllByText("Trips")).toHaveLength(1);
});

test("sticky={false} never observes or mounts the bar", () => {
  render(<PageHeader title="Settings" sticky={false} />);
  expect(observed).toBe(0);
  expect(ioCallback).toBeNull();
});

test("observer disconnects on unmount", () => {
  const { unmount } = render(<PageHeader title="Trips" />);
  expect(observed).toBe(1);
  unmount();
  expect(disconnected).toBe(1);
});

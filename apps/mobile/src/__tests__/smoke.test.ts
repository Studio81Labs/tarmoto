/** Smoke test — verifies Jest runs at all. Keep this green forever. */
describe("jest smoke", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});

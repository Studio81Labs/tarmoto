import { buildLinkAccountDeepLink } from "../account-link";

describe("account link deep links", () => {
  it("builds a mobile deep link with the signed-in email", () => {
    expect(buildLinkAccountDeepLink("rider@example.com")).toBe(
      "tarmoto://link-account?email=rider%40example.com",
    );
  });
});

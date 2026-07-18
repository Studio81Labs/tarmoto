import { __catalogModules } from "./index";

// The barrel merges domain modules with object spread, which silently
// resolves a duplicate key to whichever module is spread last. This test
// makes such a collision a hard failure so a key can never live in two
// modules with one copy silently shadowed.
describe("en catalog domain partition", () => {
  it("defines every key in exactly one domain module", () => {
    const owner = new Map<string, string>();
    const duplicates: string[] = [];
    for (const [domain, mod] of Object.entries(__catalogModules)) {
      for (const key of Object.keys(mod)) {
        const prior = owner.get(key);
        if (prior)
          duplicates.push(`"${key}" in both "${prior}" and "${domain}"`);
        else owner.set(key, domain);
      }
    }
    expect(duplicates).toEqual([]);
  });
});

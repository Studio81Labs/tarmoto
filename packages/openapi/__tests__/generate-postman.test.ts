import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.resolve(__dirname, "..");

describe("generate-postman", () => {
  beforeAll(() => {
    execSync("node scripts/generate-postman.js", { cwd: PKG_DIR });
  });

  it("should generate a Postman collection", () => {
    const collectionPath = path.join(
      PKG_DIR,
      "postman/tarmoto-api.postman_collection.json",
    );
    expect(fs.existsSync(collectionPath)).toBe(true);
    const collection = JSON.parse(fs.readFileSync(collectionPath, "utf8"));
    expect(collection.info.name).toBe("Tarmoto API");
    expect(collection.item.length).toBeGreaterThan(0);
  });

  it("should generate a Postman environment", () => {
    const envPath = path.join(
      PKG_DIR,
      "postman/tarmoto-local.postman_environment.json",
    );
    expect(fs.existsSync(envPath)).toBe(true);
    const env = JSON.parse(fs.readFileSync(envPath, "utf8"));
    expect(env.name).toBe("Tarmoto — Local");
    expect(
      env.values.find((v: { key: string }) => v.key === "baseUrl"),
    ).toBeDefined();
  });

  it("should include bearer auth in the collection", () => {
    const collectionPath = path.join(
      PKG_DIR,
      "postman/tarmoto-api.postman_collection.json",
    );
    const collection = JSON.parse(fs.readFileSync(collectionPath, "utf8"));
    expect(collection.auth.type).toBe("bearer");
  });
});

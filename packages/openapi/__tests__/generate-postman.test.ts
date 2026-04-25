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

  it("uses each DTO field's `example` over an empty-string placeholder", () => {
    // Regression: the generator used to emit `""` for every string
    // field, which 400'd against any field with a regex/length
    // validator (e.g. `client_model_version` requires
    // `^[A-Za-z0-9._-]+$`). Fields with `@ApiProperty({ example })`
    // must round-trip through the generated payload so a copy/pasted
    // smoke test doesn't fail validation.
    const collection = JSON.parse(
      fs.readFileSync(
        path.join(PKG_DIR, "postman/tarmoto-api.postman_collection.json"),
        "utf8",
      ),
    ) as {
      item: {
        item?: { name: string; request?: { body?: { raw: string } } }[];
      }[];
    };

    const upload = collection.item
      .flatMap((folder) => folder.item ?? [])
      .find((req) => req.request?.body?.raw?.includes("client_model_version"));
    expect(upload?.request?.body?.raw).toBeDefined();

    const body = JSON.parse(upload!.request!.body!.raw) as {
      device_model: string;
      client_model_version: string;
    };
    // Both fields declare `example` on their DTO @ApiProperty — the
    // generator must surface those, not the empty-string fallback.
    expect(body.device_model).toBe("iPhone 15 Pro");
    expect(body.client_model_version).toBe("rsc-v1.0.0");
  });
});

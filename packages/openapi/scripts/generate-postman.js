#!/usr/bin/env node
/**
 * Converts packages/openapi/openapi.yaml → Postman Collection + Environment.
 *
 * Usage:  node packages/openapi/scripts/generate-postman.js
 * Output: packages/openapi/postman/tarmoto-api.postman_collection.json
 *         packages/openapi/postman/tarmoto-local.postman_environment.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = path.resolve(__dirname, "..");
const SPEC_PATH = path.join(ROOT, "openapi.yaml");
const OUT_DIR = path.join(ROOT, "postman");

const spec = yaml.load(fs.readFileSync(SPEC_PATH, "utf8"));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic RFC 4122 v5 (SHA-1 name-based) UUID under a fixed
 * Tarmoto-only namespace.
 *
 * These ids used to come from `crypto.randomUUID()`, so every run rewrote
 * `_postman_id` and the tracked output could never be byte-compared against
 * a fresh regeneration — which is why CI had no freshness gate and the
 * collection rotted silently (issue #1133). Name-based ids make the whole
 * output a pure function of `openapi.yaml`, so the openapi-check gate can
 * regenerate and `git diff`. Bonus: a stable `_postman_id` means Postman
 * recognises a re-imported collection as the same one and offers to replace
 * it instead of accumulating duplicates.
 *
 * The namespace is an arbitrary UUID minted once for this generator; it must
 * never change, or every tracked id churns and re-imports duplicate.
 */
const UUID_NAMESPACE = "ff97d41b-abf7-417c-935a-325762a403dc";

function uuidV5(name) {
  const namespaceBytes = Buffer.from(UUID_NAMESPACE.replace(/-/g, ""), "hex");
  const digest = crypto
    .createHash("sha1")
    .update(Buffer.concat([namespaceBytes, Buffer.from(name, "utf8")]))
    .digest();
  const bytes = digest.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}

/** Build a Postman URL object from a path template like /api/v1/me/series/{id} */
function buildUrl(pathStr) {
  const segments = pathStr.replace(/^\//, "").split("/");
  const variables = [];
  const host = ["{{baseUrl}}"];

  const mapped = segments.map((seg) => {
    const match = seg.match(/^\{(.+)\}$/);
    if (match) {
      variables.push({ key: match[1], value: "" });
      return `:${match[1]}`;
    }
    return seg;
  });

  return {
    raw: `{{baseUrl}}${pathStr.replace(/\{/g, ":").replace(/\}/g, "")}`,
    host,
    path: mapped,
    ...(variables.length ? { variable: variables } : {}),
  };
}

/** Build query params from OpenAPI parameters */
function buildQuery(parameters) {
  return (parameters || [])
    .filter((p) => p.in === "query")
    .map((p) => ({
      key: p.name,
      value: "",
      description: p.description || "",
      disabled: !p.required,
    }));
}

/** Build a Postman body from an OpenAPI requestBody. Supports JSON and multipart/form-data. */
function buildBody(requestBody) {
  // Multipart routes (file uploads) need a `formdata` body — Postman
  // sets the `Content-Type: multipart/form-data; boundary=...` header
  // itself once a formdata body is present. Emitting a raw JSON body
  // for these endpoints (the previous behavior) produced a request
  // shape that always failed with "files required" because multer
  // never saw any parts.
  const multipart = requestBody?.content?.["multipart/form-data"]?.schema;
  if (multipart) {
    const resolved = multipart.$ref
      ? spec.components?.schemas?.[
          multipart.$ref.replace("#/components/schemas/", "")
        ] || multipart
      : multipart;
    const properties = resolved.properties || {};
    const formdata = Object.entries(properties).map(([key, prop]) => {
      const isBinary =
        prop.format === "binary" ||
        (prop.type === "array" && prop.items?.format === "binary");
      return {
        key,
        type: isBinary ? "file" : "text",
        ...(isBinary ? { src: [] } : { value: "" }),
        description: prop.description || "",
      };
    });
    return { mode: "formdata", formdata };
  }

  if (!requestBody?.content?.["application/json"]?.schema) return undefined;

  const schemaRef = requestBody.content["application/json"].schema;
  const example = resolveExample(schemaRef);

  return {
    mode: "raw",
    raw: JSON.stringify(example, null, 2),
    options: { raw: { language: "json" } },
  };
}

function isMultipartBody(requestBody) {
  return Boolean(requestBody?.content?.["multipart/form-data"]);
}

/**
 * Resolve a schema ref to an example object. `seed` varies numeric
 * fills across array siblings so a `minItems: 2` polyline doesn't
 * collapse into two identical `{lat:0,lng:0}` points — affects every
 * route-polyline endpoint (`/passes/check-route`, `/closures/check-route`,
 * `/poi/along-route`) where the server validates `ArrayMinSize(2)` and
 * copy/pasting the sample body would otherwise 400.
 */
function resolveExample(schema, seed = 0) {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/components/schemas/", "");
    const def = spec.components?.schemas?.[name];
    if (!def) return {};
    return resolveExample(def, seed);
  }

  // `@ApiProperty({ type: SomeDto, description: '...' })` generates a
  // schema with `allOf: [{ $ref: ... }]` plus a sibling `description`,
  // because OpenAPI 3.0 doesn't allow `description` on a `$ref`
  // directly. Without unwrapping `allOf` we'd produce `{}` for every
  // such field — the postman example would then fail validation as
  // soon as the referenced DTO has required properties (issue #494
  // calibration block was the first place we hit this in the wild).
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return Object.assign(
      {},
      ...schema.allOf.map((branch) => resolveExample(branch, seed)),
    );
  }
  // `oneOf` / `anyOf` — pick the first branch as the canonical
  // example. Same rationale as `allOf`: producing `{}` for a
  // discriminated-union DTO would ship a postman example that 400s
  // before the request reaches the service.
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return resolveExample(schema.oneOf[0], seed);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return resolveExample(schema.anyOf[0], seed);
  }

  if (schema.type === "object") {
    const result = {};
    for (const [key, prop] of Object.entries(schema.properties || {})) {
      result[key] = resolveExample(prop, seed);
    }
    return result;
  }

  if (schema.type === "array") {
    const count = Math.max(1, schema.minItems ?? 1);
    return Array.from({ length: count }, (_, i) =>
      resolveExample(schema.items || {}, i),
    );
  }

  // Primitives — prefer the spec's declared example/default before
  // falling back to a type-shaped placeholder. This matters when a
  // field has a validation regex (e.g. `client_model_version` requires
  // `^[A-Za-z0-9._-]+$`); the empty-string placeholder would 400, but
  // the example baked into `@ApiProperty({ example: 'rsc-v1.0.0' })`
  // round-trips cleanly. `default` is checked too so DTOs with sensible
  // defaults don't need a redundant `example` line.
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (schema.enum) return schema.enum[0];
  if (schema.type === "string") return "";
  if (schema.type === "number" || schema.type === "integer") return seed;
  if (schema.type === "boolean") return false;

  return {};
}

// ---------------------------------------------------------------------------
// Build Postman items grouped by tag
// ---------------------------------------------------------------------------

const HTTP_METHODS = new Set([
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
]);
const folders = new Map(); // tag → items[]

for (const [pathStr, pathItem] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (!HTTP_METHODS.has(method)) continue;
    const tag = operation.tags?.[0] || "default";
    const name =
      operation.summary ||
      operation.operationId ||
      `${method.toUpperCase()} ${pathStr}`;

    const url = buildUrl(pathStr);
    const query = buildQuery(operation.parameters);
    if (query.length) url.query = query;

    // Multipart endpoints must NOT carry a hardcoded
    // `Content-Type: application/json` header — Postman generates the
    // correct `multipart/form-data; boundary=...` value itself once the
    // body's mode is `formdata`, but a manual header overrides that and
    // sends the wrong content type. Emit the JSON header only when the
    // body is actually JSON (or absent — most GET / DELETE callers
    // ignore the header anyway and matching the old shape avoids
    // collection-wide diff churn).
    const headers = isMultipartBody(operation.requestBody)
      ? []
      : [{ key: "Content-Type", value: "application/json" }];

    const item = {
      name,
      request: {
        method: method.toUpperCase(),
        header: headers,
        url,
      },
    };

    // Body
    const body = buildBody(operation.requestBody);
    if (body) item.request.body = body;

    // Auth endpoint: auto-save token to environment
    if (operation.operationId === "AuthController_anonymous") {
      item.event = [
        {
          listen: "test",
          script: {
            type: "text/javascript",
            exec: [
              "if (pm.response.code === 201) {",
              "  const body = pm.response.json();",
              '  pm.environment.set("token", body.accessToken);',
              '  console.log("Token saved to environment");',
              "}",
            ],
          },
        },
      ];
    }

    if (!folders.has(tag)) folders.set(tag, []);
    folders.get(tag).push(item);
  }
}

// ---------------------------------------------------------------------------
// Assemble collection
// ---------------------------------------------------------------------------

const collection = {
  info: {
    name: "Tarmoto API",
    _postman_id: uuidV5("Tarmoto API"),
    description: spec.info?.description || "",
    schema:
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  auth: {
    type: "bearer",
    bearer: [{ key: "token", value: "{{token}}", type: "string" }],
  },
  item: [...folders.entries()].map(([tag, items]) => ({
    name: tag,
    item: items,
  })),
};

// ---------------------------------------------------------------------------
// Assemble environment
// ---------------------------------------------------------------------------

const environment = {
  id: uuidV5("Tarmoto — Local"),
  name: "Tarmoto — Local",
  values: [
    { key: "baseUrl", value: "http://localhost:3000", enabled: true },
    { key: "token", value: "", enabled: true },
  ],
  _postman_variable_scope: "environment",
};

// ---------------------------------------------------------------------------
// Write files
// ---------------------------------------------------------------------------

fs.mkdirSync(OUT_DIR, { recursive: true });

const collectionPath = path.join(
  OUT_DIR,
  "tarmoto-api.postman_collection.json",
);
const envPath = path.join(OUT_DIR, "tarmoto-local.postman_environment.json");

fs.writeFileSync(collectionPath, JSON.stringify(collection, null, 2) + "\n");
fs.writeFileSync(envPath, JSON.stringify(environment, null, 2) + "\n");

console.log(`Collection → ${path.relative(process.cwd(), collectionPath)}`);
console.log(`Environment → ${path.relative(process.cwd(), envPath)}`);

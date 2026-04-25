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

function uuid() {
  return crypto.randomUUID();
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

/** Build a sample JSON body from a $ref schema */
function buildBody(requestBody) {
  if (!requestBody?.content?.["application/json"]?.schema) return undefined;

  const schemaRef = requestBody.content["application/json"].schema;
  const example = resolveExample(schemaRef);

  return {
    mode: "raw",
    raw: JSON.stringify(example, null, 2),
    options: { raw: { language: "json" } },
  };
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

    const item = {
      name,
      request: {
        method: method.toUpperCase(),
        header: [{ key: "Content-Type", value: "application/json" }],
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
    _postman_id: uuid(),
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
  id: uuid(),
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

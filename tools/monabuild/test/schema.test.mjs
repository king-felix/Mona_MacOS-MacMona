import test from "node:test";
import assert from "node:assert/strict";
import { validate } from "../lib/schema.mjs";

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "count"],
  properties: {
    id: { type: "string", pattern: "^P\\d{2}$" },
    count: { type: "integer", minimum: 1 },
    tags: { type: "array", items: { type: "string" }, minItems: 1, uniqueItems: true },
  },
};

test("accepts a valid document", () => {
  assert.equal(validate({ id: "P00", count: 3, tags: ["a", "b"] }, schema).valid, true);
});

test("reports a missing required property", () => {
  const result = validate({ id: "P00" }, schema);
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /missing required property "count"/);
});

test("rejects unknown properties when additionalProperties is false", () => {
  const result = validate({ id: "P00", count: 1, extra: true }, schema);
  assert.equal(result.valid, false);
  assert.match(result.errors[0].message, /unexpected property "extra"/);
});

test("enforces patterns, bounds, and duplicates", () => {
  const result = validate({ id: "X1", count: 0, tags: ["a", "a"] }, schema);
  const messages = result.errors.map((error) => error.message).join("\n");
  assert.match(messages, /does not match pattern/);
  assert.match(messages, /less than minimum 1/);
  assert.match(messages, /duplicate item/);
});

test("resolves local $ref definitions", () => {
  const withRef = {
    type: "object",
    required: ["task"],
    properties: { task: { $ref: "#/definitions/task" } },
    definitions: { task: { type: "object", required: ["status"], properties: { status: { const: "pending" } } } },
  };
  assert.equal(validate({ task: { status: "pending" } }, withRef).valid, true);
  assert.equal(validate({ task: { status: "running" } }, withRef).valid, false);
});

test("anyOf accepts one matching variant", () => {
  const withAny = { anyOf: [{ type: "string" }, { type: "null" }] };
  assert.equal(validate("x", withAny).valid, true);
  assert.equal(validate(null, withAny).valid, true);
  assert.equal(validate(3, withAny).valid, false);
});

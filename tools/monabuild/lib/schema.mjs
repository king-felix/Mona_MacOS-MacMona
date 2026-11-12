// Minimal, dependency-free JSON Schema validator for the build ledger.
// Supports the subset used by tools/monabuild/schemas/*.json:
//   $ref (local #/definitions/...), type, const, enum, required, properties,
//   additionalProperties, patternProperties, items, minItems, maxItems,
//   minProperties, maxProperties, minLength, maxLength, pattern, minimum,
//   maximum, anyOf, allOf, oneOf, and the custom keyword `uniqueBy`.
// This is deliberately not a general-purpose validator: unknown keywords are
// ignored, formats are not enforced, and error messages are plain strings.

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  if (type === "number") return actual === "number" || actual === "integer";
  if (type === "integer") return actual === "integer";
  return actual === type;
}

function resolveRef(ref, root) {
  if (!ref.startsWith("#/")) {
    throw new Error(`unsupported $ref: ${ref}`);
  }
  return ref
    .slice(2)
    .split("/")
    .reduce((node, key) => {
      if (node === undefined || node === null) throw new Error(`unresolvable $ref: ${ref}`);
      return node[key.replace(/~1/g, "/").replace(/~0/g, "~")];
    }, root);
}

function deepEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function push(errors, path, message) {
  errors.push({ path, message });
}

function validateNode(value, schema, root, path, errors) {
  if (schema === true || schema === undefined) return;
  if (schema === false) {
    push(errors, path, "value is not allowed here");
    return;
  }
  if (schema.$ref) {
    validateNode(value, resolveRef(schema.$ref, root), root, path, errors);
    return;
  }

  if (schema.anyOf) {
    const matches = schema.anyOf.filter((sub) => {
      const local = [];
      validateNode(value, sub, root, path, local);
      return local.length === 0;
    });
    if (matches.length === 0) push(errors, path, "does not match any allowed variant");
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((sub) => {
      const local = [];
      validateNode(value, sub, root, path, local);
      return local.length === 0;
    });
    if (matches.length !== 1) push(errors, path, "must match exactly one allowed variant");
  }
  if (schema.allOf) {
    for (const sub of schema.allOf) validateNode(value, sub, root, path, errors);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      push(errors, path, `expected ${types.join("|")}, got ${typeOf(value)}`);
      return;
    }
  }
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    push(errors, path, `expected constant ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.some((candidate) => deepEqual(value, candidate))) {
    push(errors, path, `expected one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }

  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      push(errors, path, `shorter than ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      push(errors, path, `longer than ${schema.maxLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      push(errors, path, `does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      push(errors, path, `less than minimum ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      push(errors, path, `greater than maximum ${schema.maximum}`);
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      push(errors, path, `fewer than ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      push(errors, path, `more than ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) => validateNode(item, schema.items, root, `${path}[${index}]`, errors));
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      value.forEach((item, index) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) push(errors, path, `duplicate item at index ${index}`);
        else seen.add(key);
      });
    }
    if (schema.uniqueBy) {
      const seen = new Map();
      value.forEach((item, index) => {
        const key = schema.uniqueBy.split(".").reduce((node, part) => (node == null ? node : node[part]), item);
        if (key === undefined) return;
        if (seen.has(key)) {
          push(errors, path, `duplicate ${schema.uniqueBy} ${JSON.stringify(key)} at ${index} and ${seen.get(key)}`);
        } else {
          seen.set(key, index);
        }
      });
    }
  }

  if (typeOf(value) === "object") {
    const keys = Object.keys(value);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties) {
      push(errors, path, `fewer than ${schema.minProperties} properties`);
    }
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) {
      push(errors, path, `more than ${schema.maxProperties} properties`);
    }
    for (const required of schema.required ?? []) {
      if (!(required in value)) push(errors, path, `missing required property "${required}"`);
    }
    const properties = schema.properties ?? {};
    const patternProperties = schema.patternProperties ?? {};
    for (const key of keys) {
      const childPath = `${path}.${key}`;
      let matched = false;
      if (Object.hasOwn(properties, key)) {
        matched = true;
        validateNode(value[key], properties[key], root, childPath, errors);
      }
      for (const [pattern, sub] of Object.entries(patternProperties)) {
        if (new RegExp(pattern).test(key)) {
          matched = true;
          validateNode(value[key], sub, root, childPath, errors);
        }
      }
      if (!matched && schema.additionalProperties !== undefined) {
        if (schema.additionalProperties === false) {
          push(errors, path, `unexpected property "${key}"`);
        } else {
          validateNode(value[key], schema.additionalProperties, root, childPath, errors);
        }
      }
    }
  }
}

export function validate(value, schema) {
  const errors = [];
  validateNode(value, schema, schema, "$", errors);
  return { valid: errors.length === 0, errors };
}

export function assertValid(value, schema, label = "document") {
  const result = validate(value, schema);
  if (!result.valid) {
    const detail = result.errors.map((e) => `  ${e.path}: ${e.message}`).join("\n");
    const error = new Error(`${label} failed schema validation:\n${detail}`);
    error.validation = result;
    throw error;
  }
  return value;
}

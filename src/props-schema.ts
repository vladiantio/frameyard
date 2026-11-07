import {
  assertJsonSerializable,
  isPlainObject,
  type JsonPrimitive,
  type JsonValue,
  type Props,
  type PropsSchema,
  type PropsSchemaType,
} from "./contracts.js";
import { FrameyardError, errorMessage } from "./errors.js";

export const PROPS_SCHEMA_TYPES: readonly PropsSchemaType[] = ["object", "string", "number", "boolean", "array"];

const SCHEMA_KEYS = new Set(["type", "description", "default", "enum", "properties", "required", "items"]);

export interface PropsSchemaIssue {
  path: string;
  message: string;
  suggestion?: string;
}

function schemaError(message: string): never {
  throw new FrameyardError("PROPS_SCHEMA_INVALID_SCHEMA", message);
}

function displayPath(path: string): string {
  return path.length === 0 ? "props" : path;
}

function propertyPath(parent: string, key: string): string {
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)) {
    return parent.length === 0 ? key : `${parent}.${key}`;
  }
  return `${parent}[${JSON.stringify(key)}]`;
}

function itemPath(parent: string, index: number): string {
  return `${displayPath(parent)}[${index}]`;
}

function receivedType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function matchesType(type: PropsSchemaType, value: unknown): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
  }
}

function matchesEnum(schema: PropsSchema, value: unknown): boolean {
  if (schema.enum === undefined) {
    return true;
  }
  return schema.enum.some((candidate) => Object.is(candidate, value));
}

function formatEnum(values: readonly JsonPrimitive[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function validateValue(schema: PropsSchema, value: unknown, path: string, issues: PropsSchemaIssue[]): void {
  if (!matchesType(schema.type, value)) {
    issues.push({
      path: displayPath(path),
      message: `Prop "${displayPath(path)}" must be a ${schema.type}; received ${receivedType(value)}.`,
      suggestion: `Use a ${schema.type} value for "${displayPath(path)}" or update the schema.`,
    });
    return;
  }

  if (!matchesEnum(schema, value)) {
    issues.push({
      path: displayPath(path),
      message: `Prop "${displayPath(path)}" must be one of ${formatEnum(schema.enum ?? [])}; received ${JSON.stringify(value)}.`,
      suggestion: `Use one of ${formatEnum(schema.enum ?? [])} for "${displayPath(path)}" or update the schema.`,
    });
  }

  if (schema.type === "object") {
    const object = value as Record<string, JsonValue>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(object, key)) {
        issues.push({
          path: propertyPath(path, key),
          message: `Required prop "${propertyPath(path, key)}" is missing.`,
          suggestion: `Add a "${propertyPath(path, key)}" prop or mark it optional in the schema.`,
        });
      }
    }
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(object, key)) {
        validateValue(childSchema, object[key], propertyPath(path, key), issues);
      }
    }
    return;
  }

  if (schema.type === "array" && schema.items !== undefined) {
    const array = value as JsonValue[];
    for (let index = 0; index < array.length; index += 1) {
      validateValue(schema.items, array[index], itemPath(path, index), issues);
    }
  }
}

/**
 * Validates a parsed schema. Throws PROPS_SCHEMA_INVALID_SCHEMA for anything
 * outside the supported subset. The root schema must describe an object.
 */
export function parsePropsSchema(value: unknown): PropsSchema {
  const schema = parseSchemaNode(value, "schema");
  if (schema.type !== "object") {
    schemaError('schema.type must be "object" at the root.');
  }
  return schema;
}

function parseSchemaNode(value: unknown, path: string): PropsSchema {
  if (!isPlainObject(value)) {
    schemaError(`${path} must be a JSON object.`);
  }

  for (const key of Object.keys(value)) {
    if (!SCHEMA_KEYS.has(key)) {
      schemaError(`${path} contains unsupported keyword "${key}".`);
    }
  }

  const type = value.type;
  if (typeof type !== "string" || !PROPS_SCHEMA_TYPES.includes(type as PropsSchemaType)) {
    schemaError(`${path}.type must be one of ${PROPS_SCHEMA_TYPES.join(", ")}.`);
  }

  const schema: PropsSchema = { type: type as PropsSchemaType };

  if (value.description !== undefined) {
    if (typeof value.description !== "string") {
      schemaError(`${path}.description must be a string.`);
    }
    schema.description = value.description;
  }

  if (value.default !== undefined) {
    try {
      assertJsonSerializable(value.default, `${path}.default`);
    } catch (error) {
      schemaError(`${path}.default is invalid: ${errorMessage(error)}`);
    }
    schema.default = value.default as JsonValue;
  }

  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      schemaError(`${path}.enum must be a non-empty array.`);
    }
    const enumValues: JsonPrimitive[] = [];
    for (const candidate of value.enum) {
      if (
        candidate !== null &&
        typeof candidate !== "string" &&
        typeof candidate !== "number" &&
        typeof candidate !== "boolean"
      ) {
        schemaError(`${path}.enum entries must be strings, numbers, booleans, or null.`);
      }
      if (typeof candidate === "number" && !Number.isFinite(candidate)) {
        schemaError(`${path}.enum numbers must be finite.`);
      }
      enumValues.push(candidate as JsonPrimitive);
    }
    schema.enum = enumValues;
  }

  if (value.properties !== undefined) {
    if (schema.type !== "object") {
      schemaError(`${path}.properties is only valid for object schemas.`);
    }
    if (!isPlainObject(value.properties)) {
      schemaError(`${path}.properties must be a JSON object.`);
    }
    const properties: Record<string, PropsSchema> = {};
    for (const [key, child] of Object.entries(value.properties)) {
      if (key.length === 0) {
        schemaError(`${path}.properties keys must be non-empty.`);
      }
      properties[key] = parseSchemaNode(child, `${path}.properties.${key}`);
    }
    schema.properties = properties;
  }

  if (value.required !== undefined) {
    if (schema.type !== "object") {
      schemaError(`${path}.required is only valid for object schemas.`);
    }
    if (!Array.isArray(value.required) || value.required.some((entry) => typeof entry !== "string")) {
      schemaError(`${path}.required must be an array of strings.`);
    }
    const required = value.required as string[];
    if (new Set(required).size !== required.length) {
      schemaError(`${path}.required must not contain duplicates.`);
    }
    const properties = schema.properties ?? {};
    for (const key of required) {
      if (!Object.hasOwn(properties, key)) {
        schemaError(`${path}.required references unknown property "${key}".`);
      }
    }
    schema.required = required;
  }

  if (value.items !== undefined) {
    if (schema.type !== "array") {
      schemaError(`${path}.items is only valid for array schemas.`);
    }
    schema.items = parseSchemaNode(value.items, `${path}.items`);
  } else if (schema.type === "array") {
    schemaError(`${path}.items is required for array schemas.`);
  }

  if (schema.default !== undefined) {
    const issues: PropsSchemaIssue[] = [];
    validateValue(schema, schema.default, path, issues);
    if (issues.length > 0) {
      schemaError(`${path}.default ${issues[0]?.message ?? "does not match the schema."}`);
    }
  }

  if (schema.enum !== undefined) {
    for (const candidate of schema.enum) {
      if (!matchesType(schema.type, candidate)) {
        schemaError(`${path}.enum values must match type "${schema.type}".`);
      }
    }
  }

  return schema;
}

/**
 * Applies schema defaults without overriding values already present. Object
 * defaults are filled recursively; arrays keep their explicit entries.
 */
export function applyPropsSchemaDefaults(schema: PropsSchema, value?: unknown): Record<string, JsonValue> {
  const resolved = applyDefaults(schema, value);
  return isPlainObject(resolved) ? (resolved as Record<string, JsonValue>) : {};
}

function cloneJson(value: JsonValue): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function applyDefaults(schema: PropsSchema, value: unknown): unknown {
  if (schema.type === "object") {
    if (value !== undefined && !isPlainObject(value)) {
      return value;
    }
    const source = (value ?? {}) as Record<string, JsonValue>;
    const result: Record<string, JsonValue> = { ...source };
    for (const [key, childSchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(source, key)) {
        result[key] = applyDefaults(childSchema, source[key]) as JsonValue;
      } else if (childSchema.default !== undefined) {
        result[key] = applyDefaults(childSchema, cloneJson(childSchema.default)) as JsonValue;
      }
    }
    return result;
  }

  if (value === undefined && schema.default !== undefined) {
    return cloneJson(schema.default);
  }
  return value;
}

/** Validates resolved props against a parsed schema. */
export function validatePropsAgainstSchema(schema: PropsSchema, props: Readonly<Props>): PropsSchemaIssue[] {
  const issues: PropsSchemaIssue[] = [];
  validateValue(schema, props, "", issues);
  return issues;
}

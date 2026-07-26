/**
 * A minimal JSON Schema shape checker.
 *
 * The Claude structured-outputs feature already constrains the response, but the
 * spec requires us to retry on schema violation up to 3 times and then mark the
 * generation failed rather than serve a malformed item. That needs a local check —
 * one that also covers the constraints structured outputs deliberately ignores
 * (array lengths, enum membership in nested positions).
 */

export type JsonSchema = {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean;
  /** Local-only hints; stripped before the schema is sent to the API. */
  'x-minItems'?: number;
  'x-maxItems'?: number;
  [k: string]: unknown;
};

export class SchemaViolation extends Error {
  constructor(public readonly problems: string[]) {
    super(`schema violation: ${problems.join('; ')}`);
    this.name = 'SchemaViolation';
  }
}

/** Remove the `x-` hint keys — the API rejects unknown keywords. */
export function wireSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k.startsWith('x-')) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, JsonSchema> = {};
      for (const [pk, pv] of Object.entries(v as Record<string, JsonSchema>)) {
        props[pk] = wireSchema(pv);
      }
      out.properties = props;
    } else if (k === 'items' && v && typeof v === 'object') {
      out.items = wireSchema(v as JsonSchema);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function validateShape(value: unknown, schema: JsonSchema, path = '$'): string[] {
  const problems: string[] = [];

  const t = schema.type;
  if (t === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return [`${path}: expected object, got ${describe(value)}`];
    }
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) {
        problems.push(`${path}.${key}: missing`);
      }
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj && obj[key] !== undefined) {
        problems.push(...validateShape(obj[key], sub, `${path}.${key}`));
      }
    }
    return problems;
  }

  if (t === 'array') {
    if (!Array.isArray(value)) return [`${path}: expected array, got ${describe(value)}`];
    const min = schema['x-minItems'];
    const max = schema['x-maxItems'];
    if (typeof min === 'number' && value.length < min) {
      problems.push(`${path}: expected at least ${min} items, got ${value.length}`);
    }
    if (typeof max === 'number' && value.length > max) {
      problems.push(`${path}: expected at most ${max} items, got ${value.length}`);
    }
    if (schema.items) {
      value.forEach((v, i) => problems.push(...validateShape(v, schema.items!, `${path}[${i}]`)));
    }
    return problems;
  }

  if (schema.enum) {
    if (!schema.enum.includes(value as never)) {
      problems.push(`${path}: expected one of ${JSON.stringify(schema.enum)}, got ${describe(value)}`);
    }
    return problems;
  }

  switch (t) {
    case 'string':
      if (typeof value !== 'string') problems.push(`${path}: expected string, got ${describe(value)}`);
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        problems.push(`${path}: expected integer, got ${describe(value)}`);
      }
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        problems.push(`${path}: expected number, got ${describe(value)}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') problems.push(`${path}: expected boolean, got ${describe(value)}`);
      break;
    case 'null':
      if (value !== null) problems.push(`${path}: expected null, got ${describe(value)}`);
      break;
    default:
      break;
  }
  return problems;
}

function describe(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/** Helper: a nullable string, expressed the way structured outputs accepts. */
export const nullableString: JsonSchema = { type: ['string', 'null'] as unknown as string };

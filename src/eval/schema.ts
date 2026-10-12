// ---------------------------------------------------------------------------
// A small declarative schema validator for eval records (manifests, cases,
// labels). Hand-rolled so the harness adds no runtime dependency.
// ---------------------------------------------------------------------------

export type Schema =
  | { type: "string"; pattern?: RegExp; nullable?: boolean; optional?: boolean }
  | { type: "number"; integer?: boolean; min?: number; max?: number; nullable?: boolean; optional?: boolean }
  | { type: "boolean"; nullable?: boolean; optional?: boolean }
  | { type: "enum"; values: readonly string[]; nullable?: boolean; optional?: boolean }
  | { type: "array"; items: Schema; minItems?: number; nullable?: boolean; optional?: boolean }
  | { type: "object"; fields: Record<string, Schema>; additional?: boolean; nullable?: boolean; optional?: boolean }
  | { type: "record"; values: Schema; nullable?: boolean; optional?: boolean }
  | { type: "any"; optional?: boolean };

export const str = (extra: Partial<Extract<Schema, { type: "string" }>> = {}): Schema => ({ type: "string", ...extra });
export const num = (extra: Partial<Extract<Schema, { type: "number" }>> = {}): Schema => ({ type: "number", ...extra });
export const int = (extra: Partial<Extract<Schema, { type: "number" }>> = {}): Schema => ({ type: "number", integer: true, ...extra });
export const bool = (extra: Partial<Extract<Schema, { type: "boolean" }>> = {}): Schema => ({ type: "boolean", ...extra });
export const oneOf = (values: readonly string[], extra: { nullable?: boolean; optional?: boolean } = {}): Schema => ({ type: "enum", values, ...extra });
export const arr = (items: Schema, extra: { minItems?: number; nullable?: boolean; optional?: boolean } = {}): Schema => ({ type: "array", items, ...extra });
export const obj = (fields: Record<string, Schema>, extra: { additional?: boolean; nullable?: boolean; optional?: boolean } = {}): Schema => ({ type: "object", fields, ...extra });
export const rec = (values: Schema, extra: { nullable?: boolean; optional?: boolean } = {}): Schema => ({ type: "record", values, ...extra });
export const any = (extra: { optional?: boolean } = {}): Schema => ({ type: "any", ...extra });

export const SHA256 = /^[0-9a-f]{64}$/;
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Validate `value` against `schema`; returns one message per violation (empty = valid). */
export function validate(schema: Schema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  check(schema, value, path, errors);
  return errors;
}

export function assertValid(schema: Schema, value: unknown, what: string): void {
  const errors = validate(schema, value);
  if (errors.length > 0) {
    throw new Error(`Invalid ${what}:\n  ${errors.slice(0, 20).join("\n  ")}${errors.length > 20 ? `\n  …and ${errors.length - 20} more` : ""}`);
  }
}

function check(schema: Schema, value: unknown, path: string, errors: string[]): void {
  if (value === undefined) {
    if (!("optional" in schema && schema.optional)) errors.push(`${path}: required`);
    return;
  }
  if (value === null) {
    if (!("nullable" in schema && schema.nullable)) errors.push(`${path}: must not be null`);
    return;
  }
  switch (schema.type) {
    case "any":
      return;
    case "string":
      if (typeof value !== "string") errors.push(`${path}: expected string`);
      else if (schema.pattern && !schema.pattern.test(value)) errors.push(`${path}: "${value.slice(0, 60)}" does not match ${schema.pattern}`);
      return;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) errors.push(`${path}: expected number`);
      else if (schema.integer && !Number.isInteger(value)) errors.push(`${path}: expected integer`);
      else if (schema.min !== undefined && value < schema.min) errors.push(`${path}: below ${schema.min}`);
      else if (schema.max !== undefined && value > schema.max) errors.push(`${path}: above ${schema.max}`);
      return;
    case "boolean":
      if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      return;
    case "enum":
      if (typeof value !== "string" || !schema.values.includes(value)) errors.push(`${path}: expected one of ${schema.values.join(" | ")}`);
      return;
    case "array":
      if (!Array.isArray(value)) {
        errors.push(`${path}: expected array`);
        return;
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: needs at least ${schema.minItems} item(s)`);
      value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
      return;
    case "record":
      if (typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) check(schema.values, v, `${path}.${k}`, errors);
      return;
    case "object": {
      if (typeof value !== "object" || Array.isArray(value)) {
        errors.push(`${path}: expected object`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const [k, s] of Object.entries(schema.fields)) check(s, record[k], `${path}.${k}`, errors);
      if (!schema.additional) {
        for (const k of Object.keys(record)) {
          if (!(k in schema.fields)) errors.push(`${path}.${k}: unexpected field`);
        }
      }
      return;
    }
  }
}

// Minimal zod -> JSON Schema converter for the subset used by the action table (no extra dependency).
import type { z } from 'zod';

export interface JsonSchema { [k: string]: unknown }

export function toJsonSchema(t: z.ZodTypeAny): JsonSchema {
  const d = t._def as { typeName: string; description?: string; [k: string]: any };
  const withDesc = (s: JsonSchema): JsonSchema => (d.description ? { ...s, description: d.description } : s);
  switch (d.typeName) {
    case 'ZodString': {
      const s: JsonSchema = { type: 'string' };
      for (const c of d.checks ?? []) {
        if (c.kind === 'min') s.minLength = c.value;
        if (c.kind === 'max') s.maxLength = c.value;
      }
      return withDesc(s);
    }
    case 'ZodNumber': {
      const s: JsonSchema = { type: 'number' };
      for (const c of d.checks ?? []) {
        if (c.kind === 'int') s.type = 'integer';
        if (c.kind === 'min') s.minimum = c.value;
        if (c.kind === 'max') s.maximum = c.value;
      }
      return withDesc(s);
    }
    case 'ZodBoolean': return withDesc({ type: 'boolean' });
    case 'ZodEnum': return withDesc({ type: 'string', enum: d.values });
    case 'ZodArray': {
      const s: JsonSchema = { type: 'array', items: toJsonSchema(d.type) };
      if (d.minLength) s.minItems = d.minLength.value;
      if (d.maxLength) s.maxItems = d.maxLength.value;
      return withDesc(s);
    }
    case 'ZodRecord': return withDesc({ type: 'object', additionalProperties: toJsonSchema(d.valueType) });
    case 'ZodUnion': return withDesc({ anyOf: (d.options as z.ZodTypeAny[]).map(toJsonSchema) });
    case 'ZodOptional': { const inner = toJsonSchema(d.innerType); return d.description ? { ...inner, description: d.description } : inner; }
    case 'ZodDefault': { const inner = toJsonSchema(d.innerType); return { ...inner, default: d.defaultValue(), ...(d.description ? { description: d.description } : {}) }; }
    case 'ZodObject': {
      const shape = (t as z.ZodObject<z.ZodRawShape>).shape;
      const required = Object.keys(shape).filter((k) => !shape[k].isOptional());
      return withDesc({ type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, toJsonSchema(v)])), ...(required.length ? { required } : {}) });
    }
    default: return withDesc({});
  }
}

/**
 * The few argument types lockwire's MCP tools take (strings, booleans, a choice from a list, lists of
 * strings, each optionally), with what the protocol needs of them: checking a value, and the JSON Schema
 * a tool listing shows the model. Small enough to write out, so the server needs no schema library.
 */

export interface Schema<T> {
  readonly json: Record<string, unknown>;
  /** False when a tool call may leave the argument out. */
  readonly required: boolean;
  /** The value, or the problem with it. */
  check(value: unknown): { value: T } | { problem: string };
  optional(): Schema<T | undefined>;
}

const describe = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

function make<T>(
  json: Record<string, unknown>,
  check: (value: unknown) => { value: T } | { problem: string },
  required = true,
): Schema<T> {
  return {
    json,
    required,
    check: (value) =>
      value === undefined
        ? required
          ? { problem: "Invalid input: expected a value, received undefined" }
          : { value: undefined as T }
        : check(value),
    optional: () => make(json, check, false) as Schema<T | undefined>,
  };
}

const typed = <T>(type: "string" | "boolean") =>
  make<T>({ type }, (v) =>
    typeof v === type
      ? { value: v as T }
      : { problem: `Invalid input: expected ${type}, received ${describe(v)}` },
  );

export const s = {
  string: () => typed<string>("string"),
  boolean: () => typed<boolean>("boolean"),
  enum: <const V extends readonly string[]>(values: V) =>
    make<V[number]>({ type: "string", enum: [...values] }, (v) =>
      typeof v === "string" && values.includes(v)
        ? { value: v }
        : { problem: `Invalid option: expected one of ${values.map((x) => `"${x}"`).join("|")}` },
    ),
  array: <T>(item: Schema<T>) =>
    make<T[]>({ type: "array", items: item.json }, (v) => {
      if (!Array.isArray(v))
        return { problem: `Invalid input: expected array, received ${describe(v)}` };
      const out: T[] = [];
      for (const [i, element] of v.entries()) {
        const r = item.check(element);
        if ("problem" in r) return { problem: `${r.problem} at ${i}` };
        out.push(r.value);
      }
      return { value: out };
    }),
};

// biome-ignore lint/suspicious/noExplicitAny: a shape holds schemas of every type
export type Shape = Record<string, Schema<any>>;

type Optional<S extends Shape> = {
  [K in keyof S]: undefined extends Output1<S[K]> ? K : never;
}[keyof S];
type Output1<X> = X extends Schema<infer T> ? T : never;

/** What a tool's handler receives: each argument's type, with the optional ones optional. */
export type Output<S extends Shape> = { [K in Exclude<keyof S, Optional<S>>]: Output1<S[K]> } & {
  [K in Optional<S>]?: Output1<S[K]>;
};

/** The JSON Schema for a tool's arguments. */
export function objectJson(shape: Shape): Record<string, unknown> {
  const required = Object.entries(shape)
    .filter(([, f]) => f.required)
    .map(([name]) => name);
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    type: "object",
    properties: Object.fromEntries(Object.entries(shape).map(([name, f]) => [name, f.json])),
    ...(required.length > 0 ? { required } : {}),
  };
}

/** Checks a tool call's arguments against its shape: the arguments, or every problem found. */
export function parseObject<S extends Shape>(
  shape: S,
  args: unknown,
): { value: Output<S> } | { problem: string } {
  if (args === null || typeof args !== "object" || Array.isArray(args))
    return { problem: `Invalid input: expected object, received ${describe(args)}` };
  const out: Record<string, unknown> = {};
  const problems: string[] = [];
  for (const [name, field] of Object.entries(shape)) {
    const r = field.check((args as Record<string, unknown>)[name]);
    if ("problem" in r) problems.push(`${r.problem} at ${name}`);
    else if (r.value !== undefined) out[name] = r.value;
  }
  return problems.length > 0 ? { problem: problems.join("; ") } : { value: out as Output<S> };
}

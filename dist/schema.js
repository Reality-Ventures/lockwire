/**
 * The few argument types lockwire's MCP tools take (strings, booleans, a choice from a list, lists of
 * strings, each optionally), with what the protocol needs of them: checking a value, and the JSON Schema
 * a tool listing shows the model. Small enough to write out, so the server needs no schema library.
 */
const describe = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);
function make(json, check, required = true) {
    return {
        json,
        required,
        check: (value) => value === undefined
            ? required
                ? { problem: "Invalid input: expected a value, received undefined" }
                : { value: undefined }
            : check(value),
        optional: () => make(json, check, false),
    };
}
const typed = (type) => make({ type }, (v) => typeof v === type
    ? { value: v }
    : { problem: `Invalid input: expected ${type}, received ${describe(v)}` });
export const s = {
    string: () => typed("string"),
    boolean: () => typed("boolean"),
    enum: (values) => make({ type: "string", enum: [...values] }, (v) => typeof v === "string" && values.includes(v)
        ? { value: v }
        : { problem: `Invalid option: expected one of ${values.map((x) => `"${x}"`).join("|")}` }),
    array: (item) => make({ type: "array", items: item.json }, (v) => {
        if (!Array.isArray(v))
            return { problem: `Invalid input: expected array, received ${describe(v)}` };
        const out = [];
        for (const [i, element] of v.entries()) {
            const r = item.check(element);
            if ("problem" in r)
                return { problem: `${r.problem} at ${i}` };
            out.push(r.value);
        }
        return { value: out };
    }),
};
/** The JSON Schema for a tool's arguments. */
export function objectJson(shape) {
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
export function parseObject(shape, args) {
    if (args === null || typeof args !== "object" || Array.isArray(args))
        return { problem: `Invalid input: expected object, received ${describe(args)}` };
    const out = {};
    const problems = [];
    for (const [name, field] of Object.entries(shape)) {
        const r = field.check(args[name]);
        if ("problem" in r)
            problems.push(`${r.problem} at ${name}`);
        else if (r.value !== undefined)
            out[name] = r.value;
    }
    return problems.length > 0 ? { problem: problems.join("; ") } : { value: out };
}
//# sourceMappingURL=schema.js.map
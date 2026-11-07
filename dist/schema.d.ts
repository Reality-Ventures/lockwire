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
    check(value: unknown): {
        value: T;
    } | {
        problem: string;
    };
    optional(): Schema<T | undefined>;
}
export declare const s: {
    string: () => Schema<string>;
    boolean: () => Schema<boolean>;
    enum: <const V extends readonly string[]>(values: V) => Schema<V[number]>;
    array: <T>(item: Schema<T>) => Schema<T[]>;
};
export type Shape = Record<string, Schema<any>>;
type Optional<S extends Shape> = {
    [K in keyof S]: undefined extends Output1<S[K]> ? K : never;
}[keyof S];
type Output1<X> = X extends Schema<infer T> ? T : never;
/** What a tool's handler receives: each argument's type, with the optional ones optional. */
export type Output<S extends Shape> = {
    [K in Exclude<keyof S, Optional<S>>]: Output1<S[K]>;
} & {
    [K in Optional<S>]?: Output1<S[K]>;
};
/** The JSON Schema for a tool's arguments. */
export declare function objectJson(shape: Shape): Record<string, unknown>;
/** Checks a tool call's arguments against its shape: the arguments, or every problem found. */
export declare function parseObject<S extends Shape>(shape: S, args: unknown): {
    value: Output<S>;
} | {
    problem: string;
};
export {};
//# sourceMappingURL=schema.d.ts.map
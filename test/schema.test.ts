import { describe, expect, it } from "vitest";
import { objectJson, parseObject, s } from "../src/schema.js";

const shape = {
  path: s.string(),
  symbol: s.string().optional(),
  resolution: s.enum(["updated", "superseded"]),
  anchors: s.array(s.string()).optional(),
  dryRun: s.boolean().optional(),
};

describe("tool argument schemas", () => {
  it("describe themselves as the JSON Schema a tool listing shows", () => {
    expect(objectJson(shape)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: {
        path: { type: "string" },
        symbol: { type: "string" },
        resolution: { type: "string", enum: ["updated", "superseded"] },
        anchors: { type: "array", items: { type: "string" } },
        dryRun: { type: "boolean" },
      },
      required: ["path", "resolution"],
    });
    expect(objectJson({ a: s.string().optional() })).not.toHaveProperty("required");
  });

  it("accept a call, leaving out arguments that weren't given", () => {
    expect(parseObject(shape, { path: "a.ts", resolution: "updated", anchors: ["x"] })).toEqual({
      value: { path: "a.ts", resolution: "updated", anchors: ["x"] },
    });
  });

  it("name every problem with a call", () => {
    expect(parseObject(shape, { path: 5, resolution: "other", anchors: ["x", 2] })).toEqual({
      problem:
        'Invalid input: expected string, received number at path; Invalid option: expected one of "updated"|"superseded" at resolution; Invalid input: expected string, received number at 1 at anchors',
    });
    expect(parseObject(shape, {})).toMatchObject({ problem: expect.stringContaining("at path") });
    expect(parseObject(shape, "nope")).toEqual({ problem: "Invalid input: expected object, received string" });
    expect(parseObject(shape, [])).toMatchObject({ problem: expect.stringContaining("received array") });
  });
});

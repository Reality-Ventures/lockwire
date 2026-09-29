import { describe, expect, it } from "vitest";
import { nextVersion } from "../scripts/next-version.mjs";

describe("nextVersion", () => {
  it("publishes package.json's version as-is when npm doesn't have it yet", () => {
    expect(nextVersion("0.1.0", [])).toBe("0.1.0");
    expect(nextVersion("0.2.0", ["0.1.0", "0.1.4"])).toBe("0.2.0");
  });

  it("bumps the patch above the highest published version on the same line", () => {
    expect(nextVersion("0.1.0", ["0.1.0"])).toBe("0.1.1");
    expect(nextVersion("0.1.0", ["0.1.0", "0.1.1", "0.1.5"])).toBe("0.1.6");
  });

  it("ignores other minor lines and prereleases when picking the next patch", () => {
    expect(nextVersion("0.1.0", ["0.1.0", "0.2.9", "0.1.3-next.1"])).toBe("0.1.1");
  });

  it("refuses a non-x.y.z base instead of publishing a mangled version", () => {
    expect(() => nextVersion("0.1.0-beta.1", ["0.1.0-beta.1"])).toThrow(/plain x\.y\.z/);
  });
});

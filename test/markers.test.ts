import { describe, expect, it } from "vitest";
import { scanMarkers, stampMarkerLine } from "../src/markers.js";

describe("scanMarkers", () => {
  it("parses target, tiers, and captures the following paragraph as the claim", () => {
    const doc = [
      "# Auth",
      "",
      "<!-- lockwire src/auth/session.ts#createSession sig -->",
      "`createSession` takes a `UserId` and returns a `Session` valid for 24 hours.",
      "",
      "Some unrelated prose.",
    ].join("\n");
    const markers = scanMarkers(doc);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      target: { path: "src/auth/session.ts", symbol: "createSession" },
      tiers: ["sig"],
      id: null,
      claimLine: 4,
    });
    expect(markers[0]!.claimExcerpt).toContain("createSession");
  });

  it("captures a fenced code block in full as the claim", () => {
    const doc = ["<!-- lockwire src/cli.ts -->", "```bash", "lockwire check", "```", ""].join("\n");
    const markers = scanMarkers(doc);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.claimExcerpt).toContain("lockwire check");
  });

  it("reads a previously stamped id", () => {
    const doc = "<!-- lockwire src/x.ts#f sig id=ab3k9q1z -->\nSome claim.";
    const markers = scanMarkers(doc);
    expect(markers[0]!.id).toBe("ab3k9q1z");
  });

  it("stampMarkerLine appends an id without disturbing existing tiers", () => {
    const stamped = stampMarkerLine("<!-- lockwire src/x.ts#f sig -->", "ab3k9q1z");
    expect(stamped).toBe("<!-- lockwire src/x.ts#f sig id=ab3k9q1z -->");
  });

  it("ignores non-marker HTML comments", () => {
    expect(scanMarkers("<!-- just a comment -->\ntext")).toHaveLength(0);
  });
});

describe("scanMarkers and fenced code blocks", () => {
  const M = "<!-- lockwire src/a.ts#alpha sig -->";
  const ids = (doc: string) => scanMarkers(doc).map((m) => m.target.symbol);

  it("ignores markers inside backtick and tilde fences", () => {
    expect(ids(["```markdown", M, "claim.", "```"].join("\n"))).toEqual([]);
    expect(ids(["~~~", M, "claim.", "~~~"].join("\n"))).toEqual([]);
  });

  it("picks the real marker back up after the fence closes", () => {
    const doc = ["```md", M, "example.", "```", "", M.replace("alpha", "beta"), "Real claim."].join("\n");
    expect(ids(doc)).toEqual(["beta"]);
  });

  it("only a fence of the same character and at least the same length closes it", () => {
    const doc = ["````md", "```", M, "still inside", "```", "````", M.replace("alpha", "beta"), "Real."].join("\n");
    expect(ids(doc)).toEqual(["beta"]);
    expect(ids(["```", "~~~", M, "inside.", "```"].join("\n"))).toEqual([]);
  });

  it("treats an indented fence (inside a list item) as a fence", () => {
    expect(ids(["- item", "  ```md", `  ${M}`, "  claim.", "  ```"].join("\n"))).toEqual([]);
  });

  it("does not mistake inline triple-backtick code for a fence", () => {
    const doc = ["Use ```code``` inline.", "", M, "Real claim."].join("\n");
    expect(ids(doc)).toEqual(["alpha"]);
  });

  it("an unclosed fence swallows the rest of the document, as in CommonMark", () => {
    expect(ids(["```md", M, "claim."].join("\n"))).toEqual([]);
  });

  it("a marker outside a fence can still have a fenced code block as its claim", () => {
    const doc = [M, "```ts", "export function alpha(): void {}", "```"].join("\n");
    const [m] = scanMarkers(doc);
    expect(m?.target.symbol).toBe("alpha");
    expect(m?.claimExcerpt).toContain("export function alpha");
  });
});

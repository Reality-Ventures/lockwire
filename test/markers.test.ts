import { describe, expect, it } from "vitest";
import { claimUnchanged, EXCERPT_MAX, scanMarkers, stampMarkerLine } from "../src/markers.js";

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

describe("scanMarkers with stacked and adjacent markers", () => {
  const m = (sym: string) => `<!-- lockwire src/a.ts#${sym} sig -->`;
  const SENTENCE = "`alpha` and `beta` are related.";

  it("every marker stacked above one sentence binds that sentence, and none is part of it", () => {
    const found = scanMarkers([m("alpha"), m("beta"), m("gamma"), SENTENCE].join("\n"));
    expect(found.map((x) => x.target.symbol)).toEqual(["alpha", "beta", "gamma"]);
    for (const x of found) {
      expect(x.claimExcerpt).toBe(SENTENCE);
      expect(x.claimLine).toBe(4);
      expect(x.claimHash).toBe(found[0]?.claimHash);
    }
  });

  it("blank lines between stacked markers don't change that", () => {
    const found = scanMarkers([m("alpha"), "", m("beta"), "", SENTENCE].join("\n"));
    expect(found.map((x) => x.claimExcerpt)).toEqual([SENTENCE, SENTENCE]);
  });

  it("stamping one marker's id never changes another marker's claim hash", () => {
    const before = scanMarkers([m("alpha"), m("beta"), SENTENCE].join("\n"));
    const after = scanMarkers([stampMarkerLine(m("alpha"), "AAAA1111"), m("beta"), SENTENCE].join("\n"));
    expect(after[1]?.claimHash).toBe(before[1]?.claimHash);
    expect(after[0]?.claimHash).toBe(before[0]?.claimHash);
  });

  it("a marker directly after a paragraph (no blank line) ends that paragraph and starts the next claim", () => {
    const found = scanMarkers(["<!-- lockwire src/a.ts#alpha sig -->", "First claim.", m("beta"), "Second claim."].join("\n"));
    expect(found.map((x) => x.claimExcerpt)).toEqual(["First claim.", "Second claim."]);
  });

  it("stacked markers with no sentence beneath them bind nothing", () => {
    expect(scanMarkers([m("alpha"), m("beta")].join("\n"))).toEqual([]);
    expect(scanMarkers([m("alpha"), m("beta"), ""].join("\n"))).toEqual([]);
  });

  it("stacked markers above a fenced code block claim all capture the whole block", () => {
    const found = scanMarkers([m("alpha"), m("beta"), "```ts", "const x = 1;", "```"].join("\n"));
    expect(found).toHaveLength(2);
    for (const x of found) expect(x.claimExcerpt).toContain("const x = 1;");
  });

  it("a single marker's claim is unchanged by the stacking logic", () => {
    const [x] = scanMarkers(["# T", "", m("alpha"), "Line one", "line two.", "", "Other."].join("\n"));
    expect(x?.claimExcerpt).toBe("Line one line two.");
  });
});

describe("claim excerpts", () => {
  const first = (claim: string) => scanMarkers(`<!-- lockwire src/a.ts#f sig -->\n${claim}\n`)[0]!;

  it("never cut an emoji in half when truncating", () => {
    for (const pad of [86, 87, 88, 89, 90]) {
      const m = first(`${"x".repeat(pad)}\u{1F600} and a long tail that overflows the excerpt for sure`);
      expect(m.claimExcerpt.isWellFormed()).toBe(true);
      expect(m.claimExcerpt.endsWith("…")).toBe(true);
      expect(m.claimExcerpt.length).toBeLessThanOrEqual(EXCERPT_MAX);
    }
  });

  it("leave short claims whole, and cut only long ones", () => {
    expect(first("Short.").claimExcerpt).toBe("Short.");
    expect(first("y".repeat(EXCERPT_MAX)).claimExcerpt).toBe("y".repeat(EXCERPT_MAX));
    expect(first("y".repeat(EXCERPT_MAX + 1)).claimExcerpt).toHaveLength(EXCERPT_MAX);
  });
});

describe("claimUnchanged for anchors stamped before normHash existed", () => {
  const scan = (text: string) =>
    scanMarkers(`<!-- lockwire src/a.ts#f sig -->\n${text}\n`)[0]!;
  const legacy = (text: string) => {
    const m = scan(text);
    return { line: 2, hash: m.claimHash, excerpt: m.claimExcerpt };
  };

  it("a short claim that literally ends in an ellipsis survives a re-wrap", () => {
    const stored = legacy("`createSession` returns quickly, usually…");
    expect(claimUnchanged(stored, scan("`createSession` returns quickly,\nusually…"))).toBe(true);
  });

  it("a short claim still flags a real edit", () => {
    const stored = legacy("`createSession` returns quickly, usually…");
    expect(claimUnchanged(stored, scan("`createSession` returns slowly, usually…"))).toBe(false);
  });

  it("a genuinely truncated excerpt can't vouch for a re-wrap, so it falls back to the raw hash", () => {
    const long = `${"word ".repeat(40)}end.`;
    const stored = legacy(long);
    expect(stored.excerpt.endsWith("…")).toBe(true);
    expect(claimUnchanged(stored, scan(long.replace("word word", "word\nword")))).toBe(false);
    expect(claimUnchanged(stored, scan(long))).toBe(true);
  });
});

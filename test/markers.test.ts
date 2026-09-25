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

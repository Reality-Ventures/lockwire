/**
 * How a sentence's numbers are read, and how LaTeX values are parsed — the parts of value anchors
 * that decide whether a true sentence passes and a false one is caught.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { check, linkDoc, linkLockfileOnly } from "../src/actions.js";
import { scanMarkers } from "../src/markers.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import { checkClaimAgainstValue, claimNumbers, resolveValue } from "../src/values.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const actor = { type: "human" as const };
const values = (s: string) => claimNumbers(s).map((n) => n.value);
const holds = (claim: string, value: unknown) => checkClaimAgainstValue(claim, value).matches;

describe("claimNumbers: units, identifiers, versions and ordinals", () => {
  it("a unit glued to a number states that number, never just its integer part", () => {
    expect(values("p50 latency is 12.5ms.")).toEqual([12.5]);
    expect(values("p99 latency is 40ms.")).toEqual([40]);
    expect(values("the speedup is 0.18x.")).toEqual([0.18]);
    expect(values("it runs at 3.5GHz.")).toEqual([3.5]);
    expect(claimNumbers("p50 latency is 12.5ms.")[0]?.text).toBe("12.5ms");
    expect(holds("p50 latency is 12.5ms.", 12.1)).toBe(false);
    expect(holds("the speedup is 0.18x.", 0.45)).toBe(false);
  });

  it("identifiers, versions and ordinals state nothing", () => {
    for (const s of ["see column 0.18_lo.", "address 0x1F", "upgrade to 1.2.3 now", "the 2nd and 3rd epochs", "v2 on x86"])
      expect(values(s), s).toEqual([]);
  });

  it("a comma run that isn't a thousands pattern is a list of numbers", () => {
    expect(values("seeds 1,2,3 were used")).toEqual([1, 2, 3]);
    expect(values("1,024 samples")).toEqual([1024]);
  });
});

describe("claimNumbers: magnitudes", () => {
  it("k, M, B, bn, T and the words scale the number, and precision is kept in those units", () => {
    expect(values("1.2B tokens, 3.5k rows, 10M params, 2bn users, 1T flops")).toEqual([1.2e9, 3500, 1e7, 2e9, 1e12]);
    expect(values("about 2 million downloads and 1.5 billion views")).toEqual([2e6, 1.5e9]);
    expect(holds("trained on 1.2B tokens", 1_240_000_000)).toBe(true);
    expect(holds("trained on 1.2B tokens", 1_260_000_000)).toBe(false);
    expect(holds("about 2 million downloads", 2_400_000)).toBe(true);
    expect(holds("about 2 million downloads", 2_600_000)).toBe(false);
  });

  it("a unit that only starts with a magnitude letter isn't one", () => {
    expect(values("a 10ms budget and 4MB of memory")).toEqual([10, 4]);
  });
});

describe("claimNumbers: signs and ranges", () => {
  it("a hyphen between numbers is a range; a minus after a space or bracket is a sign", () => {
    expect(values("the interval is 0.18-0.24")).toEqual([0.18, 0.24]);
    expect(values("CI 15--29")).toEqual([15, 29]); // LaTeX's en dash
    expect(values("the interval is 0.18–0.24")).toEqual([0.18, 0.24]);
    expect(values("a −0.5 shift, a (-3) offset, x=-2 and ~-1")).toEqual([-0.5, -3, -2, -1]);
    expect(holds("a shift of -0.18", 0.18)).toBe(false);
    expect(holds("CI 15--29", -29)).toBe(false);
  });
});

describe("claimNumbers: scientific notation and exact counts", () => {
  it("scientific notation commits to the precision of its mantissa", () => {
    expect(holds("we evaluate 1.5e3 prompts", 1523)).toBe(true);
    expect(holds("we evaluate 1.5e3 prompts", 1600)).toBe(false);
    expect(holds("about 2e6 tokens", 2_100_000)).toBe(true);
    expect(holds("a rate of 2.5e-3", 0.0025)).toBe(true);
    expect(holds("a rate of 2.5e-3", 0.0027)).toBe(false);
    expect(claimNumbers("1.5e3")[0]?.decimals).toBe(-2);
  });

  it("an integer count is held to the unit however large; float error is the only slack", () => {
    expect(holds("we processed 5,000,000,000 rows", 5_000_000_004)).toBe(false);
    expect(holds("we processed 5,000,000,000 rows", 5_000_000_000)).toBe(true);
    expect(holds("trained on 1,000,000,000,000 tokens", 1_000_000_000_900)).toBe(false);
    expect(holds("the sum is 0.3", 0.1 + 0.2)).toBe(true); // 0.30000000000000004
  });
});

describe("LaTeX values", () => {
  const get = (tex: string, key: string) => resolveValue(tex, "tex", key);

  it("ignores commented-out definitions and comments after a real one", () => {
    const tex = String.raw`\newcommand{\lo}{0.18}
% \renewcommand{\lo}{0.25}  % kept for reference
% \newcommand{\ghost}{1}
\newcommand{\acc}{91.2\%} % a comment after an escaped percent
\newcommand{\slash}{a\\%b}
`;
    expect(get(tex, "lo").value).toBe(0.18);
    expect(get(tex, "ghost").found).toBe(false);
    expect(get(tex, "acc").value).toBe(91.2);
    expect(get(tex, "slash").found).toBe(false); // `\\%` is a line break then a comment: unterminated
  });

  it("\\providecommand never replaces a definition; the others do, last one wins", () => {
    const tex = "\\newcommand{\\n}{3}\n\\providecommand{\\n}{5}\n\\providecommand{\\m}{7}\n\\renewcommand{\\k}{1}\n\\renewcommand{\\k}{2}\n";
    expect(get(tex, "n").value).toBe(3);
    expect(get(tex, "m").value).toBe(7);
    expect(get(tex, "k").value).toBe(2);
  });

  it("an unterminated body at the end of the file defines nothing (never a truncated number)", () => {
    expect(get("\\newcommand{\\lo}{0.18", "lo").found).toBe(false);
    expect(get("\\newcommand{\\a}{1}\n\\newcommand{\\lo}{0.1{8", "a").value).toBe(1);
  });

  it("unwraps wrappers in any combination", () => {
    expect(get("\\newcommand{\\a}{\\num{91.2}\\%}", "a").value).toBe(91.2);
    expect(get("\\newcommand{\\a}{$91.2\\%$}", "a").value).toBe(91.2);
    expect(get("\\newcommand{\\a}{\\ensuremath{\\num{0.18}}}", "a").value).toBe(0.18);
  });
});

describe("string values that hold several numbers (generated macros like a share and its CI)", () => {
  const CI = "21\\%; 95\\% CI 15--29\\%";

  it("a sentence stating all of them holds; one that gets any of them wrong doesn't", () => {
    expect(holds("The share deviating was 21% (95% CI 15–29%).", CI)).toBe(true);
    expect(holds("The share deviating was 21% (95% CI 15-29%).", CI)).toBe(true);
    expect(holds("The share deviating was 22% (95% CI 15–29%).", CI)).toBe(false);
    expect(holds("The share deviating was 21% (95% CI 15–30%).", CI)).toBe(false);
    expect(holds("The share deviating was 21%.", CI)).toBe(false); // the CI is part of the value
  });

  it("compares at the coarser precision, since a generated value is itself rounded", () => {
    expect(holds("The share deviating was 21.4% (95% CI 15–29%).", CI)).toBe(true);
    expect(holds("a mean of 3.42 (SD 1.1)", "3.4 (SD 1.1)")).toBe(true);
    expect(holds("a mean of 3.62 (SD 1.1)", "3.4 (SD 1.1)")).toBe(false);
  });

  it("a sentence with no numbers can't be checked against it; a date value is checked by its numbers", () => {
    expect(checkClaimAgainstValue("The share is reported in the paper.", CI).checkable).toBe(false);
    expect(holds("The first report was on 25 September 2026.", "25 September 2026")).toBe(true);
    expect(holds("The first report was on 26 September 2026.", "25 September 2026")).toBe(false);
  });

  it("a string with no numbers is still checked by containment", () => {
    expect(holds("The reference model is baseline-v2.", "baseline-v2")).toBe(true);
    expect(holds("The reference model is baseline-v3.", "baseline-v2")).toBe(false);
  });

  it("end to end: link binds the true sentence, and check flags it when the macro changes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-compound-"));
    await mkdir(join(dir, "paper"));
    await writeFile(join(dir, "paper", "numbers.tex"), `\\newcommand{\\CIDevRelevant}{${CI}}\n`, "utf8");
    await writeFile(
      join(dir, "CLAUDE.md"),
      "# R\n\n<!-- lockwire paper/numbers.tex#CIDevRelevant -->\nThe share deviating was 21% (95% CI 15–29%).\n",
      "utf8",
    );
    expect((await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, actor)).created).toBe(1);
    expect((await check(dir, DEFAULT_CONFIG)).summary.drifted).toBe(0);
    await writeFile(join(dir, "paper", "numbers.tex"), "\\newcommand{\\CIDevRelevant}{19\\%; 95\\% CI 13--27\\%}\n", "utf8");
    const [r] = (await check(dir, DEFAULT_CONFIG)).results;
    expect(r?.status).toBe("drifted");
    expect(r?.value?.matches).toBe(false);
  });
});

describe("a tier the target can't produce is refused, not stamped as an anchor that can never drift", () => {
  async function repo() {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-tiers-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "export function alpha(x: number): number {\n  return x + 1;\n}\n", "utf8");
    await writeFile(join(dir, "m.json"), '{"ci":{"lo":0.18}}', "utf8");
    return dir;
  }
  const doc = (marker: string, sentence = "The lower bound is 0.18.") => `# R\n\n${marker}\n${sentence}\n`;

  it.each([
    ["value on a code symbol", "<!-- lockwire src/a.ts#alpha value -->", "value"],
    ["sig on a data key", "<!-- lockwire m.json#ci.lo sig -->", "sig"],
    ["body and deps on a data key", "<!-- lockwire m.json#ci.lo body,deps -->", "body, deps"],
    ["value on a whole data file", "<!-- lockwire m.json value -->", "value"],
  ])("%s", async (_n, marker, bad) => {
    const dir = await repo();
    await writeFile(join(dir, "CLAUDE.md"), doc(marker), "utf8");
    const r = await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, actor);
    expect(r.created).toBe(0);
    expect(r.skipped[0]?.reason).toMatch(new RegExp(`^tiers? ${bad} can't apply to `));
  });

  it("the tiers a target can produce still link", async () => {
    const dir = await repo();
    await writeFile(
      join(dir, "CLAUDE.md"),
      `${doc("<!-- lockwire m.json#ci.lo value,path -->")}\n${doc("<!-- lockwire src/a.ts#alpha path,sig,body,deps -->", "alpha adds one.")}\n${doc("<!-- lockwire m.json path,body -->", "All metrics are in m.json.")}`,
      "utf8",
    );
    expect((await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, actor)).created).toBe(3);
  });

  it("a lockfile-only binding with an impossible tier is an error", async () => {
    const dir = await repo();
    await writeFile(join(dir, "CLAUDE.md"), "# R\n", "utf8");
    await expect(
      linkLockfileOnly(dir, "CLAUDE.md", { path: "src/a.ts", symbol: "alpha" }, ["value"], DEFAULT_CONFIG, actor),
    ).rejects.toThrow(/can't apply to src\/a.ts#alpha/);
  });

  it.skipIf(!existsSync(CLI))("and through the CLI", async () => {
    const dir = await repo();
    await writeFile(join(dir, "CLAUDE.md"), "# R\n", "utf8");
    const r = spawnSync(process.execPath, [CLI, "link", "CLAUDE.md", "src/a.ts#alpha", "--tiers", "value"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/can't apply to src\/a.ts#alpha, which can bind path, sig, body, deps/);
  });
});

describe("marker targets are normalised", () => {
  it("./src/a.ts, src/./a.ts and src//a.ts are all src/a.ts", () => {
    for (const t of ["./src/a.ts", "src/./a.ts", "src//a.ts", "././src/a.ts"]) {
      const [m] = scanMarkers(`<!-- lockwire ${t}#alpha sig -->\nA claim.\n`);
      expect(m?.target, t).toEqual({ path: "src/a.ts", symbol: "alpha" });
    }
  });

  it("a ./-spelled marker links to src/a.ts, so the hooks and claims_for find it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lockwire-dotslash-"));
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "export function alpha(): void {}\n", "utf8");
    await writeFile(join(dir, "CLAUDE.md"), "# R\n\n<!-- lockwire ./src/a.ts#alpha sig -->\nalpha exists.\n", "utf8");
    await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, actor);
    const lock = JSON.parse(await readFile(join(dir, "lockwire.lock"), "utf8"));
    expect(lock.anchors[0].target).toEqual({ path: "src/a.ts", symbol: "alpha" });
  });
});

describe("numbers that don't state the value (found on benchmark READMEs)", () => {
  it("references, footnotes and citations state nothing", () => {
    for (const s of [
      "As Table 1 shows",
      "see Section 2.3 and Fig. 4",
      "by Eq. (3) and §5",
      "on p. 12 of Appendix 2",
      "as reported[^1]",
      "as reported [12]",
    ])
      expect(values(s), s).toEqual([]);
    // ...so a reference can't mask a wrong value any more.
    expect(holds("In Table 1, o3-high reaches an MMLU accuracy of 0.933.", 0.71)).toBe(false);
    expect(holds("In Table 1, o3-high reaches an MMLU accuracy of 0.933.", 0.9331)).toBe(true);
  });

  it("numbers inside hyphenated names state nothing", () => {
    for (const s of ["gpt-4.1-2025-04-14", "Llama-3-70B", "top-1 accuracy", "COVID-19"])
      expect(values(s), s).toEqual([]);
    expect(values("gpt-4.1 scores 0.83 and the interval is 0.18-0.24")).toEqual([0.83, 0.18, 0.24]);
    expect(values("a 3-layer MLP")).toEqual([3]); // a count before the hyphen still counts
  });

  it("markdown emphasis with underscores doesn't hide a number", () => {
    expect(values("The upper bound is __0.50__.")).toEqual([0.5]);
    expect(values("accuracy _0.93_")).toEqual([0.93]);
    expect(values("see x_2 and 0.18_lo")).toEqual([]);
  });

  it("a minus in a table cell or list is a sign", () => {
    expect(values("| -0.18 |")).toEqual([-0.18]);
    expect(values("|-0.18|")).toEqual([-0.18]);
    expect(values("deltas 0.2,-0.3")).toEqual([0.2, -0.3]);
    expect(holds("|-0.18|", 0.18)).toBe(false);
  });

  it("\\pm in the sentence or the value states both numbers", () => {
    expect(values("$0.18\\pm0.02$")).toEqual([0.18, 0.02]);
    expect(holds("0.18 ± 0.02", "$0.18\\pm0.02$")).toBe(true);
    expect(holds("0.18 ± 0.09", "$0.18\\pm0.02$")).toBe(false);
  });
});

describe("LaTeX number formats (found on real papers)", () => {
  const get = (tex: string, key: string) => resolveValue(tex, "tex", key);
  it("{,} is a decimal comma unless three digits follow", () => {
    expect(get("\\newcommand{\\a}{0{,}18}", "a").value).toBe(0.18);
    expect(get("\\newcommand{\\a}{1{,}5}", "a").value).toBe(1.5);
    expect(get("\\newcommand{\\a}{12{,}345}", "a").value).toBe(12345);
    expect(get("\\newcommand{\\a}{12{,}345{,}678}", "a").value).toBe(12345678);
  });

  it("\\num and \\SI with options are unwrapped", () => {
    expect(get("\\newcommand{\\a}{\\num[round-precision=2]{0.1834}}", "a").value).toBe(0.1834);
    expect(get("\\newcommand{\\a}{\\SI[per-mode=symbol]{12.5}{ms}}", "a").value).toBe(12.5);
    expect(holds("The value is 0.18.", "\\num[round-precision=2]{0.1834}")).toBe(true);
  });
});

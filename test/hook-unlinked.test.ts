import { spawnSync } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { linkDoc } from "../src/actions.js";
import { buildAdvisoryText, unlinkedClaimsFor } from "../src/hook-common.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const A_TS = "export function alpha(x: number): number {\n  return x + 1;\n}\n";
const M = (target = "src/a.ts#alpha") => `<!-- lockwire ${target} sig -->`;
const doc = (target: string, sentence: string) => `# D\n\n${M(target)}\n${sentence}\n`;

async function repo(files: Record<string, string>, config?: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-hookunlinked-"));
  await mkdir(join(dir, ".git"));
  await mkdir(join(dir, "src"));
  await writeFile(join(dir, "src", "a.ts"), A_TS, "utf8");
  await writeFile(join(dir, "src", "b.ts"), "export const b = 1;\n", "utf8");
  // a repo that has opted into lockwire (the hooks are inert anywhere that hasn't)
  await writeFile(join(dir, "lockwire.lock"), '{"version":1,"anchors":[]}', "utf8");
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, rel)), { recursive: true });
    await writeFile(join(dir, rel), content, "utf8");
  }
  if (config) {
    await mkdir(join(dir, ".lockwire"), { recursive: true });
    await writeFile(join(dir, ".lockwire", "config.json"), JSON.stringify({ version: 1, ...config }), "utf8");
  }
  return dir;
}
const hook = (dir: string, adapter: "claude-pre" | "codex-pre", file = "src/a.ts") => {
  const input =
    adapter === "codex-pre"
      ? { tool_name: "apply_patch", tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n` }, cwd: dir }
      : { tool_name: "Edit", tool_input: { file_path: join(dir, file) }, cwd: dir };
  const r = spawnSync(process.execPath, [CLI, "hook", adapter], { cwd: dir, input: JSON.stringify(input), encoding: "utf8" });
  const out = r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
  return { status: r.status, out, text: (out?.additionalContext ?? "") as string };
};
const ADAPTERS = ["claude-pre", "codex-pre"] as const;

describe.skipIf(!existsSync(CLI))("PreToolUse also surfaces claims nobody has linked", () => {
  it.each(ADAPTERS)("%s: an unlinked claim about the file is shown with its sentence, even when nothing is anchored", async (adapter) => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "alpha is only ever called with positive numbers.") });
    const r = hook(dir, adapter);
    expect(r.status).toBe(0);
    expect(r.text).toContain("also make claims about this code that nobody has linked");
    expect(r.text).toContain('- NOTES.md:3 asserts "alpha is only ever called with positive numbers." about src/a.ts#alpha (not linked yet)');
    expect(r.text).toContain("Run `lockwire link NOTES.md`");
    expect(r.text).not.toContain("documentation makes claims about this code"); // no anchored section
  });

  it.each(ADAPTERS)("%s: with both, the anchored claims come first and the unlinked ones follow", async (adapter) => {
    const dir = await repo({
      "CLAUDE.md": doc("src/a.ts#alpha", "alpha adds one."),
      "NOTES.md": doc("src/a.ts#alpha", "alpha never throws."),
    });
    await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });
    const r = hook(dir, adapter);
    const anchored = r.text.indexOf("documentation makes claims about this code");
    const unlinked = r.text.indexOf("nobody has linked");
    expect(anchored).toBeGreaterThanOrEqual(0);
    expect(unlinked).toBeGreaterThan(anchored);
    expect(r.text).toContain("CLAUDE.md asserts");
    expect(r.text).toContain("NOTES.md:3 asserts");
  });

  it.each(ADAPTERS)("%s: an edit with no claims of either kind is silent and writes no log", async (adapter) => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "about alpha.") });
    const r = hook(dir, adapter, "src/b.ts");
    expect(r.status).toBe(0);
    expect(r.out).toBeNull();
    expect(existsSync(join(dir, ".lockwire", "hook.log"))).toBe(false);
  });

  it("only claims about THIS file: other files, look-alike paths, excluded and vendored docs, and fenced examples don't appear", async () => {
    const dir = await repo({
      "other.md": doc("src/b.ts#b", "about b."),
      "lookalike.md": doc("src/a.tsx#alpha", "about a.tsx."),
      "CHANGELOG.md": doc("src/a.ts#alpha", "excluded by default."),
      "node_modules/pkg/README.md": doc("src/a.ts#alpha", "vendored."),
      "README.md": `# R\n\n\`\`\`markdown\n${M()}\nan example.\n\`\`\`\n`,
    });
    expect(hook(dir, "claude-pre").out).toBeNull();
  });

  it("an unlinked claim that is already linked isn't repeated as unlinked, and linking removes it", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "about alpha.") });
    expect(hook(dir, "claude-pre").text).toContain("nobody has linked");
    await linkDoc(dir, "NOTES.md", DEFAULT_CONFIG, { type: "human" });
    const after = hook(dir, "claude-pre").text;
    expect(after).not.toContain("nobody has linked");
    expect(after).toContain("NOTES.md asserts");
  });

  it("is capped by hook.maxClaimsInContext, with the rest summarised", async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 5; i++) files[`n${i}.md`] = doc("src/a.ts#alpha", `claim number ${i}.`);
    const dir = await repo(files, { hook: { maxClaimsInContext: 2 } });
    const text = hook(dir, "claude-pre").text;
    expect(text.match(/asserts "claim number/g)).toHaveLength(2);
    expect(text).toContain("…and 3 more.");
  });

  it("works when the session started above the repo (the edited file picks the root)", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "about alpha.") });
    const parent = dirname(dir);
    const input = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(dir, "src", "a.ts") }, cwd: parent });
    const r = spawnSync(process.execPath, [CLI, "hook", "claude-pre"], { cwd: parent, input, encoding: "utf8" });
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain("NOTES.md:3");
  });
});

describe.skipIf(!existsSync(CLI))("unlinked claims inform; only anchored claims can ask or block", () => {
  const files = { "NOTES.md": doc("src/a.ts#alpha", "about alpha.") };

  it.each(["ask", "deny"] as const)("claude-pre, mode %s: an unlinked claim alone sets no permission decision", async (mode) => {
    const dir = await repo(files, { hook: { mode } });
    const r = hook(dir, "claude-pre");
    expect(r.status).toBe(0);
    expect(r.text).toContain("nobody has linked");
    expect(r.out.permissionDecision).toBeUndefined();
  });

  it("codex-pre, mode deny: likewise", async () => {
    const dir = await repo(files, { hook: { mode: "deny" } });
    const r = hook(dir, "codex-pre");
    expect(r.text).toContain("nobody has linked");
    expect(r.out.permissionDecision).toBeUndefined();
  });

  it.each(["ask", "deny"] as const)("claude-pre, mode %s: an anchored claim still asks / blocks exactly as before, even with unlinked ones alongside", async (mode) => {
    const dir = await repo({ ...files, "CLAUDE.md": doc("src/a.ts#alpha", "alpha adds one.") }, { hook: { mode } });
    await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });
    const r = hook(dir, "claude-pre");
    expect(r.out.permissionDecision).toBe(mode);
    expect(r.text).toContain("nobody has linked");
  });

  it("codex-pre, mode deny: an anchored claim still blocks", async () => {
    const dir = await repo({ "CLAUDE.md": doc("src/a.ts#alpha", "alpha adds one.") }, { hook: { mode: "deny" } });
    await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });
    expect(hook(dir, "codex-pre").out.permissionDecision).toBe("deny");
  });
});

describe.skipIf(!existsSync(CLI))("hook.unlinkedClaims", () => {
  it("false turns the scan off: unlinked claims vanish and anchored ones are unaffected", async () => {
    const dir = await repo(
      { "CLAUDE.md": doc("src/a.ts#alpha", "alpha adds one."), "NOTES.md": doc("src/a.ts#alpha", "about alpha.") },
      { hook: { unlinkedClaims: false } },
    );
    await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });
    const text = hook(dir, "claude-pre").text;
    expect(text).toContain("CLAUDE.md asserts");
    expect(text).not.toContain("nobody has linked");

    const onlyUnlinked = await repo({ "NOTES.md": doc("src/a.ts#alpha", "about alpha.") }, { hook: { unlinkedClaims: false } });
    expect(hook(onlyUnlinked, "claude-pre").out).toBeNull();
  });

  it("an existing config without the key gets the default (on)", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "about alpha.") }, { hook: { mode: "advisory" } });
    expect(hook(dir, "claude-pre").text).toContain("nobody has linked");
  });
});

describe("the scan can't hurt the edit it's advising", () => {
  it("a blown time budget leaves the unlinked claims out, says so in hook.log, and doesn't throw", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "about alpha.") });
    const claims = await unlinkedClaimsFor(dir, DEFAULT_CONFIG, "src/a.ts", "claude-pre", -1);
    expect(claims).toEqual([]);
    const log = await readFile(join(dir, ".lockwire", "hook.log"), "utf8");
    expect(log).toContain("hit its -1ms budget");
    expect(log).toContain("hook.unlinkedClaims");
  });

  it("a generous budget finds them and logs nothing", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "about alpha.") });
    const claims = await unlinkedClaimsFor(dir, DEFAULT_CONFIG, "src/a.ts", "claude-pre", 10_000);
    expect(claims).toHaveLength(1);
    expect(existsSync(join(dir, ".lockwire", "hook.log"))).toBe(false);
  });

  it("the switch short-circuits before any scanning", async () => {
    const dir = await repo({ "NOTES.md": doc("src/a.ts#alpha", "about alpha.") });
    const off = { ...DEFAULT_CONFIG, hook: { ...DEFAULT_CONFIG.hook, unlinkedClaims: false } };
    expect(await unlinkedClaimsFor(dir, off, "src/a.ts", "claude-pre")).toEqual([]);
  });

  const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
  it.skipIf(!canChmod)("an unreadable doc is skipped, not fatal: everything else still comes through", async () => {
    const dir = await repo({
      "CLAUDE.md": doc("src/a.ts#alpha", "alpha adds one."),
      "NOTES.md": doc("src/a.ts#alpha", "a claim in a readable doc."),
      "locked.md": doc("src/a.ts#alpha", "can't be read."),
    });
    await linkDoc(dir, "CLAUDE.md", DEFAULT_CONFIG, { type: "human" });
    chmodSync(join(dir, "locked.md"), 0o000);
    try {
      const r = hook(dir, "claude-pre");
      expect(r.status).toBe(0);
      expect(r.text).toContain("CLAUDE.md asserts"); // anchored claims
      expect(r.text).toContain("NOTES.md:3 asserts"); // the readable unlinked claim
      expect(r.text).not.toContain("locked.md");
    } finally {
      chmodSync(join(dir, "locked.md"), 0o644);
    }
  });
});

describe("buildAdvisoryText", () => {
  it("is exactly the old text when there are no unlinked claims", () => {
    const text = buildAdvisoryText([], DEFAULT_CONFIG, []);
    expect(text).toBe("");
  });
});

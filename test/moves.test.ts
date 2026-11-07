import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { check, linkDoc, linkLockfileOnly, repoint } from "../src/actions.js";
import { formatGithub, formatText } from "../src/format.js";
import { readLedger } from "../src/ledger.js";
import { readLockfile } from "../src/lockfile.js";
import { sigFingerprints } from "../src/moves.js";
import { resolveModule } from "../src/reexports.js";
import { listTasks } from "../src/tasks.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const actor = { type: "human" as const };
const repos: string[] = [];

afterEach(async () => {
  for (const r of repos.splice(0)) await rm(r, { recursive: true, force: true });
});

async function repoWith(files: Record<string, string>) {
  const repo = await mkdtemp(join(tmpdir(), "lockwire-moves-"));
  repos.push(repo);
  await put(repo, files);
  return repo;
}

async function put(repo: string, files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content, "utf8");
  }
}

const RETRY_TS = `export function retryDelay(attempt: number): number {
  // back off, capped
  return Math.min(1500 * 2 ** attempt, 30000);
}

export function other(): void {}
`;

const DOC = `# Notes

<!-- lockwire src/net.ts#retryDelay body -->
\`retryDelay\` waits 1.5 s and doubles each attempt.
`;

async function movedRepo() {
  const repo = await repoWith({ "src/net.ts": RETRY_TS, "CLAUDE.md": DOC });
  expect((await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor)).created).toBe(1);
  // The function moves to its own module, unchanged apart from a comment and formatting.
  await put(repo, {
    "src/net.ts": "export function other(): void {}\n",
    "src/retry/delay.ts": `export function retryDelay(attempt: number): number {
  return Math.min(1500 * 2 ** attempt,
    30000);
}
`,
  });
  return repo;
}

describe("a symbol moved to another file", () => {
  it("check reports where its code went", async () => {
    const repo = await movedRepo();
    const result = await check(repo, DEFAULT_CONFIG, undefined, { write: false });
    const [r] = result.results;
    expect(r?.status).toBe("orphaned");
    expect(r?.moved).toEqual({
      to: { path: "src/retry/delay.ts", symbol: "retryDelay" },
      candidates: [{ path: "src/retry/delay.ts", symbol: "retryDelay" }],
    });
    expect(result.summary.moved).toBe(1);
    expect(formatText(result)).toContain("moved to src/retry/delay.ts#retryDelay");
    expect(formatText(result)).toContain("lockwire repoint");
    expect(formatGithub(result)).toContain(`lockwire repoint ${r?.anchor.id}`);
  });

  it("repoint re-points the anchor and rewrites the marker in one step", async () => {
    const repo = await movedRepo();
    const out = await repoint(repo, DEFAULT_CONFIG, actor);
    expect(out.skipped).toEqual([]);
    expect(out.repointed).toHaveLength(1);
    expect(out.repointed[0]).toMatchObject({
      from: { path: "src/net.ts", symbol: "retryDelay" },
      to: { path: "src/retry/delay.ts", symbol: "retryDelay" },
      status: "fresh",
      driftedTiers: [],
      markerUpdated: true,
      claimNamesOldPath: false,
    });
    const doc = await readFile(join(repo, "CLAUDE.md"), "utf8");
    expect(doc).toContain("<!-- lockwire src/retry/delay.ts#retryDelay body id=");
    const [anchor] = (await readLockfile(repo)).anchors;
    expect(anchor?.target).toEqual({ path: "src/retry/delay.ts", symbol: "retryDelay" });

    const after = await check(repo, DEFAULT_CONFIG);
    expect(after.summary).toMatchObject({ fresh: 1, orphaned: 0, drifted: 0, moved: 0 });
    expect(after.unlinked).toEqual([]);
    const events = (await readLedger(repo)).map((e) => e.event);
    expect(events).toContain("anchor.relocated");

    // Nothing left to do: a second run changes nothing.
    const again = await repoint(repo, DEFAULT_CONFIG, actor);
    expect(again).toEqual({ repointed: [], skipped: [] });
  });

  it("a whole file renamed is found the same way", async () => {
    const repo = await repoWith({ "src/net.ts": RETRY_TS, "CLAUDE.md": DOC });
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    await rm(join(repo, "src/net.ts"));
    await put(repo, { "src/network.ts": RETRY_TS });
    const [r] = (await check(repo, DEFAULT_CONFIG, undefined, { write: false })).results;
    expect(r?.moved?.to).toEqual({ path: "src/network.ts", symbol: "retryDelay" });
  });

  it("a helper that became exported on the way still counts as the same signature", async () => {
    const repo = await repoWith({
      "src/a.ts": "function helper(x: number): number {\n  return x * 2;\n}\nexport const y = 1;\n",
      "CLAUDE.md":
        "<!-- lockwire src/a.ts#helper sig,body -->\n`helper` doubles its argument.\n",
    });
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    await put(repo, {
      "src/a.ts": "export const y = 1;\n",
      "src/helpers.ts": "export function helper(x: number): number {\n  return x * 2;\n}\n",
    });
    const out = await repoint(repo, DEFAULT_CONFIG, actor);
    expect(out.repointed[0]).toMatchObject({ status: "fresh", driftedTiers: [] });
    expect((await check(repo, DEFAULT_CONFIG)).summary.fresh).toBe(1);
  });

  it("code that changed on the way is not a move", async () => {
    const repo = await movedRepo();
    await put(repo, {
      "src/retry/delay.ts":
        "export function retryDelay(attempt: number): number {\n  return 2000 * attempt;\n}\n",
    });
    const [r] = (await check(repo, DEFAULT_CONFIG, undefined, { write: false })).results;
    expect(r?.status).toBe("orphaned");
    expect(r?.moved).toBeUndefined();
    const out = await repoint(repo, DEFAULT_CONFIG, actor, { ids: [r?.anchor.id ?? ""] });
    expect(out.repointed).toEqual([]);
    expect(out.skipped[0]?.reason).toContain("--to");
  });

  it("an explicit --to re-points a moved-and-changed symbol, keeping the drift visible", async () => {
    const repo = await movedRepo();
    await put(repo, {
      "src/retry/delay.ts":
        "export function retryDelay(attempt: number): number {\n  return 2000 * attempt;\n}\n",
    });
    const [anchor] = (await readLockfile(repo)).anchors;
    const id = anchor?.id ?? "";
    const out = await repoint(repo, DEFAULT_CONFIG, actor, {
      ids: [id],
      to: { path: "src/retry/delay.ts", symbol: "retryDelay" },
    });
    expect(out.repointed[0]).toMatchObject({ status: "drifted", driftedTiers: ["body"] });
    const after = await check(repo, DEFAULT_CONFIG);
    expect(after.results[0]).toMatchObject({ status: "drifted", driftedTiers: ["body"] });

    // With --reviewed, the person has checked the claim against the new code.
    const repo2 = await movedRepo();
    await put(repo2, {
      "src/retry/delay.ts":
        "export function retryDelay(attempt: number): number {\n  return 2000 * attempt;\n}\n",
    });
    const [a2] = (await readLockfile(repo2)).anchors;
    await repoint(repo2, DEFAULT_CONFIG, actor, {
      ids: [a2?.id ?? ""],
      to: { path: "src/retry/delay.ts", symbol: "retryDelay" },
      reviewed: true,
    });
    expect((await check(repo2, DEFAULT_CONFIG)).summary.fresh).toBe(1);
  });

  it("the same code in two places names both and picks neither", async () => {
    const repo = await movedRepo();
    await put(repo, { "src/legacy/delay.ts": await readFile(join(repo, "src/retry/delay.ts"), "utf8") });
    const [r] = (await check(repo, DEFAULT_CONFIG, undefined, { write: false })).results;
    expect(r?.moved?.to).toBeUndefined();
    expect(r?.moved?.candidates).toHaveLength(2);
    expect(formatText({ ...(await check(repo, DEFAULT_CONFIG, undefined, { write: false })) })).toContain(
      "its code is in 2 places",
    );
    const out = await repoint(repo, DEFAULT_CONFIG, actor, { ids: [r?.anchor.id ?? ""] });
    expect(out.skipped[0]?.reason).toMatch(/in 2 places.*--to/);
    // Not named, so the run over everything leaves it alone.
    expect((await repoint(repo, DEFAULT_CONFIG, actor)).repointed).toEqual([]);
  });

  it("a wrapper left at the old place is drift, with the code's new home named", async () => {
    const repo = await movedRepo();
    await put(repo, {
      "src/net.ts": `import { retryDelay as next } from "./retry/delay";
export function retryDelay(attempt: number): number {
  return next(attempt);
}
export function other(): void {}
`,
    });
    const [r] = (await check(repo, DEFAULT_CONFIG, undefined, { write: false })).results;
    expect(r?.status).toBe("drifted");
    expect(r?.moved?.to).toEqual({ path: "src/retry/delay.ts", symbol: "retryDelay" });
    const out = await repoint(repo, DEFAULT_CONFIG, actor);
    expect(out.repointed[0]?.status).toBe("fresh");
  });

  it("says when the claim sentence names the old file", async () => {
    const repo = await repoWith({
      "src/net.ts": RETRY_TS,
      "CLAUDE.md":
        "<!-- lockwire src/net.ts#retryDelay body -->\n`retryDelay` in src/net.ts waits 1.5 s.\n",
    });
    await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
    await put(repo, {
      "src/net.ts": "export function other(): void {}\n",
      "src/delay.ts": RETRY_TS.replace("\nexport function other(): void {}\n", ""),
    });
    const out = await repoint(repo, DEFAULT_CONFIG, actor);
    expect(out.repointed[0]?.claimNamesOldPath).toBe(true);
  });

  it("dry-run reports the plan and writes nothing", async () => {
    const repo = await movedRepo();
    const lockBefore = await readFile(join(repo, "lockwire.lock"), "utf8");
    const docBefore = await readFile(join(repo, "CLAUDE.md"), "utf8");
    const ledgerBefore = (await readLedger(repo)).length;
    const out = await repoint(repo, DEFAULT_CONFIG, actor, { dryRun: true });
    expect(out.repointed).toHaveLength(1);
    expect(await readFile(join(repo, "lockwire.lock"), "utf8")).toBe(lockBefore);
    expect(await readFile(join(repo, "CLAUDE.md"), "utf8")).toBe(docBefore);
    expect((await readLedger(repo)).length).toBe(ledgerBefore);
  });

  it("a moved Python method is found under its class", async () => {
    const repo = await repoWith({
      "app/client.py": `class Client:
    def fetch(self, url):
        """Fetch with retries."""
        return self.session.get(url, timeout=1.5)

def unrelated():
    return 1
`,
      "README.md": "<!-- lockwire app/client.py#Client.fetch body -->\n`fetch` times out after 1.5 s.\n",
    });
    await linkDoc(repo, "README.md", DEFAULT_CONFIG, actor);
    await put(repo, {
      "app/client.py": "def unrelated():\n    return 1\n",
      "app/http/client.py": `class Client:
    def fetch(self, url):
        # moved here
        return self.session.get(url, timeout=1.5)
`,
    });
    const out = await repoint(repo, DEFAULT_CONFIG, actor);
    expect(out.repointed[0]?.to).toEqual({ path: "app/http/client.py", symbol: "Client.fetch" });
    expect((await check(repo, DEFAULT_CONFIG)).summary.fresh).toBe(1);
  });

  it("lockfile-only anchors move too", async () => {
    const repo = await repoWith({ "src/net.ts": RETRY_TS, "docs/net.md": "# Net\n" });
    await linkLockfileOnly(
      repo,
      "docs/net.md",
      { path: "src/net.ts", symbol: "retryDelay" },
      ["sig", "body"],
      DEFAULT_CONFIG,
      actor,
    );
    await put(repo, {
      "src/net.ts": "export function other(): void {}\n",
      "src/delay.ts": RETRY_TS,
    });
    const out = await repoint(repo, DEFAULT_CONFIG, actor);
    expect(out.repointed[0]).toMatchObject({ markerUpdated: false, status: "fresh" });
    expect((await check(repo, DEFAULT_CONFIG)).summary.fresh).toBe(1);
  });

  it("the move search can be turned off, and a zero budget never names a home", async () => {
    const repo = await movedRepo();
    const [r] = (await check(repo, DEFAULT_CONFIG, undefined, { write: false, moveSearchMs: 0 }))
      .results;
    expect(r?.status).toBe("orphaned");
    expect(r?.moved).toBeUndefined();
  });

  it("the task queue points the agent at repoint", async () => {
    const repo = await movedRepo();
    const [task] = await listTasks(repo, DEFAULT_CONFIG);
    expect(task?.summary).toBe("src/net.ts#retryDelay moved to src/retry/delay.ts#retryDelay");
    expect(task?.resolutions[0]).toContain("lockwire_repoint");
  });

  it("refuses --to without exactly one id", async () => {
    const repo = await movedRepo();
    await expect(
      repoint(repo, DEFAULT_CONFIG, actor, { to: { path: "src/retry/delay.ts", symbol: "x" } }),
    ).rejects.toThrow(/exactly one anchor id/);
  });
});

describe("re-exports: a name kept at the old path still resolves", () => {
  it("export { x } from", async () => {
    const repo = await movedRepo();
    await put(repo, {
      "src/net.ts": 'export { retryDelay } from "./retry/delay.js";\nexport function other(): void {}\n',
    });
    const result = await check(repo, DEFAULT_CONFIG);
    expect(result.results[0]).toMatchObject({
      status: "fresh",
      definedAt: { path: "src/retry/delay.ts", symbol: "retryDelay" },
    });
    expect(result.results[0]?.moved).toBeUndefined();
  });

  it("an alias, import-then-export, export *, and export * as ns", async () => {
    const sig = `<!-- lockwire src/net.ts#retryDelay sig,body -->\nIt waits 1.5 s.\n`;
    for (const shim of [
      'export { backoff as retryDelay } from "./retry/delay";\n',
      'import { retryDelay } from "./retry/delay";\nexport { retryDelay };\n',
      'export * from "./retry";\n',
    ]) {
      const repo = await repoWith({ "src/net.ts": RETRY_TS, "CLAUDE.md": sig });
      await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor);
      const body = RETRY_TS.replace("\nexport function other(): void {}\n", "");
      await put(repo, {
        "src/net.ts": shim,
        "src/retry/delay.ts": shim.includes("backoff")
          ? body.replace("function retryDelay", "function backoff")
          : body,
        "src/retry/index.ts": 'export * from "./delay";\n',
      });
      const [r] = (await check(repo, DEFAULT_CONFIG)).results;
      expect(r?.status, shim).toBe("fresh");
      expect(r?.definedAt?.path, shim).toBe("src/retry/delay.ts");
    }

    const repo = await repoWith({
      "src/net.ts": 'export * as retry from "./retry/delay";\n',
      "src/retry/delay.ts": RETRY_TS,
      "CLAUDE.md": "<!-- lockwire src/net.ts#retry.retryDelay body -->\nIt waits 1.5 s.\n",
    });
    expect((await linkDoc(repo, "CLAUDE.md", DEFAULT_CONFIG, actor)).created).toBe(1);
    expect((await check(repo, DEFAULT_CONFIG)).summary.fresh).toBe(1);
  });

  it("changed code behind a re-export is still drift", async () => {
    const repo = await movedRepo();
    await put(repo, {
      "src/net.ts": 'export { retryDelay } from "./retry/delay";\n',
      "src/retry/delay.ts":
        "export function retryDelay(attempt: number): number {\n  return 2000 * attempt;\n}\n",
    });
    expect((await check(repo, DEFAULT_CONFIG)).results[0]).toMatchObject({
      status: "drifted",
      driftedTiers: ["body"],
    });
  });

  it("a re-export cycle ends", async () => {
    const repo = await repoWith({
      "src/a.ts": 'export { gone } from "./b";\n',
      "src/b.ts": 'export { gone } from "./a";\n',
      "README.md": "<!-- lockwire src/a.ts#gone -->\nGone.\n",
    });
    const linked = await linkDoc(repo, "README.md", DEFAULT_CONFIG, actor);
    expect(linked.skipped[0]?.reason).toBe("target not found");
  });

  it("Python: from .x import name, absolute imports, aliases and star imports", async () => {
    const FN = "def parse(s):\n    return int(s.strip())\n";
    const doc = "<!-- lockwire pkg/old.py#parse body -->\n`parse` strips, then reads an int.\n";
    for (const shim of [
      "from .new import parse\n",
      "from pkg.new import parse\n",
      "from .new import parse_v2 as parse\n",
      "from .new import *\n",
      "try:\n    from .fast import parse\nexcept ImportError:\n    from .new import parse\n",
    ]) {
      const repo = await repoWith({ "pkg/__init__.py": "", "pkg/old.py": FN, "README.md": doc });
      await linkDoc(repo, "README.md", DEFAULT_CONFIG, actor);
      await put(repo, {
        "pkg/old.py": shim,
        "pkg/new.py": shim.includes("parse_v2") ? FN.replace("def parse", "def parse_v2") : FN,
      });
      const [r] = (await check(repo, DEFAULT_CONFIG)).results;
      expect(r?.status, shim).toBe("fresh");
      expect(r?.definedAt, shim).toEqual({
        path: "pkg/new.py",
        symbol: shim.includes("parse_v2") ? "parse_v2" : "parse",
      });
    }
  });

  it("an import inside a function is not a re-export", async () => {
    const repo = await repoWith({
      "pkg/old.py": "def parse(s):\n    return int(s)\n",
      "pkg/new.py": "def parse(s):\n    return int(s)\n",
      "README.md": "<!-- lockwire pkg/old.py#parse body -->\nReads an int.\n",
    });
    await linkDoc(repo, "README.md", DEFAULT_CONFIG, actor);
    await put(repo, { "pkg/old.py": "def wrapper():\n    from .new import parse\n    return parse\n" });
    const [r] = (await check(repo, DEFAULT_CONFIG, undefined, { write: false })).results;
    expect(r?.status).toBe("orphaned");
    expect(r?.moved?.to).toEqual({ path: "pkg/new.py", symbol: "parse" });
  });
});

describe("resolveModule", () => {
  it("resolves TS/JS specifiers the way bundlers and tsc do", async () => {
    const repo = await repoWith({
      "src/a.ts": "",
      "src/b/index.tsx": "",
      "src/c.ts": "",
      "lib/d.mjs": "",
    });
    expect(resolveModule(repo, "src/x.ts", "./a")).toBe("src/a.ts");
    expect(resolveModule(repo, "src/x.ts", "./a.js")).toBe("src/a.ts");
    expect(resolveModule(repo, "src/x.ts", "./b")).toBe("src/b/index.tsx");
    expect(resolveModule(repo, "src/sub/x.ts", "../c")).toBe("src/c.ts");
    expect(resolveModule(repo, "src/x.ts", "../lib/d.mjs")).toBe("lib/d.mjs");
    expect(resolveModule(repo, "src/x.ts", "react")).toBeNull();
    expect(resolveModule(repo, "src/x.ts", "../../outside")).toBeNull();
  });

  it("resolves Python relative and absolute imports, packages and src layouts", async () => {
    const repo = await repoWith({
      "src/pkg/__init__.py": "",
      "src/pkg/core.py": "",
      "src/pkg/sub/__init__.py": "",
      "top.py": "",
    });
    expect(resolveModule(repo, "src/pkg/sub/x.py", "..core")).toBe("src/pkg/core.py");
    expect(resolveModule(repo, "src/pkg/x.py", ".sub")).toBe("src/pkg/sub/__init__.py");
    expect(resolveModule(repo, "src/pkg/x.py", ".")).toBe("src/pkg/__init__.py");
    expect(resolveModule(repo, "src/pkg/x.py", "pkg.core")).toBe("src/pkg/core.py");
    expect(resolveModule(repo, "src/pkg/x.py", "top")).toBe("top.py");
    expect(resolveModule(repo, "src/pkg/x.py", "numpy")).toBeNull();
  });
});

describe("sigFingerprints", () => {
  it("accepts the signature with export added or removed, and nothing else", () => {
    const plain = sigFingerprints("fn f(x: number)->number [async]");
    const exported = sigFingerprints("fn f(x: number)->number [async,export]");
    for (const fp of plain) expect(exported.has(fp)).toBe(true);
    const other = sigFingerprints("fn f(x: string)->number [async]");
    for (const fp of other) expect(plain.has(fp)).toBe(false);
  });
});

describe("moves: the edges", () => {
  it("a search that runs out of time names no new home", async () => {
    const repo = await movedRepo();
    // A deadline already in the past: the walk stops before it has seen the whole tree.
    const { SourceIndex } = await import("../src/moves.js");
    const { symbolsOfSource } = await import("../src/actions.js");
    const index = new SourceIndex(
      repo,
      DEFAULT_CONFIG,
      (p, c, v) => symbolsOfSource(p, c, DEFAULT_CONFIG, v),
      Date.now() - 1,
    );
    const [anchor] = (await readLockfile(repo)).anchors;
    expect(anchor && (await index.findMove(anchor, 2))).toBeNull();
  });

  it("a name that only appears inside a longer identifier isn't a lead", async () => {
    const repo = await movedRepo();
    await rm(join(repo, "src/retry/delay.ts"));
    await put(repo, { "src/x.ts": "export const retryDelayMs = 5;\n" });
    const [r] = (await check(repo, DEFAULT_CONFIG, undefined, { write: false })).results;
    expect(r?.moved).toBeUndefined();
  });

  it("the task view shows the code behind a re-export", async () => {
    const repo = await movedRepo();
    await put(repo, {
      "src/net.ts": 'export { retryDelay } from "./retry/delay";\n',
      "src/retry/delay.ts":
        "export function retryDelay(attempt: number): number {\n  return 2000 * attempt;\n}\n",
    });
    const [task] = await listTasks(repo, DEFAULT_CONFIG);
    const { taskContext } = await import("../src/tasks.js");
    const ctx = await taskContext(repo, DEFAULT_CONFIG, task?.id ?? "");
    expect(ctx.now.source).toContain("return 2000 * attempt");
    expect(ctx.now.note).toBe(
      "defined in src/retry/delay.ts#retryDelay, re-exported from src/net.ts",
    );
  });
});

describe("found by stressing real repositories", () => {
  const doc = (target: string, tiers = "sig,body") =>
    `<!-- lockwire ${target} ${tiers} -->\nA claim about ${target}.\n`;
  const checkOne = async (repo: string) =>
    (await check(repo, DEFAULT_CONFIG, undefined, { write: false })).results;

  it("two functions that call nothing aren't each other's rename (django's findPosX and findPosY)", async () => {
    const both = `function findPosX(obj) {
  let left = 0;
  while (obj.offsetParent) { left += obj.offsetLeft; obj = obj.offsetParent; }
  return left;
}

function findPosY(obj) {
  let top = 0;
  while (obj.offsetParent) { top += obj.offsetTop; obj = obj.offsetParent; }
  return top;
}
`;
    const repo = await repoWith({ "core.js": both, "A.md": doc("core.js#findPosX") });
    await linkDoc(repo, "A.md", DEFAULT_CONFIG, actor);
    const x = both.slice(0, both.indexOf("function findPosY"));
    await put(repo, { "core.js": both.slice(x.length), "moved.js": x });
    const [r] = await checkOne(repo);
    expect(r?.status).toBe("orphaned");
    expect(r?.anchor.target.symbol).toBe("findPosX");
    expect(r?.moved?.to).toEqual({ path: "moved.js", symbol: "findPosX" });

    // Deleted outright, with nowhere to have gone: orphaned, not handed to its look-alike.
    await rm(join(repo, "moved.js"));
    const [gone] = await checkOne(repo);
    expect(gone?.status).toBe("orphaned");
    expect(gone?.anchor.target.symbol).toBe("findPosX");
    expect(gone?.moved).toBeUndefined();
  });

  it("an empty body is no evidence of a rename: a deleted stub doesn't hand its claim to another stub", async () => {
    const repo = await repoWith({
      "a.ts": "export function a(x: number): void {}\nexport function b(x: number): void {}\n",
      "A.md": doc("a.ts#a", "sig"),
    });
    await linkDoc(repo, "A.md", DEFAULT_CONFIG, actor);
    await put(repo, { "a.ts": "export function b(x: number): void {}\n" });
    const [r] = await checkOne(repo);
    expect(r).toMatchObject({ status: "orphaned" });
    expect(r?.anchor.target.symbol).toBe("a");
  });

  it("a same-file look-alike that only makes the same calls yields to the code's real new home", async () => {
    const both = `export function leftTax(x: number): number {
  return Math.round(x * 1.2);
}

export function rightTax(x: number): number {
  return Math.round(x * 1.5);
}
`;
    const repo = await repoWith({ "tax.ts": both, "A.md": doc("tax.ts#leftTax") });
    await linkDoc(repo, "A.md", DEFAULT_CONFIG, actor);
    const left = both.slice(0, both.indexOf("export function rightTax"));
    await put(repo, { "tax.ts": both.slice(left.length), "left.ts": left });
    const [r] = await checkOne(repo);
    expect(r?.status).toBe("orphaned");
    expect(r?.anchor.target.symbol).toBe("leftTax");
    expect(r?.moved?.to).toEqual({ path: "left.ts", symbol: "leftTax" });
  });

  it("a twin that was already in another file when the claim was stamped isn't where the code went", async () => {
    const f = "export function withChecks(x: number): number {\n  return x * 2;\n}\n";
    const repo = await repoWith({ "a.ts": f, "b.ts": f, "A.md": doc("a.ts#withChecks") });
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
        cwd: repo,
        stdio: "ignore",
      });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    await linkDoc(repo, "A.md", DEFAULT_CONFIG, actor);
    expect((await readLockfile(repo)).anchors[0]?.linked.commit).toMatch(/^[0-9a-f]{7,40}$/);

    // Deleted outright: b.ts's copy was always there, so nothing moved.
    await put(repo, { "a.ts": "export const x = 1;\n" });
    const [deleted] = await checkOne(repo);
    expect(deleted?.status).toBe("orphaned");
    expect(deleted?.moved).toBeUndefined();

    // Moved to a new file: that is where it went, with the old twin left out of the question.
    await put(repo, { "c.ts": f });
    const [moved] = await checkOne(repo);
    expect(moved?.moved?.to).toEqual({ path: "c.ts", symbol: "withChecks" });
  });

  it("claims from two places can't both have moved to the same one: neither is told it did", async () => {
    const f = "export function build(x: number): number {\n  return x * 7;\n}\n";
    const repo = await repoWith({
      "a.ts": f,
      "b.ts": f,
      "A.md": `${doc("a.ts#build")}\n${doc("b.ts#build")}`,
    });
    await linkDoc(repo, "A.md", DEFAULT_CONFIG, actor);
    await put(repo, { "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n", "c.ts": f });
    const results = await checkOne(repo);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.moved?.to).toBeUndefined();
      expect(r.moved?.candidates).toEqual([{ path: "c.ts", symbol: "build" }]);
    }
    expect((await repoint(repo, DEFAULT_CONFIG, actor)).repointed).toEqual([]);
    // A person who knows which one it was can say so.
    const [first] = results;
    const out = await repoint(repo, DEFAULT_CONFIG, actor, {
      ids: [first?.anchor.id ?? ""],
      to: { path: "c.ts", symbol: "build" },
    });
    expect(out.repointed).toHaveLength(1);
  });

  it("a method is found through its class under the same path, not in some other class's identical method", async () => {
    const method = `    def fetch(self, url):
        return self.session.get(url, timeout=1.5)
`;
    const repo = await repoWith({
      "client.py": `class Client:\n${method}`,
      "other.py": `class Other:\n${method}`,
      "A.md": doc("client.py#Client.fetch"),
    });
    await linkDoc(repo, "A.md", DEFAULT_CONFIG, actor);
    await put(repo, {
      "client.py": "def unrelated():\n    return 1\n",
      "http/client.py": `class Client:\n${method}`,
    });
    const [r] = await checkOne(repo);
    expect(r?.moved?.to).toEqual({ path: "http/client.py", symbol: "Client.fetch" });
    expect(r?.moved?.candidates).toHaveLength(1);
  });

  // The search only parses files that appear to declare the symbol, so each way the extractor can
  // see a symbol has to look like a declaration to it.
  const FORMS: [string, string, string, string][] = [
    ["an arrow function in a const", "sq.ts", "export const sq = (n: number): number => n * n;\n", "sq"],
    ["a typed const function", "h.ts", "export const h: (n: number) => number = function (n) { return n + 1; };\n", "h"],
    [
      "a method with modifiers, through its class",
      "box.ts",
      "export class Box {\n  public static async make(x: number) {\n    return x + 1;\n  }\n}\n",
      "Box.make",
    ],
    ["a CommonJS export", "send.js", "exports.send = function (a) {\n  return a + 1;\n};\n", "send"],
    [
      "a prototype method",
      "view.js",
      "function View() {}\nView.prototype.render = function (x) {\n  return x + 2;\n};\n",
      "View.render",
    ],
    ["a generator", "gen.ts", "export function* ids(n: number) {\n  for (let i = 0; i < n; i++) yield i;\n}\n", "ids"],
    [
      "a namespace member",
      "ns.ts",
      "export namespace NA {\n  export function helper(x: number) {\n    return x * 3;\n  }\n}\n",
      "NA.helper",
    ],
    ["an interface", "types.ts", "export interface Options {\n  retries: number;\n  delay: number;\n}\n", "Options"],
    ["a type alias", "alias.ts", "export type Handler = (req: Request, res: Response) => Promise<void>;\n", "Handler"],
    ["an async Python function", "svc.py", "async def fetch_all(urls):\n    return [await get(u) for u in urls]\n", "fetch_all"],
    [
      "a decorated Python function",
      "dec.py",
      "@cache\ndef compute(x):\n    return x * 99 + offset(x)\n",
      "compute",
    ],
  ];
  for (const [what, file, code, symbol] of FORMS)
    it(`finds ${what} after it moves`, async () => {
      const repo = await repoWith({ [file]: code, "A.md": doc(`${file}#${symbol}`, "sig") });
      expect((await linkDoc(repo, "A.md", DEFAULT_CONFIG, actor)).created).toBe(1);
      const moved = `lib/${file}`;
      await rm(join(repo, file));
      await put(repo, { [moved]: code });
      const [r] = await checkOne(repo);
      expect(r?.moved?.to, what).toEqual({ path: moved, symbol });
    });

  it("a renamed function whose body also changed is suggested, not silently re-bound", async () => {
    const repo = await repoWith({
      "a.ts": "export function alpha(x: number): number {\n  return x + 1;\n}\n",
      "A.md": doc("a.ts#alpha"),
    });
    await linkDoc(repo, "A.md", DEFAULT_CONFIG, actor);
    await put(repo, { "a.ts": "export function beta(x: number): number {\n  return x + 2;\n}\n" });
    const result = await check(repo, DEFAULT_CONFIG, undefined, { write: false });
    const [r] = result.results;
    expect(r).toMatchObject({ status: "orphaned", similar: { path: "a.ts", symbol: "beta" } });
    expect(r?.anchor.target.symbol).toBe("alpha");
    expect(formatText(result)).toMatch(/a\.ts#beta has the same signature/);
    expect(formatText(result)).toContain("lockwire repoint <id> --to <path#symbol>");
    // Two candidates are no suggestion at all.
    await put(repo, {
      "a.ts":
        "export function beta(x: number): number {\n  return x + 2;\n}\nexport function gamma(x: number): number {\n  return x + 3;\n}\n",
    });
    expect((await check(repo, DEFAULT_CONFIG, undefined, { write: false })).results[0]?.similar).toBeUndefined();
  });
});

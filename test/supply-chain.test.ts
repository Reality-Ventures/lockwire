import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("supply chain", () => {
  it("lockwire never touches the network: no source file imports a network module or calls fetch", () => {
    const network =
      /from\s+["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns|dns\/promises)["']|require\(\s*["'](?:node:)?(?:http|https|http2|net|tls|dgram|dns)["']\s*\)|\bfetch\s*\(|\bnew\s+WebSocket\b|\bXMLHttpRequest\b|["']fetch["']\s*,/;
    const offenders = readdirSync(join(root, "src"))
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => network.test(read(join("src", f))));
    expect(offenders).toEqual([]);
  });

  it("the runtime dependencies are exactly these three; adding one is a decision, not a side effect", () => {
    const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@noble/hashes", "web-tree-sitter", "zod"]);
  });

  it("the Claude Code plugin isn't pinned to a version, so Claude Code sees each release as an update", () => {
    const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as { version?: string };
    const market = JSON.parse(read(".claude-plugin/marketplace.json")) as {
      plugins: { version?: string }[];
    };
    expect(plugin.version).toBeUndefined();
    for (const entry of market.plugins) expect(entry.version).toBeUndefined();
  });

  const srcFiles = () => readdirSync(join(root, "src")).filter((f) => f.endsWith(".ts")).sort();

  it("the shell is reached from two modules only: git, run without a shell, and the agent autofix starts", () => {
    const importers = srcFiles().filter((f) => /["']node:child_process["']/.test(read(join("src", f))));
    expect(importers).toEqual(["autofix.ts", "changed.ts"]);
    // Only the calls that take an argument list: nothing that runs a command string through a shell.
    const imported = new Set<string>();
    for (const f of importers)
      for (const m of read(join("src", f)).matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/g))
        for (const name of (m[1] ?? "").split(",")) imported.add(name.trim());
    expect([...imported].sort()).toEqual(["execFileSync", "spawn", "spawnSync"]);
    // `shell: …` is autofix's `--agent-command "<command>"`, which the user wrote.
    expect(srcFiles().filter((f) => /\bshell\s*:/.test(read(join("src", f))))).toEqual(["autofix.ts"]);
    expect(read("src/changed.ts")).not.toMatch(/\bshell\s*:/);
  });

  it("the environment variables lockwire reads are exactly these, and the whole environment is handed on only to the agent autofix starts", () => {
    const names = new Set<string>();
    for (const f of srcFiles())
      for (const m of read(join("src", f)).matchAll(/\b(?:process\.)?env\??\.([A-Z][A-Z0-9_]+)/g)) names.add(m[1] ?? "");
    expect([...names].sort()).toEqual([
      "CI",
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_PLUGIN_ROOT",
      "CODEX_HOME",
      "CODEX_SANDBOX",
      "GITHUB_BASE_REF",
    ]);
    const dynamic = srcFiles().filter((f) => /process\.env\s*\[/.test(read(join("src", f))));
    expect(dynamic).toEqual([]);
    // `process.env` as a whole: the default for resolveBase's `env` argument, and what autofix passes on.
    const whole = srcFiles().filter((f) => /process\.env(?![.\w[])/.test(read(join("src", f))));
    expect(whole).toEqual(["autofix.ts", "changed.ts"]);
  });
});

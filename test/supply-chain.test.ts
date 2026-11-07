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
});

// Copies prebuilt tree-sitter grammar .wasm files out of their npm packages into grammars/.
// The grammar packages also carry native node-gyp bindings we never build (installed with --ignore-scripts).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "grammars");
mkdirSync(out, { recursive: true });

const wanted = [
  ["tree-sitter-typescript", "tree-sitter-typescript.wasm"],
  ["tree-sitter-typescript", "tree-sitter-tsx.wasm"],
  ["tree-sitter-javascript", "tree-sitter-javascript.wasm"],
  ["tree-sitter-python", "tree-sitter-python.wasm"],
];
for (const [pkg, file] of wanted) {
  const pkgDir = dirname(require.resolve(`${pkg}/package.json`));
  const src = join(pkgDir, file);
  if (!existsSync(src)) throw new Error(`missing ${src}`);
  copyFileSync(src, join(out, file));
  console.log(`grammars/${file}`);
}

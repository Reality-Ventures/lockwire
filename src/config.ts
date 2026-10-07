import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stripBom } from "./repo.js";
import type { LockwireConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export function configPath(repoRoot: string): string {
  return `${repoRoot}/.lockwire/config.json`;
}

export async function readConfig(repoRoot: string): Promise<LockwireConfig> {
  const path = configPath(repoRoot);
  if (!existsSync(path)) return DEFAULT_CONFIG;
  const raw = JSON.parse(stripBom(await readFile(path, "utf8")));
  return {
    version: 1,
    docs: raw.docs ?? DEFAULT_CONFIG.docs,
    exclude: raw.exclude ?? DEFAULT_CONFIG.exclude,
    normalizeLocals: raw.normalizeLocals ?? DEFAULT_CONFIG.normalizeLocals,
    hook: { ...DEFAULT_CONFIG.hook, ...(raw.hook ?? {}) },
    noiseBudget: { ...DEFAULT_CONFIG.noiseBudget, ...(raw.noiseBudget ?? {}) },
  };
}

export async function writeConfig(repoRoot: string, config: LockwireConfig): Promise<void> {
  const path = configPath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type { Anchor, Lockfile } from "./types.js";

const LOCKFILE_NAME = "lockwire.lock";

export function lockfilePath(repoRoot: string): string {
  return `${repoRoot}/${LOCKFILE_NAME}`;
}

export async function readLockfile(repoRoot: string): Promise<Lockfile> {
  const path = lockfilePath(repoRoot);
  if (!existsSync(path)) return { version: 1, anchors: [] };
  const raw = await readFile(path, "utf8");
  if (/^<{7}( |$)/m.test(raw) && /^>{7}( |$)/m.test(raw))
    throw new Error(
      `${LOCKFILE_NAME} has unresolved merge conflicts (${path}). Resolve them (either side is fine), then run \`lockwire check\` -- it re-derives every status from the code -- and \`lockwire ack\` anything it flags.`,
    );
  let parsed: Lockfile;
  try {
    parsed = JSON.parse(raw) as Lockfile;
  } catch (err) {
    throw new Error(`${LOCKFILE_NAME} is not valid JSON (${path}): ${(err as Error).message}`);
  }
  return { version: 1, anchors: parsed.anchors ?? [] };
}

export async function writeLockfile(repoRoot: string, lockfile: Lockfile): Promise<void> {
  const sorted: Lockfile = {
    version: 1,
    anchors: [...lockfile.anchors].sort((a, b) => a.id.localeCompare(b.id)),
  };
  await writeFile(lockfilePath(repoRoot), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}

export function upsertAnchor(lockfile: Lockfile, anchor: Anchor): Lockfile {
  const anchors = lockfile.anchors.filter((a) => a.id !== anchor.id);
  anchors.push(anchor);
  return { version: 1, anchors };
}

export function removeAnchor(lockfile: Lockfile, id: string): Lockfile {
  return { version: 1, anchors: lockfile.anchors.filter((a) => a.id !== id) };
}

export function anchorsForPath(lockfile: Lockfile, repoRelativePath: string): Anchor[] {
  return lockfile.anchors.filter((a) => a.target.path === repoRelativePath);
}

const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase, no i/l/o/u

export function newAnchorId(): string {
  let id = "";
  for (let i = 0; i < 8; i++) id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
  return id;
}

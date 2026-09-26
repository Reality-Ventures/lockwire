import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
const LOCKFILE_NAME = "lockwire.lock";
export function lockfilePath(repoRoot) {
    return `${repoRoot}/${LOCKFILE_NAME}`;
}
export async function readLockfile(repoRoot) {
    const path = lockfilePath(repoRoot);
    if (!existsSync(path))
        return { version: 1, anchors: [] };
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    return { version: 1, anchors: parsed.anchors ?? [] };
}
export async function writeLockfile(repoRoot, lockfile) {
    const sorted = {
        version: 1,
        anchors: [...lockfile.anchors].sort((a, b) => a.id.localeCompare(b.id)),
    };
    await writeFile(lockfilePath(repoRoot), `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
}
export function upsertAnchor(lockfile, anchor) {
    const anchors = lockfile.anchors.filter((a) => a.id !== anchor.id);
    anchors.push(anchor);
    return { version: 1, anchors };
}
export function removeAnchor(lockfile, id) {
    return { version: 1, anchors: lockfile.anchors.filter((a) => a.id !== id) };
}
export function anchorsForPath(lockfile, repoRelativePath) {
    return lockfile.anchors.filter((a) => a.target.path === repoRelativePath);
}
const ID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz"; // Crockford base32, lowercase, no i/l/o/u
export function newAnchorId() {
    let id = "";
    for (let i = 0; i < 8; i++)
        id += ID_ALPHABET[Math.floor(Math.random() * ID_ALPHABET.length)];
    return id;
}
//# sourceMappingURL=lockfile.js.map
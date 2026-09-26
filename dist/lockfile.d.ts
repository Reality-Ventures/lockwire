import type { Anchor, Lockfile } from "./types.js";
export declare function lockfilePath(repoRoot: string): string;
export declare function readLockfile(repoRoot: string): Promise<Lockfile>;
export declare function writeLockfile(repoRoot: string, lockfile: Lockfile): Promise<void>;
export declare function upsertAnchor(lockfile: Lockfile, anchor: Anchor): Lockfile;
export declare function removeAnchor(lockfile: Lockfile, id: string): Lockfile;
export declare function anchorsForPath(lockfile: Lockfile, repoRelativePath: string): Anchor[];
export declare function newAnchorId(): string;
//# sourceMappingURL=lockfile.d.ts.map
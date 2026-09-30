import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readLockfile } from "../src/lockfile.js";

async function repoWithLock(contents: string) {
  const dir = await mkdtemp(join(tmpdir(), "lockwire-lockfile-"));
  await writeFile(join(dir, "lockwire.lock"), contents, "utf8");
  return dir;
}

describe("readLockfile", () => {
  it("names a git merge conflict instead of surfacing a bare JSON parse error", async () => {
    const dir = await repoWithLock(
      '{\n  "version": 1,\n<<<<<<< HEAD\n  "anchors": []\n=======\n  "anchors": [{}]\n>>>>>>> one\n}\n',
    );
    await expect(readLockfile(dir)).rejects.toThrow(/unresolved merge conflicts/);
  });

  it("says which file is malformed for other invalid JSON", async () => {
    const dir = await repoWithLock("{ nope");
    await expect(readLockfile(dir)).rejects.toThrow(/lockwire\.lock is not valid JSON/);
  });

  it("still reads a valid lockfile", async () => {
    const dir = await repoWithLock('{"version":1,"anchors":[]}');
    expect((await readLockfile(dir)).anchors).toEqual([]);
  });
});

import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { blake3Hex } from "../src/blake3.js";
import { fingerprint } from "../src/hash.js";

/** The reference test inputs: byte i is i mod 251. */
const pattern = (n: number) => Uint8Array.from({ length: n }, (_, i) => i % 251);

describe("blake3", () => {
  it("hashes the empty input to the published digest", () => {
    expect(blake3Hex(new Uint8Array())).toBe(
      "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
    );
  });

  it("matches the reference implementation at every length around the block, chunk and tree boundaries", () => {
    const lengths = new Set<number>();
    for (let n = 0; n <= 200; n++) lengths.add(n);
    for (const edge of [1024, 2048, 3072, 4096, 5120, 8192, 31744, 32768])
      for (let d = -3; d <= 3; d++) lengths.add(edge + d);
    for (const n of lengths) {
      const input = pattern(n);
      expect(blake3Hex(input), `length ${n}`).toBe(bytesToHex(blake3(input)));
    }
  });

  it("matches it on text, truncated the way a fingerprint is", () => {
    for (const text of ["", "x", "héllo → wörld 日本語", "function a() {\n  return 1;\n}\n".repeat(300)]) {
      const bytes = new TextEncoder().encode(text);
      expect(fingerprint(text)).toBe(`b3:${bytesToHex(blake3(bytes)).slice(0, 32)}`);
    }
  });
});

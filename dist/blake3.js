/**
 * BLAKE3, the unkeyed hash, written out so lockwire needs no hashing dependency (Node's crypto has no
 * BLAKE3). Lockfiles written by earlier versions hold BLAKE3 fingerprints, so the hash has to stay
 * the same one; the tests check this against the reference implementation (`@noble/hashes`, a
 * development dependency) over every input length around the chunk and tree boundaries.
 */
const IV = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
const PERMUTATION = [2, 6, 3, 10, 7, 0, 4, 13, 1, 11, 12, 5, 9, 14, 15, 8];
const CHUNK_START = 1;
const CHUNK_END = 2;
const PARENT = 4;
const ROOT = 8;
const BLOCK_LEN = 64;
const CHUNK_LEN = 1024;
const rotr = (x, n) => (x >>> n) | (x << (32 - n));
// Scratch space reused by every compression, so hashing allocates nothing per block.
const state = new Uint32Array(16);
const msg = new Uint32Array(16);
const next = new Uint32Array(16);
function g(a, b, c, d, mx, my) {
    state[a] = state[a] + state[b] + mx;
    state[d] = rotr(state[d] ^ state[a], 16);
    state[c] = state[c] + state[d];
    state[b] = rotr(state[b] ^ state[c], 12);
    state[a] = state[a] + state[b] + my;
    state[d] = rotr(state[d] ^ state[a], 8);
    state[c] = state[c] + state[d];
    state[b] = rotr(state[b] ^ state[c], 7);
}
/**
 * The compression function: an 8-word chaining value and a 16-word block in, 16 words out. The result
 * is `state`, which the next call overwrites: read what you need before compressing again.
 */
function compress(cv, block, counter, blockLen, flags) {
    for (let i = 0; i < 8; i++)
        state[i] = cv[i];
    state[8] = IV[0];
    state[9] = IV[1];
    state[10] = IV[2];
    state[11] = IV[3];
    state[12] = counter >>> 0;
    state[13] = Math.floor(counter / 0x100000000) >>> 0;
    state[14] = blockLen;
    state[15] = flags;
    for (let i = 0; i < 16; i++)
        msg[i] = block[i];
    for (let round = 0; round < 7; round++) {
        g(0, 4, 8, 12, msg[0], msg[1]);
        g(1, 5, 9, 13, msg[2], msg[3]);
        g(2, 6, 10, 14, msg[4], msg[5]);
        g(3, 7, 11, 15, msg[6], msg[7]);
        g(0, 5, 10, 15, msg[8], msg[9]);
        g(1, 6, 11, 12, msg[10], msg[11]);
        g(2, 7, 8, 13, msg[12], msg[13]);
        g(3, 4, 9, 14, msg[14], msg[15]);
        if (round < 6) {
            for (let i = 0; i < 16; i++)
                next[i] = msg[PERMUTATION[i]];
            msg.set(next);
        }
    }
    for (let i = 0; i < 8; i++) {
        state[i] = state[i] ^ state[i + 8];
        state[i + 8] = state[i + 8] ^ cv[i];
    }
    return state;
}
const chainingValue = (o) => Array.from(compress(o.cv, o.block, o.counter, o.blockLen, o.flags).subarray(0, 8));
const words = (bytes, start, length) => {
    const block = new Uint32Array(16);
    const view = new DataView(bytes.buffer, bytes.byteOffset + start, length);
    for (let i = 0; i < length >> 2; i++)
        block[i] = view.getUint32(i * 4, true);
    // A final partial word is zero-padded, little-endian.
    for (let i = length & ~3; i < length; i++)
        block[i >> 2] = block[i >> 2] | (view.getUint8(i) << (8 * (i & 3)));
    return block;
};
/** The output of the chunk starting at `start`, whose last block is left for the caller to finish. */
function chunkOutput(input, start, index) {
    const length = Math.min(CHUNK_LEN, input.length - start);
    const blocks = Math.max(1, Math.ceil(length / BLOCK_LEN));
    let cv = IV;
    for (let b = 0; b < blocks - 1; b++) {
        const block = words(input, start + b * BLOCK_LEN, BLOCK_LEN);
        cv = Array.from(compress(cv, block, index, BLOCK_LEN, b === 0 ? CHUNK_START : 0).subarray(0, 8));
    }
    const last = (blocks - 1) * BLOCK_LEN;
    const blockLen = length - last;
    return {
        cv,
        block: words(input, start + last, blockLen),
        counter: index,
        blockLen,
        flags: (blocks === 1 ? CHUNK_START : 0) | CHUNK_END,
    };
}
const parentOutput = (left, right) => ({
    cv: IV,
    block: Uint32Array.from([...left, ...right]),
    counter: 0,
    blockLen: BLOCK_LEN,
    flags: PARENT,
});
/** The first `length` bytes (at most 32) of the BLAKE3 hash of `input`, as lowercase hex. */
export function blake3Hex(input, length = 32) {
    const chunks = Math.max(1, Math.ceil(input.length / CHUNK_LEN));
    // Completed subtrees, merged as soon as two of equal size exist.
    const stack = [];
    for (let i = 0; i < chunks - 1; i++) {
        let cv = chainingValue(chunkOutput(input, i * CHUNK_LEN, i));
        for (let done = i + 1; (done & 1) === 0; done >>= 1)
            cv = chainingValue(parentOutput(stack.pop(), cv));
        stack.push(cv);
    }
    let out = chunkOutput(input, (chunks - 1) * CHUNK_LEN, chunks - 1);
    while (stack.length > 0)
        out = parentOutput(stack.pop(), chainingValue(out));
    const digest = compress(out.cv, out.block, 0, out.blockLen, out.flags | ROOT);
    let hex = "";
    for (let i = 0; i < Math.ceil(length / 4); i++)
        for (let b = 0; b < 4; b++)
            hex += ((digest[i] >>> (8 * b)) & 0xff).toString(16).padStart(2, "0");
    return hex.slice(0, length * 2);
}
//# sourceMappingURL=blake3.js.map
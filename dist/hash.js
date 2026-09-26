import { blake3 } from "@noble/hashes/blake3.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
/**
 * A lockwire fingerprint: `b3:` + 32 lowercase hex chars — the first 16 bytes
 * (128 bits) of a BLAKE3 digest. 128 bits is far past the collision risk that
 * matters here (we're comparing a few thousand anchors, not defending against
 * an adversary who controls the input), and it keeps `lockwire.lock` compact.
 */
export function fingerprint(input) {
    const full = blake3(utf8ToBytes(input));
    return `b3:${bytesToHex(full.subarray(0, 16))}`;
}
/** Hash a sorted-unique string set as a single fingerprint (used for the `deps` tier and the ledger root). */
export function fingerprintSet(items) {
    const sorted = [...new Set(items)].sort();
    return fingerprint(JSON.stringify(sorted));
}
/** Canonical JSON: sorted keys, no whitespace. Used so ledger event hashes are reproducible across platforms. */
export function canonicalJson(value) {
    return JSON.stringify(sortKeysDeep(value));
}
function sortKeysDeep(value) {
    if (Array.isArray(value))
        return value.map(sortKeysDeep);
    if (value !== null && typeof value === "object") {
        const out = {};
        for (const key of Object.keys(value).sort()) {
            out[key] = sortKeysDeep(value[key]);
        }
        return out;
    }
    return value;
}
//# sourceMappingURL=hash.js.map
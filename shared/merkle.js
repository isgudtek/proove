/**
 * merkle.js: registry tree logic shared by the Node setup script and the browsers.
 * The hash functions are injected, so Node and browser use the exact same circuit hashes (via the hasher circuit).
 */
export const DEPTH = 8; // 256 certified items per registry
export const ZERO = "0x" + "0".repeat(64);
export const NULLIFIER_DOMAIN = "0x70726f6f7665"; // "proove"

export const CATEGORIES = {
  1: { key: "meteorite", label: "Meteorite fragment", unit: "g" },
  2: { key: "mineral", label: "Rare mineral", unit: "g" },
  3: { key: "precious_metal", label: "Precious-metal piece", unit: "g" },
  4: { key: "coin", label: "Antique coin", unit: "g" },
  5: { key: "artwork", label: "Limited-edition artwork", unit: "" },
  6: { key: "document", label: "Historic document", unit: "" },
};
export const categoryCode = (key) => Number(Object.entries(CATEGORIES).find(([, c]) => c.key === key)?.[0] || 0);

/** Field elements of a certified item, in the order the circuit hashes them. */
export const leafInputs = (it) => [it.secret, it.category, it.edition_no, it.edition_size, it.measure, it.cert_year].map(String);

/** Build all tree levels. hashNode(left, right) -> hex field. */
export async function buildTree(leaves, hashNode, depth = DEPTH) {
  if (leaves.length > 2 ** depth) throw new Error(`Registry holds at most ${2 ** depth} items`);
  let level = [...leaves];
  while (level.length < 2 ** depth) level.push(ZERO);
  const levels = [level];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(await hashNode(level[i], level[i + 1]));
    level = next;
    levels.push(level);
  }
  return { levels, root: level[0] };
}

/** Sibling path and left/right bits for leaf `index` (bit true = node is the right child). */
export function pathFor(levels, index, depth = DEPTH) {
  const path = [], bits = [];
  let i = index;
  for (let d = 0; d < depth; d++) { path.push(levels[d][i ^ 1]); bits.push((i & 1) === 1); i >>= 1; }
  return { path, bits };
}

/** Public inputs of the possession circuit, in circuit order (the nullifier is the return value, last). */
export const PUBLIC_INPUTS = ["root", "category", "edition_size", "min_measure", "min_year", "listing", "nullifier"];
export const toBig = (hex) => BigInt(hex);
export const sameField = (a, b) => { try { return BigInt(a) === BigInt(b); } catch { return false; } };

/** Field that binds a proof to one listing of one vendor: sha-256 of "vendor|listing", truncated to 31 bytes. */
export async function listingField(vendorId, listingId) {
  const data = new TextEncoder().encode(`proove|${vendorId}|${listingId}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return "0x" + [...digest.slice(0, 31)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const b64 = {
  encode: (u8) => { let s = ""; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); },
  decode: (str) => Uint8Array.from(atob(str), (c) => c.charCodeAt(0)),
};

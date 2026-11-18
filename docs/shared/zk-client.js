/**
 * zk-client.js: browser prover and verifier for Proove (Noir circuits + Barretenberg UltraHonk).
 * Everything is self-hosted under shared/zk/ (circuits, WASM, workers, CRS). Loaded lazily: call warmUp() early.
 */
import { PUBLIC_INPUTS, b64, leafInputs } from "./merkle.js?v=c8a3d2e978";

const base = new URL("./zk/", import.meta.url);
let ready = null;

async function init() {
  const t0 = performance.now();
  const lib = await import(new URL("vendor/zk.js", base).href);
  const [possession, hasher] = await Promise.all(["possession.json", "hasher.json"].map(async (f) => (await fetch(new URL(f, base), { cache: "force-cache" })).json()));
  // Multithreading needs cross-origin isolation (COOP/COEP headers), which static hosts like GitHub Pages can't send.
  const threads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
  const api = await lib.Barretenberg.new({ threads, srsSize: 2 ** 17 });
  const backend = new lib.UltraHonkBackend(possession.bytecode, api);
  return {
    lib, api, backend, threads,
    possession: new lib.Noir(possession),
    hasher: new lib.Noir(hasher),
    verifier: new lib.UltraHonkVerifierBackend(api),
    loadMs: Math.round(performance.now() - t0),
  };
}

/** Load the prover in the background. Resolves to { threads, loadMs }. */
export function warmUp() {
  ready ??= init();
  return ready.then((z) => ({ threads: z.threads, loadMs: z.loadMs }));
}
const zk = () => (ready ??= init());

/** Same hashes as the circuit (executed, not proved). */
export async function hashLeaf(item) { return (await (await zk()).hasher.execute({ item: leafInputs(item), left: "0", right: "0" })).returnValue[0]; }
export async function hashNode(l, r) { return (await (await zk()).hasher.execute({ item: ["0", "0", "0", "0", "0", "0"], left: l, right: r })).returnValue[1]; }
export async function nullifierOf(item) { return (await (await zk()).hasher.execute({ item: leafInputs(item), left: "0", right: "0" })).returnValue[2]; }

/**
 * Prove possession of a registered item without revealing it.
 * claims: { category, edition_size, min_measure, min_year }, listing: field binding the proof to one listing.
 * Throws OawError-like { code: "NOT_PROVABLE" } when the item can't satisfy the statement (not registered, overclaim...).
 */
export async function prove({ item, path, bits, root, claims, listing }) {
  const z = await zk();
  const t0 = performance.now();
  let execution;
  try {
    execution = await z.possession.execute({
      secret: item.secret, edition_no: item.edition_no, measure: item.measure, cert_year: item.cert_year, path, index_bits: bits,
      root, category: claims.category, edition_size: claims.edition_size, min_measure: claims.min_measure, min_year: claims.min_year, listing,
    });
  } catch (e) {
    const reason = (String(e?.message || e).match(/Circuit execution failed: (.*)/) || [])[1] || String(e?.message || e).slice(0, 120);
    throw Object.assign(new Error(`Cannot prove possession: ${reason}`), { code: "NOT_PROVABLE", reason });
  }
  const t1 = performance.now();
  const proof = await z.backend.generateProof(execution.witness);
  return {
    proof: b64.encode(proof.proof),
    publicInputs: proof.publicInputs,
    nullifier: execution.returnValue,
    witnessMs: Math.round(t1 - t0),
    proveMs: Math.round(performance.now() - t1),
    system: "UltraHonk",
  };
}

/** Verify with the registry's published verification key only. Returns { ok, ms, error }. */
export async function verify({ proof, publicInputs }, verificationKeyB64) {
  const z = await zk();
  const t0 = performance.now();
  try {
    const ok = await z.verifier.verifyProof({ proof: b64.decode(proof), publicInputs, verificationKey: b64.decode(verificationKeyB64) });
    return { ok: !!ok, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { ok: false, ms: Math.round(performance.now() - t0), error: String(e?.message || e).slice(0, 160) };
  }
}

/** Name the public inputs of a proof. */
export const namedInputs = (publicInputs) => Object.fromEntries(PUBLIC_INPUTS.map((k, i) => [k, publicInputs[i]]));

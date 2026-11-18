#!/usr/bin/env node
/**
 * Builds the zero-knowledge assets every site loads from shared/zk/:
 *   1. compiles circuits/possession and circuits/hasher with noir_wasm (no nargo binary needed)
 *   2. bundles noir_js + bb.js (Barretenberg UltraHonk) for the browser, with its Web Workers and WASM
 *   3. self-hosts the public CRS slices the prover needs, so no request goes to a third-party CDN
 * Run once after changing a circuit or upgrading a library: npm install && npm run build:zk
 */
import { compile_program, createFileManager } from "@noir-lang/noir_wasm";
import * as esbuild from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUT = join(ROOT, "shared", "zk");
const VENDOR = join(OUT, "vendor");
const NM = join(ROOT, "node_modules");
const BB = join(NM, "@aztec/bb.js/dest/browser/barretenberg_wasm");

// 1. circuits
mkdirSync(OUT, { recursive: true });
for (const name of ["possession", "hasher"]) {
  const t0 = Date.now();
  const r = await compile_program(createFileManager(join(ROOT, "circuits", name)));
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(r.program));
  console.log(`circuit ${name}: compiled in ${Date.now() - t0} ms`);
}

// 2. browser bundle
rmSync(VENDOR, { recursive: true, force: true });
mkdirSync(VENDOR, { recursive: true });
const entry = join(OUT, ".entry.js");
writeFileSync(entry, 'export { Noir } from "@noir-lang/noir_js";\nexport { Barretenberg, UltraHonkBackend, UltraHonkVerifierBackend } from "@aztec/bb.js";\n');
const common = { bundle: true, format: "esm", platform: "browser", target: "es2022", minify: true, legalComments: "eof", logLevel: "warning", conditions: ["browser"], nodePaths: [NM], define: { "process.env.NODE_DEBUG": "false" } };
await esbuild.build({ ...common, entryPoints: { zk: entry }, outdir: VENDOR, splitting: true, chunkNames: "chunks/[name]-[hash]" });
await esbuild.build({
  ...common,
  entryPoints: { "main.worker": `${BB}/barretenberg_wasm_main/factory/browser/main.worker.js`, "thread.worker": `${BB}/barretenberg_wasm_thread/factory/browser/thread.worker.js` },
  outdir: VENDOR, splitting: true, chunkNames: "chunks/w-[name]-[hash]",
});
rmSync(entry);
copyFileSync(join(NM, "@noir-lang/acvm_js/web/acvm_js_bg.wasm"), join(VENDOR, "acvm_js_bg.wasm"));
copyFileSync(join(NM, "@noir-lang/noirc_abi/web/noirc_abi_wasm_bg.wasm"), join(VENDOR, "noirc_abi_wasm_bg.wasm"));

// 3. self-hosted CRS: point bb.js at ./crs next to zk.js instead of its CDN
const zkPath = join(VENDOR, "zk.js");
let zk = readFileSync(zkPath, "utf8");
const hosts = ['"https://crs.aztec-cdn.foundation"', '"https://crs.aztec-labs.com"'];
if (!hosts.every((h) => zk.includes(h))) throw new Error("CRS host strings not found in the bb.js bundle; check the bb.js version.");
for (const h of hosts) zk = zk.replaceAll(h, 'new URL("./crs",import.meta.url).href');
writeFileSync(zkPath, zk);

const CRS = join(VENDOR, "crs");
const CACHE = join(ROOT, "scripts", ".crs-cache");
mkdirSync(CRS, { recursive: true });
mkdirSync(CACHE, { recursive: true });
// Barretenberg needs the G1 points in 4 MB blocks; 2^17 points cover this circuit with room to spare.
const files = [
  ["g1_compressed.dat", 4194304],
  ["g2.dat", 0],
  ["grumpkin_g1_v2.dat", 4194304],
];
for (const [name, bytes] of files) {
  const cached = join(CACHE, name);
  if (!existsSync(cached) || (bytes && statSync(cached).size !== bytes)) {
    const res = await fetch(`https://crs.aztec-cdn.foundation/${name}`, bytes ? { headers: { Range: `bytes=0-${bytes - 1}` } } : {});
    if (!res.ok) throw new Error(`CRS ${name}: HTTP ${res.status}`);
    writeFileSync(cached, new Uint8Array(await res.arrayBuffer()));
  }
  copyFileSync(cached, join(CRS, name));
  console.log(`crs ${name}: ${statSync(join(CRS, name)).size} bytes`);
}
writeFileSync(join(OUT, "versions.json"), JSON.stringify({
  noir_js: JSON.parse(readFileSync(join(NM, "@noir-lang/noir_js/package.json"))).version,
  noir_wasm: JSON.parse(readFileSync(join(NM, "@noir-lang/noir_wasm/package.json"))).version,
  bb_js: JSON.parse(readFileSync(join(NM, "@aztec/bb.js/package.json"))).version,
  proving_system: "UltraHonk (Barretenberg)",
  srs_size: 2 ** 17,
}, null, 2));
console.log(`zk bundle ready in ${VENDOR}`);

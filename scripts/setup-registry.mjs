#!/usr/bin/env node
/**
 * Issues the demo registry: certifies a set of unique artifacts, gives each one a random secret code,
 * builds the commitment tree and the circuit's verification key, and hands each vendor its private vault.
 *
 * Outputs
 *   registry/registry-data.json   public: root, depth, item count, verification key, circuit fingerprint
 *   registry/custody.json         public: nullifier -> registered holder (reveals no item or secret)
 *   vendor-<id>/vault.json        vendor's private item codes (see the note on demo vaults in the README)
 *   registry-secrets/ledger.json  full ledger with secrets (gitignored, never published)
 *
 * Re-running issues new secrets, so every vendor vault and proof changes. Run: npm run setup:registry
 */
import { Noir } from "@noir-lang/noir_js";
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEPTH, buildTree, pathFor, leafInputs, b64, categoryCode } from "../shared/merkle.js";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const zk = (f) => JSON.parse(readFileSync(join(ROOT, "shared", "zk", f), "utf8"));
const hasher = new Noir(zk("hasher.json"));
const hashOut = async (item, l = "0", r = "0") => (await hasher.execute({ item, left: l, right: r })).returnValue;
const secret = () => "0x" + randomBytes(31).toString("hex"); // < field modulus

// Certified inventory. holder = vendor id that received the item code. list/floor prices are the vendor's.
const ITEMS = [
  { id: "NL-MET-01", holder: "northlight", category: "meteorite", title: "Iron meteorite fragment, Campo del Cielo strewn field", measure: 72, cert_year: 2019, list: 560, floor: 500, shape: "meteorite" },
  { id: "NL-COI-02", holder: "northlight", category: "coin", title: "Gold trade coin, struck 1907", measure: 33, cert_year: 2020, list: 2400, floor: 2200, shape: "coin" },
  { id: "NL-DOC-03", holder: "northlight", category: "document", title: "Polar expedition logbook page, 1911", measure: 1, cert_year: 2021, list: 1800, floor: 1650, shape: "document" },
  { id: "AU-MET-01", holder: "atelier", category: "meteorite", title: "Pallasite slice with olivine crystals", measure: 58, cert_year: 2021, list: 640, floor: 560, shape: "pallasite" },
  { id: "AU-MIN-02", holder: "atelier", category: "mineral", title: "Rhodochrosite crystal cluster", measure: 120, cert_year: 2022, list: 900, floor: 820, shape: "crystal" },
  { id: "AU-ART-03", holder: "atelier", category: "artwork", title: "Stone lithograph, edition 12 of 50", measure: 1, cert_year: 2023, edition_no: 12, edition_size: 50, list: 1200, floor: 1080, shape: "artwork" },
  { id: "AU-MET-04", holder: "atelier", category: "precious_metal", title: "Native gold nugget", measure: 31, cert_year: 2020, list: 3100, floor: 2900, shape: "nugget" },
  { id: "RG-MIN-90", holder: null, category: "mineral", title: "Blue benitoite crystal (in registry storage)", measure: 9, cert_year: 2018, shape: "crystal" },
  { id: "RG-MET-91", holder: null, category: "meteorite", title: "Stony meteorite, oriented (in registry storage)", measure: 210, cert_year: 2017, shape: "meteorite" },
];

const ledger = [];
for (const it of ITEMS) {
  const rec = { ...it, secret: secret(), category_code: categoryCode(it.category), edition_no: it.edition_no || 1, edition_size: it.edition_size || 1 };
  const fields = leafInputs({ ...rec, category: rec.category_code });
  const [leaf, , nullifier] = await hashOut(fields);
  ledger.push({ ...rec, leaf, nullifier });
}
const { levels, root } = await buildTree(ledger.map((r) => r.leaf), async (l, r) => (await hashOut(["0", "0", "0", "0", "0", "0"], l, r))[1]);
ledger.forEach((r, i) => Object.assign(r, { index: i, ...pathFor(levels, i) }));

// Verification key for the possession circuit (same for every proof; the hub verifies with it alone).
const possession = zk("possession.json");
const api = await Barretenberg.new({ threads: 4 });
const vk = await new UltraHonkBackend(possession.bytecode, api).getVerificationKey();
await api.destroy();
const circuitHash = createHash("sha256").update(possession.bytecode).digest("hex");

mkdirSync(join(ROOT, "registry"), { recursive: true });
writeFileSync(join(ROOT, "registry", "registry-data.json"), JSON.stringify({
  registry: "Proove Artifact Registry",
  root, depth: DEPTH, items_certified: ledger.length, issued: new Date().toISOString().slice(0, 10),
  categories: [...new Set(ledger.map((r) => r.category))],
  circuit: { name: "possession", sha256: circuitHash, proving_system: "UltraHonk (Barretenberg)", public_inputs: ["root", "category", "edition_size", "min_measure", "min_year", "listing", "nullifier"] },
  verification_key: b64.encode(vk),
}, null, 2) + "\n");
writeFileSync(join(ROOT, "registry", "custody.json"), JSON.stringify({
  note: "Nullifier -> registered holder. A nullifier identifies an item's possession proofs, never the item itself.",
  root,
  records: ledger.map((r) => ({ nullifier: r.nullifier, holder: r.holder || "registry", status: "held" })).sort((a, b) => a.nullifier.localeCompare(b.nullifier)),
}, null, 2) + "\n");

const publicItem = (r) => ({
  id: r.id, title: r.title, category: r.category, category_code: r.category_code, measure: r.measure, cert_year: r.cert_year,
  edition_no: r.edition_no, edition_size: r.edition_size, list: r.list, floor: r.floor, shape: r.shape,
  secret: r.secret, index: r.index, path: r.path, bits: r.bits,
});
const vault = (vendor, items) => writeFileSync(join(ROOT, `vendor-${vendor}`, "vault.json"), JSON.stringify({
  note: "Demo vault. A real vendor keeps item codes private (device storage, HSM or the tag itself); a static demo site can only ship them as a file.",
  vendor, root, items,
}, null, 2) + "\n");
vault("northlight", ledger.filter((r) => r.holder === "northlight").map(publicItem));
vault("atelier", ledger.filter((r) => r.holder === "atelier").map(publicItem));

// The dishonest vendor: one copied code (photographed from Northlight's meteorite) and one counterfeit never certified.
const copied = ledger.find((r) => r.id === "NL-MET-01");
vault("shady", [
  { ...publicItem(copied), id: "SR-MET-07", title: "Iron meteorite fragment, Argentina (bargain!)", list: 390, floor: 360, cheat: "copied_code" },
  { id: "SR-MET-08", title: "Martian meteorite slice, 95 g", category: "meteorite", category_code: 1, measure: 95, cert_year: 2022, edition_no: 1, edition_size: 1, list: 350, floor: 320, shape: "meteorite",
    secret: secret(), index: 5, path: copied.path, bits: copied.bits, cheat: "counterfeit" },
]);

mkdirSync(join(ROOT, "registry-secrets"), { recursive: true });
writeFileSync(join(ROOT, "registry-secrets", "ledger.json"), JSON.stringify({ root, ledger }, null, 2));
console.log(`registry root ${root.slice(0, 18)}… · ${ledger.length} items · vk ${vk.length} bytes · circuit ${circuitHash.slice(0, 12)}…`);
console.log(`vaults: northlight ${ledger.filter((r) => r.holder === "northlight").length}, atelier ${ledger.filter((r) => r.holder === "atelier").length}, shady 2 (1 copied code, 1 counterfeit)`);

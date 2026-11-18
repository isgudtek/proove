# Proove

An open agentic marketplace for **unique artifacts** (meteorite fragments, rare minerals, precious-metal pieces, antique coins, limited-edition art, historic documents) where a vendor cannot just claim to have an item. Every offer carries a **zero-knowledge proof of possession** of an item certified by an independent registry. The buyer's agents verify each proof in the browser, against the registry's own verification key, before anything can be bought.

Live: **https://isgudtek.github.io/proove/** (start with the [Buyer Hub](https://isgudtek.github.io/proove/hub/)).

Five static sites, each a conforming *open agentic website* (worldwide-agentic-web-mvp-0.2: published `agent-manifest.json`, agent network definition, `window.OpenAgenticWeb`, postMessage RPC with origin checks and consent, human approval for every write):

| Site | Role | Agents |
| --- | --- | --- |
| `registry/` · Proove Artifact Registry | Certifies items. Publishes only a commitment root and a verification key; answers custody checks; records transfers. | `registry_clerk` (rule-based) |
| `vendor-northlight/` · Northlight Collectibles | Honest vendor | `curator_agent`, `prover_agent` (rule-based, ZK), `sales_agent` |
| `vendor-atelier/` · Atelier Unique | Honest vendor | same runtime, its own vault and prices |
| `vendor-shady/` · Shady Rocks | **Deliberately dishonest demo vendor** | same runtime; lists a copied item and a counterfeit |
| `hub/` · Proove Buyer Hub | Buyer side | `intake_agent`, `discovery_agent`, `verifier_agent` (rule-based), `image_agent`, `negotiator_agent` |

## The demo in one run

Hub prompt: *"A certified meteorite fragment, at least 50 g, budget $520"*.

1. **intake_agent** turns the request into requirements (category, minimum grams, certification year, edition size, budget).
2. **discovery_agent** reads the registry's manifest and `registry-data.json` (root, verification key, circuit fingerprint) and every vendor's manifest, and shortlists vendors publishing `zk.possession.prover`.
3. The hub opens a live 2×2 split view (registry and three vendors) and asks every vendor for offers over postMessage RPC. Each vendor's `curator_agent` matches its vault; its `prover_agent` generates an UltraHonk proof per offer **in that vendor's page** (about 2.5 s each, single-threaded WASM).
4. **verifier_agent** (deterministic: a model can never mark a proof valid) checks each offer:
   - cryptographic verification with the **registry's** verification key (about 40–70 ms),
   - the proof's root is the registry's current root,
   - the proof is bound to this vendor and this listing (`listing` public input),
   - the proven claims meet the buyer's requirements,
   - the registry's custody record for the proof's nullifier says this vendor holds the item.
5. Result:
   - Northlight, iron meteorite, $560: **verified holder**
   - Atelier, pallasite, $640: **verified holder**, over budget
   - Shady Rocks, "bargain" meteorite, $390: valid proof, but the nullifier is registered to Northlight. **Rejected: duplicate item (copied code).**
   - Shady Rocks, "Martian meteorite", $350: not in the registry, so it cannot be proven; the vendor attaches a forged proof. **Rejected: proof failed.**
6. **image_agent** writes a search query per offer (a model with your key, or a rule-based query in Demo Mode) and finds an openly licensed reference photo on Wikimedia Commons. The photo appears on the offer card and in the vendor's pane, with author and license.
7. You choose an offer (or "Let the agent pick"). **negotiator_agent** negotiates within the budget ($560 → $520) against the vendor's `sales_agent`, which enforces its floor.
8. Three separate approvals: you approve `place_order` in the hub, the vendor's owner approves `confirm_sale` in the vendor pane, the registry's owner approves `record_transfer` in the registry pane. The registry now lists you as the holder; neither Northlight nor Shady can sell that item again.

## Watching it work

- **Live workflow:** a diagram of the five sites and their agents. Nodes light up on each handoff, packets travel along the pipes for every manifest fetch and RPC call, approvals pulse amber, and verification colours each vendor green or red. **Pop out** shows it full screen.
- **Split view:** the registry and the three vendors run live side by side. **Pop out** on any pane shows that site full size, in its normal layout with its own agent stream, without reloading it, so the RPC connection and the deal continue. **New tab** opens a separate copy.

## Reference photos

Photos come from a keyless [Wikimedia Commons API](https://commons.wikimedia.org/w/api.php) search at run time; no image is stored in this repo. Only public-domain, CC0, CC BY and CC BY-SA results are used, and each is shown with its author, license and a link to its Commons page. They show the *type* of artifact and are labelled "Reference photo, not the certified item". If you set an Otari key in the hub's Model settings, `image_agent` writes the queries with the model. The key is never sent to the vendors; they only receive the photo record, and accept it only if it points at Wikimedia's image hosts with an open license.

## What the proof says

Circuit [`circuits/possession/src/main.nr`](circuits/possession/src/main.nr) (Noir, Pedersen hashes, depth-8 Merkle tree, 256 items):

> I know the secret code of an item in the registry's commitment tree with root `root`, whose category is `category`, edition size is `edition_size`, mass is at least `min_measure` grams and certification year is at least `min_year`. This proof is bound to `listing`. Its nullifier is `H(secret, "proove")`.

- Public inputs: `root, category, edition_size, min_measure, min_year, listing`, plus the returned `nullifier`.
- Private: the secret code, the edition number, the exact mass and year, the Merkle path.
- `min_measure` and `min_year` are the **buyer's** thresholds, so the proof reveals only what the buyer asked for, not the exact values.
- `listing` = first 31 bytes of SHA-256(`proove|<vendor_id>|<listing_id>`). A proof copied to another listing or vendor fails the binding check; editing any public input breaks verification.
- The nullifier is the same for every proof about one item. That is how duplicate listings are detected, and how the registry's custody record (nullifier → holder) is checked without revealing which item it is.

### Honest limits

- **"Possession" means knowledge of the item's secret code**, the code the registry issued with the certificate. It does not prove physical custody. Whoever learns the code can prove; that is why custody is checked against the registry and transfers are recorded.
- **Demo vaults are public.** A real vendor keeps its codes private. Here each `vendor-*/vault.json` ships its codes so the static demo can prove in the browser; the registry's issuing ledger (`registry-secrets/`) is not published. The registry knows every code it issued, so the registry is trusted; it is not a trustless system.
- Custody records live in the registry page's `localStorage` (seeded from `registry/custody.json`), because the sites are static. Transfers are therefore recorded per browser; clearing the site data resets the demo.
- The listings themselves (title, photo, price) are public. The zero-knowledge part is that a vendor proves it holds a certified item satisfying the claims without disclosing the secret code or the item's exact certified attributes.
- Proving runs single-threaded because GitHub Pages cannot send the COOP/COEP headers multithreaded WASM needs.

## Run locally

```bash
npm install          # Noir compiler + noir_js + bb.js + esbuild (dev only)
npm start            # registry :62270, vendors :62271-62273, hub :62274
open http://localhost:62274/
npm run verify       # HTTP conformance checks against the five local sites
```

Everything the browser needs is already built and committed under `shared/zk/`. To rebuild:

```bash
npm run build:zk         # compile circuits/ to shared/zk/*.json, bundle the prover, fetch and trim the CRS
npm run setup:registry   # issue a new registry: secrets, tree, root, verification key, custody, vendor vaults
npm run build:pages      # docs/ for GitHub Pages (URLs rewritten, .well-known aliases, cache busting)
npm run verify:pages     # the same checks against the live site
```

No model key is needed: Demo Mode answers deterministically. In the hub's **Model settings** you can bring a Mozilla Otari key or use Chrome's on-device Gemini Nano for the model-driven agents. **The four sites in the split view inherit the hub's settings** (mode, Otari region, model and key) over the `useSettings` RPC method, so one key drives every agent in the simulation. They keep the lent settings in memory only; saving or deleting settings on one of those sites switches it back to its own. In a real marketplace you would not lend your key to vendors. Proof generation and verification never involve a model.

## Layout

```
circuits/possession     Noir possession circuit
circuits/hasher         same Pedersen hashes, executed (not proved) to build the tree off-circuit
shared/                 oaw-core.js (runtime, RPC, manifest validation), oaw-ui.js, merkle.js, zk-client.js,
                        image-search.js (Commons search), proove.css
shared/zk/              compiled circuits, bundled noir_js + bb.js, workers, WASM, self-hosted CRS (8 MB)
registry/               registry site + registry-data.json + custody.json
vendor/                 shared vendor storefront code; vendor-*/ add shop.json, manifest, network, vault, theme
hub/                    buyer hub
scripts/                build-zk, setup-registry, build-sites, verify
docs/                   GitHub Pages build output
```

## Security notes

- Each site's Content-Security-Policy allows only its own scripts (plus `'wasm-unsafe-eval'` for the prover WASM); images only from itself and Wikimedia's image hosts.
- RPC: apart from `ping` and `manifest`, requests are answered only after an origin check (manifest `trusted_origins`) or the user's consent; each RPC client also checks `event.source`, so a reply from another frame on the same origin is ignored.
- Every write (`place_order`, `confirm_sale`, `record_transfer`) pauses for its own site owner's approval; the hub's policy never orders above budget or an unverified offer.
- The CRS is self-hosted; no third-party CDN is contacted for proving.

## Credits and licenses

Proove is MIT-licensed (see [LICENSE](LICENSE)). Third-party components:

- [Noir](https://github.com/noir-lang/noir): `@noir-lang/noir_js`, `noir_wasm`, `noirc_abi`, `types` (MIT OR Apache-2.0), `acvm_js` (MIT), by Aztec Labs and contributors
- [Barretenberg `@aztec/bb.js`](https://github.com/AztecProtocol/aztec-packages) 5.3.0 (MIT), UltraHonk prover and verifier
- Aztec's published CRS files (public BN254 and Grumpkin parameters from crs.aztec-cdn.foundation), trimmed to 2^17 points and self-hosted
- Reference photos: Wikimedia Commons contributors, under each photo's own open license (shown with the photo), fetched at run time
- [esbuild](https://esbuild.github.io/) (MIT), build only

Built for the Cognizant AI Lab **Open Agentic Web Challenge** with Kiro CLI.

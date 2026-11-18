# Proove: unique artifacts, proven in zero knowledge

**Tagline:** Agentic vendors must prove they hold a certified artifact before your agents will buy it. Proofs are generated and verified in the browser.

# Inspiration

In an agentic web, agents from sites that have never met will buy from each other. For ordinary goods a vendor's word is enough. For **unique artifacts** it is not: a meteorite fragment, a rare mineral, a gold nugget, an antique coin, a numbered art print or a historic document exists once. If two vendors list "the same" item, or a vendor lists an item it does not have, the buyer's agent needs to find out before it pays.

Certificates do not solve this on their own, because a certificate can be copied. We wanted a vendor agent to show **evidence that it holds a certified item**, without revealing the item's secret certificate code, and a buyer agent to check that evidence itself, with no server to trust and no model judging it.

# What it does

**Proove** is five independent agentic websites: one registry, three vendors and one buyer hub.

- **Proove Artifact Registry** certifies items. It publishes only a **commitment root** (a Merkle root over all certified items) and a **verification key**. It answers custody checks and records transfers.
- **Northlight Collectibles** and **Atelier Unique** are honest vendors. **Shady Rocks** is a deliberately dishonest demo vendor: it lists a meteorite using a code copied from Northlight's certificate, and a "Martian meteorite" that was never certified.
- **Proove Buyer Hub** is the buyer's side. You type, for example, *"A certified meteorite fragment, at least 50 g, budget $520"*.

The flow:

1. `intake_agent` turns the request into requirements: category, minimum grams, certification year, edition size, budget.
2. `discovery_agent` reads the registry's manifest, root and verification key, then every vendor's `agent-manifest.json`, and shortlists vendors that publish `zk.possession.prover`.
3. The hub opens a live split view of all four sites and asks every vendor for offers. In each vendor's page, `curator_agent` matches the vault and `prover_agent` generates a **zero-knowledge proof for each offer** (about 2.5 s each, in the browser).
4. `verifier_agent` checks every offer. It is rule-based, so a model can never mark a proof as valid. It verifies the proof with the **registry's** key (40 to 70 ms) and checks the root, the listing binding, the claims against your requirements, and who the registry says holds the item.
5. On screen:
   - Northlight, $560: **Verified holder**
   - Atelier, $640: **Verified holder**, over budget
   - Shady Rocks, $390: the proof is valid, but the registry records the item as held by Northlight. **Duplicate item (copied code)**
   - Shady Rocks, $350: the item is not in the registry, so no valid proof exists; the forged proof attached to it **fails verification**
6. `image_agent` finds an openly licensed reference photo for every offer on Wikimedia Commons (keyless search) and shows it, credited, in the hub and in the vendor's page.
7. You choose a verified offer, or let the agent pick. `negotiator_agent` bargains within your budget against the vendor's `sales_agent` ($560 → $495 → $530 → **$520**).
8. Three owners approve three writes: you approve the purchase in the hub, the vendor approves the sale in its pane, the registry approves the custody transfer in its pane. The registry now lists you as the holder, so nobody else can sell that item again.

**What the proof states.** "I know the secret code of an item in this registry's tree; its category and edition size are these; it weighs at least the buyer's minimum and was certified no earlier than the buyer's year; this proof is bound to this vendor's listing." It does not reveal the code, the exact weight or year, or the item's position in the registry. Its nullifier is the same for every proof about one item, so duplicate listings show up, and custody can be checked without revealing which item it is.

# How we built it

- **Zero-knowledge stack:** a **Noir** circuit (Pedersen hashes, a depth-8 Merkle path, range checks, a listing binding, a nullifier) proved with **Barretenberg UltraHonk** through `@aztec/bb.js`. Proving and verifying both run as WASM in the browser. Everything is self-hosted on GitHub Pages, including the 8 MB of public CRS parameters: we trimmed the CRS to the 2^17 points the circuit needs, so no CDN is contacted and start-up dropped from 52 s to about 3 s.
- **Same hashes everywhere:** the registry tree is built with a second Noir "hasher" circuit that is executed (not proved), so the Node setup script and the browsers compute exactly the hashes the circuit checks.
- **The open agentic web spec (MVP Profile 0.2):** every site publishes `agent-manifest.json` (and `.well-known/`), an agent network file, `window.OpenAgenticWeb`, and postMessage RPC with origin checks, consent and human approval for every write. The registry also publishes the ZK statement, its public inputs and the circuit fingerprint in its manifest.
- **The model proposes, the code decides:** intake, discovery, curation and negotiation can run on **Mozilla Otari** (your key), **Gemini Nano** on-device, Hybrid, or a no-key Demo Mode. Verification, budgets and price floors are plain functions.
- **One vendor codebase, three businesses:** each vendor folder holds only its shop profile, manifest, network, vault and colour theme.
- **Static by design:** no backend. A build script rewrites URLs for GitHub Pages, adds `.well-known` aliases and content-hash cache busting. A conformance script checks all five sites over HTTP, including that the published circuit matches the registry's fingerprint.
- Built with **Kiro CLI**.

# Challenges we ran into

- **Licensing.** The common Circom/snarkjs stack is GPL-3.0, which did not fit an MIT project, so we chose Noir and bb.js (MIT / Apache-2.0).
- **No cross-origin isolation on GitHub Pages**, so no multithreaded WASM. We measured single-threaded proving at about 2.5 s, which is fast enough.
- **CRS loading:** bb.js downloaded 16.8 MB from a CDN on every load. We self-host trimmed files; the compressed G1 file must be an exact multiple of 4 MB or initialisation fails.
- **Being honest about what "possession" means:** the proof shows knowledge of the certificate's secret code, not physical custody. Custody records and transfers at the registry close the gap for copied codes. We state the limits in the README.

# Accomplishments that we're proud of

- A cheating vendor is caught in two different ways, and both are visible: a **copied code** (valid proof, wrong holder) and a **counterfeit** (forged proof fails).
- Real proofs, generated and verified in an ordinary browser tab, on a static host, in seconds.
- A live workflow diagram (pop-out) shows every handoff, RPC call, proof verdict and approval across the five sites; any site pane pops out to full size without breaking the deal.
- Four sites running side by side, each with its own agents, its own owner and its own approvals, talking only through published manifests and postMessage.

# What we learned

- Zero-knowledge proofs fit agent commerce well: they give a buyer agent something it can check deterministically, instead of trusting another agent's text.
- The useful split is "models negotiate, math verifies".
- Binding a proof to one listing, plus a nullifier per item, covers most of the replay and duplicate cases.

# What's next

- Registry signatures on custody records, so custody can be checked without opening the registry page.
- Vendor vaults kept in the browser's secure storage instead of a demo file.
- More registries per category, and proofs about provenance chains.

# Built with

noir · barretenberg · ultrahonk · zero-knowledge-proofs · webassembly · javascript · svg · wikimedia-commons-api · mozilla-otari · gemini-nano · chrome-prompt-api · postmessage · github-pages · kiro

---

## Hackathon checklist (for us, not for the Devpost form)

- [x] Public repo with MIT license and third-party credits: https://github.com/isgudtek/proove
- [x] Working live demo, no key needed (Demo Mode): https://isgudtek.github.io/proove/
- [x] Every site conforms to MVP Profile 0.2 (`npm run verify:pages`)
- [x] Different from our Open Agentic Diorama Market entry: a new problem (proving possession of unique items), a new trust model (registry with zero-knowledge proofs), new circuits, a new registry site, a dishonest vendor that gets caught, and three-party approvals. Only the open agentic runtime (`oaw-core.js`, `oaw-ui.js`) is shared.
- [ ] Demo video on YouTube, leading with the ZK verification (Shady Rocks rejected twice)
- [ ] Add the video and Devpost links to the landing page (`PROOVE_VIDEO=... PROOVE_DEVPOST=... npm run build:pages`)

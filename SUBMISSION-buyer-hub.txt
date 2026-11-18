## Inspiration

Agents from websites that have never met will soon buy from each other. For ordinary goods, a vendor's word is enough. For unique artifacts it is not. A meteorite fragment, a rare mineral or an antique coin exists once, and a vendor can list the same item twice or list one it never had. A buyer's agent needs evidence before it pays.

A certificate alone does not solve this, because a certificate can be copied. We wanted a vendor's agent to prove it holds a certified item without revealing the item's secret code, and a buyer's agent to check that proof itself, with no server and no language model judging it.

## What it does

Proove Buyer Hub is the buyer's side of Proove, a marketplace of five independent agentic websites. You type a request such as "A certified meteorite fragment, at least 50 g, budget $520", and the hub's agents do the rest:

1. **intake_agent** turns the request into requirements: category, minimum grams, certification year, edition size and budget.
2. **discovery_agent** reads the registry's public manifest, its commitment root and verification key, and each vendor's `agent-manifest.json`. It shortlists vendors that publish `zk.possession.prover`.
3. The hub opens a live split view of the registry and the vendors. Each vendor's agents match its vault and generate a zero-knowledge proof for every offer, in the vendor's own page.
4. **verifier_agent** checks every offer with rules, not a model. It verifies the proof with the registry's verification key, then checks the registry root, the listing binding, the claims against your requirements, and the registry's custody record.
5. **image_agent** writes a search query per offer and finds an openly licensed reference photo on Wikimedia Commons. The photo is credited, and it is labelled as a reference, not the certified item.
6. You choose an offer, or let the agent pick. **negotiator_agent** bargains within your budget against the vendor's sales agent.
7. Three owners approve three writes: you approve the purchase in the hub, the vendor approves the sale, and the registry approves the custody transfer. The registry then lists you as the holder.

In the demo, the hub rejects two offers from Shady Rocks, a deliberately dishonest vendor. One offer reuses a code copied from another vendor's listing, so the registry shows a different holder. The other offer is a counterfeit whose proof fails verification. The hub buys the verified Northlight meteorite for $520.

A live workflow diagram shows every handoff, RPC call, proof verdict and approval across the five sites. Each site pane can be popped out to full size. The registry and the vendors inherit the hub's model settings, so one Otari key or one Gemini Nano setting drives all the agents. Verification never uses a model.

## How we built it

- **Zero-knowledge proofs:** a Noir circuit with Pedersen hashes and a depth-8 Merkle path. It proves knowledge of an item's secret code, that the item's claims meet the buyer's thresholds, and that the proof is bound to one listing. Barretenberg UltraHonk proves and verifies in the browser, using WebAssembly.
- **Registry:** the hasher circuit builds the Merkle tree off-circuit, so the setup script and the browsers compute the same hashes. The registry publishes only the root, the verification key and the circuit fingerprint.
- **Agent runtime:** one vanilla JavaScript runtime for all five sites. Each site publishes an `agent-manifest.json` and an agent network, exposes `window.OpenAgenticWeb`, and talks over `postMessage` with origin checks, consent prompts and human approval for every write.
- **Models:** intake, discovery, query writing and negotiation run on Mozilla Otari with your key, on Gemini Nano, or in a deterministic Demo Mode with no key.
- **Hosting:** static files on GitHub Pages. A build script rewrites URLs, adds `.well-known` aliases and adds content hashes for cache busting. A verify script checks all five sites over HTTP, including that the published circuit matches the registry's fingerprint.
- **Licensing:** MIT. We chose Noir and Barretenberg (MIT and Apache-2.0) because the usual Circom stack is GPL-3.0.

## Challenges we ran into

- **Licensing:** the common zero-knowledge stack did not fit an MIT project, so we rebuilt the proof system on Noir and Barretenberg.
- **Start-up time:** the default proving setup downloaded about 17 MB and took 52 seconds to start. We trimmed the public parameters to the size the circuit needs and host them ourselves, so the page starts in a few seconds.
- **No threads on Pages:** GitHub Pages cannot send the headers that multithreaded WebAssembly needs. Proving runs on one thread and takes about 3 seconds per offer, which is fast enough.
- **Reference photos:** the first image URLs we tried were blocked by our own Content Security Policy, because Wikimedia serves thumbnails from a second host. A keyless Commons search works from the browser, but some results are loose matches. A query from a model helps more than a rule.
- **Layout:** the four live panes overflowed the window on laptop screens. We fixed the grid, shortened long labels, and added a Pop out for the whole grid.

## Accomplishments that we're proud of

- A dishonest vendor is caught two different ways in one run: a copied code, which a valid proof cannot hide because the registry knows the real holder, and a counterfeit, whose forged proof fails.
- Real zero-knowledge proofs, generated and verified in an ordinary browser tab on a static host.
- Five sites with their own agents, owners and approvals, talking only through published manifests and `postMessage`.
- The full flow runs end to end on the live GitHub Pages site, with no console errors.

## What we learned

- Zero-knowledge proofs suit agent commerce. A buyer's agent gets something it can check deterministically, instead of another agent's word.
- A good split is "models negotiate, math verifies". The verifier is rule-based, so no model can approve a bad proof.
- Binding each proof to one listing and giving each item a nullifier covers most copy and duplicate cases.
- Be exact about what a proof means. Here it shows knowledge of the certificate's secret code, not physical custody. Custody is checked separately at the registry, and the README states the limits.

## What's next for Proove Buyer Hub

- **Better reference photos:** a model writes the search queries when you add a key. Next, we would check each photo against a hash the registry publishes for its certified item, so a photo can be linked to the certificate.
- **Private vaults:** the demo ships vault codes so the static site can prove in the browser. A real vendor would prove on its own server or device, and keep its codes private.
- **Persistent custody:** custody lives in each browser's storage. The next step is a signed custody ledger that any buyer can check.
- **Safer key handling:** the demo lends your model key to the sites in the split view. A real marketplace would never do that, and would issue scoped, spending-limited keys to each agent.
- **More categories and registries:** more artifact types, and registries run by independent certifiers.

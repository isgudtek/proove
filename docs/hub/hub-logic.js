/**
 * hub-logic.js: buyer-side rules for Proove (no DOM). Requirements parsing, offer verification verdicts,
 * ranking and buyer negotiation policy. The model proposes; these functions decide.
 */
import { CATEGORIES, PUBLIC_INPUTS, sameField } from "../shared/merkle.js?v=c8a3d2e978";

export const MAX_ROUNDS = 3;
const KEYS = Object.values(CATEGORIES).map((c) => c.key);
const round5 = (v) => Math.round(v / 5) * 5;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (v === null || v === "" || v === undefined ? null : Number.isFinite(Number(v)) ? Number(v) : null);

const WORDS = {
  meteorite: /meteor|pallasite|chondrite|iron fragment|space rock/i,
  mineral: /mineral|crystal|gem|quartz|rhodochrosite|benitoite|geode/i,
  precious_metal: /gold nugget|nugget|precious metal|platinum|silver bar|ingot|native gold/i,
  coin: /coin|numismat|trade coin|struck/i,
  artwork: /art|lithograph|print|edition|painting|sculpture/i,
  document: /document|manuscript|letter|logbook|map|autograph/i,
};

/** Demo intake: regex reading of the request. */
export function intakeDeterministic({ request }) {
  const t = String(request || "");
  const categories = KEYS.filter((k) => WORDS[k].test(t));
  const g = t.match(/(?:at least|min(?:imum)?|over|>=?)\s*(\d+(?:\.\d+)?)\s*(?:g|grams?)\b/i) || t.match(/(\d+(?:\.\d+)?)\s*(?:g|grams?)\s*(?:or more|\+|minimum)/i);
  const y = t.match(/(?:certified|since|after|from)\s*(?:in\s*)?((?:19|20)\d\d)/i);
  const ed = t.match(/edition (?:of|size)?\s*(\d+)\s*(?:or (?:fewer|less))?/i) || t.match(/(?:max(?:imum)?|at most)\s*(\d+)\s*(?:copies|prints)/i);
  const b = t.match(/\$\s?(\d[\d,]*(?:\.\d+)?)/) || t.match(/budget[^\d]{0,12}(\d[\d,]*)/i);
  return {
    categories,
    min_measure: g ? Number(g[1]) : null,
    min_year: y ? Number(y[1]) : null,
    max_edition_size: /one[- ]of[- ]a[- ]kind|unique|1 of 1/i.test(t) ? 1 : ed ? Number(ed[1]) : null,
    max_budget: b ? Number(b[1].replace(/,/g, "")) : null,
    summary: t.slice(0, 120),
  };
}

/** Repair the intake model's output with the regex reading as a safety net. */
export function normalizeRequirements(out, input) {
  const fb = intakeDeterministic(input);
  const o = isObj(out) ? out : {};
  const cats = (Array.isArray(o.categories) ? o.categories : []).map((c) => String(c).toLowerCase().replace(/[\s-]+/g, "_")).filter((c) => KEYS.includes(c));
  const pick = (k, lo, hi) => { const v = num(o[k]); return v != null && v >= lo && v <= hi ? v : fb[k]; };
  return {
    categories: cats.length ? [...new Set(cats)] : fb.categories,
    min_measure: pick("min_measure", 0, 100000),
    min_year: pick("min_year", 1900, 2100),
    max_edition_size: pick("max_edition_size", 1, 100000),
    max_budget: num(o.max_budget) > 0 ? num(o.max_budget) : fb.max_budget, // the request's own number wins if the model drops it
    summary: String(o.summary || fb.summary).slice(0, 160),
  };
}

/** Demo discovery: every vendor that publishes the possession prover capability (max 5). */
export function discoveryDeterministic({ vendors }) {
  const list = vendors.filter((v) => (v.capabilities || []).includes("zk.possession.prover")).slice(0, 5);
  return { shortlist: list.map((v) => v.url), reason: `${list.length} vendor(s) publish zk.possession.prover; asking each for proven offers.` };
}
export function normalizeShortlist(out, input) {
  const known = new Set(input.vendors.map((v) => v.url));
  const list = [...new Set((Array.isArray(out?.shortlist) ? out.shortlist : []).filter((u) => known.has(u)))];
  return list.length ? { shortlist: list, reason: String(out?.reason || "").slice(0, 300) } : { ...discoveryDeterministic(input), reason: "Model shortlisted no known vendor; asking every capable one." };
}

/**
 * Verdict on one offer, after the cryptographic check. Order matters: the first failing rule is reported.
 *  crypto: { ok, ms, error }   registry: { root }   custody: { registered, holder, status }
 *  listingField: expected binding for (vendor, listing_id)   req: buyer requirements
 */
export function verdict({ offer, crypto, registry, custody, listingField, req, categoryCode }) {
  const pi = Object.fromEntries(PUBLIC_INPUTS.map((k, i) => [k, offer.public_inputs?.[i]]));
  const fail = (code, text) => ({ ok: false, code, text, inputs: pi });
  if (!crypto.ok) return fail("proof_failed", `Proof failed: the possession proof does not verify${crypto.error ? ` (${crypto.error})` : ""}.`);
  if (!sameField(pi.root, registry.root)) return fail("wrong_root", "Proof is for a different registry root.");
  if (!sameField(pi.listing, listingField)) return fail("not_bound", "Proof is bound to another listing (copied proof).");
  if (!sameField(pi.nullifier, offer.nullifier)) return fail("nullifier_mismatch", "Stated nullifier differs from the proof's.");
  const cat = Number(BigInt(pi.category));
  if (req.categories?.length && !req.categories.map(categoryCode).includes(cat)) return fail("claims", "Proven category is not one you asked for.");
  if (cat !== offer.item?.category_code) return fail("claims", "Listing's category differs from the proven category.");
  if (req.min_measure != null && Number(BigInt(pi.min_measure)) < req.min_measure) return fail("claims", `Proof only guarantees at least ${Number(BigInt(pi.min_measure))} g, not ${req.min_measure} g.`);
  if (req.min_year != null && Number(BigInt(pi.min_year)) < req.min_year) return fail("claims", "Proof does not guarantee the certification year you asked for.");
  if (req.max_edition_size != null && Number(BigInt(pi.edition_size)) > req.max_edition_size) return fail("claims", `Proven edition size ${Number(BigInt(pi.edition_size))} exceeds ${req.max_edition_size}.`);
  if (!custody?.registered) return fail("unknown_item", "The registry has no custody record for this item.");
  if (custody.status !== "held") return fail("sold", `Already sold: the registry records it as ${custody.status}.`);
  if (custody.holder !== offer.vendor) return fail("not_holder", `Duplicate item: the registered holder is ${custody.holder}, not this vendor (copied item code).`);
  return { ok: true, code: "verified", text: `Verified holder · proof checked in ${crypto.ms} ms`, inputs: pi };
}

/** Same nullifier offered by several vendors: mark it on every offer (custody already decides who is right). */
export function duplicates(offers) {
  const by = new Map();
  for (const o of offers) { const k = String(o.nullifier); by.set(k, [...(by.get(k) || []), o]); }
  return new Set([...by.values()].filter((l) => l.length > 1).flat());
}

/** Within budget first, then lowest price, then oldest certification. */
export function rankOffers(offers, budget) {
  const inBudget = (o) => (budget == null || o.price <= budget ? 0 : 1);
  return [...offers].sort((a, b) => inBudget(a) - inBudget(b) || a.price - b.price);
}

/** Demo negotiator: open about 12% under the price (never above budget), then move to the budget. */
export function negotiatorDeterministic({ budget, price, final, round }) {
  if (budget == null || price <= budget) return { action: "accept", counter_price: null, message: "That works for us." };
  if (final) return { action: "walk_away", counter_price: null, message: `Thanks, but ${price} is above our budget.` };
  const counter = round === 1 ? Math.min(budget, round5(price * 0.88)) : budget;
  return { action: "counter", counter_price: counter, message: round === 1 ? "Could you work with this number?" : `${counter} is the most we can spend.` };
}

/** Buyer policy: never accept or order above budget; counters stay between 60% of the price and min(budget, price - 1). */
export function enforceBuyerPolicy(out, { price, budget, final, round }) {
  if (budget == null || price <= budget) return { action: "accept", counter_price: null, message: out?.message || "Accepted.", policy: out?.action && out.action !== "accept" ? "Price is within budget; accepting." : null };
  if (final || round > MAX_ROUNDS) return { action: "walk_away", counter_price: null, message: out?.message || "Above budget.", policy: out?.action !== "walk_away" ? `Final offer ${price} is above the budget ${budget}; walking away.` : null };
  if (out?.action === "walk_away") return { action: "walk_away", counter_price: null, message: out.message || "", policy: null };
  const raw = out?.counter_price;
  let c = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  let policy = null;
  if (out?.action === "accept") { c = budget; policy = `Negotiator tried to accept ${price}, above the budget ${budget}; countering at the budget instead.`; }
  if (!Number.isFinite(c) || c <= 0) { c = budget; policy = policy || "No counter price given; using the budget."; }
  const hi = Math.min(budget, price - 1), lo = Math.min(hi, Math.round(price * 0.6));
  const clamped = Math.round(Math.min(hi, Math.max(lo, c)));
  if (clamped !== Math.round(c) && !policy) policy = `Counter ${Math.round(c)} adjusted to ${clamped}.`;
  return { action: "counter", counter_price: clamped, message: String(out?.message || "").slice(0, 300), policy };
}

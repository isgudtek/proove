/**
 * vendor-logic.js: vendor business rules (no DOM). The model proposes; these functions decide.
 */
export const MAX_ROUNDS = 3;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round5 = (v) => Math.round(v / 5) * 5;

/** Items that satisfy a buyer's requirements (category, minimum measure, certification year, edition size). */
export function matchItems(req, items) {
  const cats = Array.isArray(req.categories) && req.categories.length ? req.categories : null;
  return items.filter((it) => !it.sold
    && (!cats || cats.includes(it.category))
    && (req.min_measure == null || it.measure >= req.min_measure)
    && (req.min_year == null || it.cert_year >= req.min_year)
    && (req.max_edition_size == null || it.edition_size <= req.max_edition_size));
}

/** Demo curator: every matching item, with a one-line pitch. */
export function curatorDeterministic({ requirements, catalog }) {
  const m = matchItems(requirements, catalog);
  return { matches: m.map((it) => ({ item_id: it.id, pitch: `${it.title}${it.measure > 1 ? `, ${it.measure} g` : ""}, certified ${it.cert_year}${it.edition_size > 1 ? `, edition ${it.edition_size}` : ""}.` })) };
}

/**
 * What the proof will claim publicly. The proof states "measure >= min_measure" and "certified >= min_year"
 * using the buyer's thresholds, so it reveals only what the buyer asked for, not the item's exact values.
 */
export function claimsFor(item, req) {
  return {
    category: item.category_code,
    edition_size: item.edition_size,
    min_measure: Math.max(0, Math.floor(req.min_measure ?? 0)),
    min_year: Math.max(0, Math.floor(req.min_year ?? 0)),
  };
}

export const floorOf = (item) => item.floor ?? Math.ceil(item.list * 0.9);

/** Demo sales agent. */
export function salesDeterministic({ counter_price: c, floor_price: f, current }) {
  if (c >= f) return { decision: "accept", price: c, message: `We can do $${c}. Deal.` };
  const meet = Math.max(f, round5((c + current) / 2));
  return { decision: "counter", price: meet, message: meet === f ? `$${f} is the lowest we can go for this piece.` : `We can come down to $${meet}.` };
}

/** Vendor policy on any sales proposal: never below the floor, never above the current offer. */
export function enforceNegotiation(out, { counter, floor, current, round }) {
  if (counter >= floor && (out?.decision === "accept" || counter >= current)) return { accepted: true, price: Math.max(counter, floor), final: true, policy: null };
  if (out?.decision === "accept" && counter < floor) return { accepted: false, price: floor, final: true, policy: `Counter ${counter} is below the floor; offering the floor instead.` };
  let price = Number.isFinite(Number(out?.price)) ? Math.round(Number(out.price)) : floor;
  const lo = Math.max(floor, counter), hi = current;
  const clamped = clamp(price, lo, hi);
  const policy = clamped !== price ? `Sales agent proposed ${price}; clamped to ${clamped} (floor and current offer).` : null;
  if (clamped <= counter) return { accepted: true, price: Math.max(counter, floor), final: true, policy };
  return { accepted: false, price: clamped, final: clamped === floor || round >= MAX_ROUNDS, policy };
}

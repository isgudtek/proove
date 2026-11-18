/**
 * image-search.js: keyless reference-image search on Wikimedia Commons (CORS via origin=*).
 * Only openly licensed results (public domain, CC0, CC BY, CC BY-SA) are returned, with author and license,
 * so every image shown can be credited. These are reference images of the artifact type, never the certified item.
 */
const API = "https://commons.wikimedia.org/w/api.php";
const OPEN = /^(public domain|pd\b|cc0|cc by(-sa)? \d)/i;
const strip = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
const cache = new Map();

/** Commons search for one query. Resolves to the first openly licensed photo, or null. */
export async function searchCommons(query, { width = 500, signal } = {}) {
  const q = String(query || "").replace(/[^\p{L}\p{N} '\-]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!q) return null;
  if (cache.has(q)) return cache.get(q);
  const params = new URLSearchParams({
    action: "query", format: "json", origin: "*", generator: "search", gsrnamespace: "6", gsrlimit: "8",
    gsrsearch: `${q} filetype:bitmap`, prop: "imageinfo", iiprop: "url|mime|extmetadata", iiurlwidth: String(width),
    iiextmetadatafilter: "LicenseShortName|Artist|LicenseUrl|ObjectName",
  });
  const res = await fetch(`${API}?${params}`, { credentials: "omit", signal });
  if (!res.ok) throw new Error(`Commons search returned ${res.status}`);
  const pages = Object.values((await res.json()).query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  let hit = null;
  for (const p of pages) {
    const ii = p.imageinfo?.[0];
    const m = ii?.extmetadata || {};
    const license = strip(m.LicenseShortName?.value);
    if (!ii?.thumburl || !/^image\/(jpeg|png|webp)$/.test(ii.mime) || !OPEN.test(license)) continue;
    hit = {
      query: q, thumb: ii.thumburl, source: ii.descriptionurl, license, license_url: strip(m.LicenseUrl?.value) || null,
      author: strip(m.Artist?.value).replace(/^(Unknown author)+$/i, "Unknown author").slice(0, 80) || "Unknown author",
      title: strip(m.ObjectName?.value) || p.title.replace(/^File:/, "").replace(/\.\w+$/, ""),
    };
    break;
  }
  cache.set(q, hit);
  return hit;
}

/** Download the photo once (the browser cache serves every later <img>). Resolves true when it decoded. */
export function preload(url, ms = 12000) {
  return new Promise((resolve) => {
    const img = new Image();
    const t = setTimeout(() => resolve(false), ms);
    img.onload = () => { clearTimeout(t); resolve(true); };
    img.onerror = () => { clearTimeout(t); resolve(false); };
    img.src = url;
  });
}

/** Rule-based queries for an item, most specific first (used without a model, and as a fallback). */
export function fallbackQueries(item) {
  const title = String(item?.title || "").replace(/\([^)]*\)/g, "").replace(/\b(edition|struck|certified)\b.*$/i, "").trim();
  const head = title.split(",")[0].trim();
  const type = { meteorite: "meteorite", mineral: "mineral specimen", precious_metal: "gold nugget", coin: "gold coin", artwork: "lithograph", document: "manuscript page" }[item?.category] || "";
  return [...new Set([title.replace(/,/g, ""), head, type].filter(Boolean))];
}

/** Try the given queries in order, then the rule-based ones. Resolves to a photo or null. */
export async function findImage(item, queries = [], opts) {
  for (const q of [...queries, ...fallbackQueries(item)]) {
    const hit = await searchCommons(q, opts).catch(() => null);
    if (hit) return hit;
  }
  return null;
}

/** Accept a photo record from another site only if it points at Wikimedia's image hosts and carries an open license. */
export function safeImage(img) {
  try {
    const t = new URL(img.thumb), s = new URL(img.source);
    if (t.protocol !== "https:" || !["upload.wikimedia.org", "thumb.wikimedia.org"].includes(t.hostname) || s.hostname !== "commons.wikimedia.org") return null;
    if (!OPEN.test(String(img.license))) return null;
    return { thumb: t.href, source: s.href, license: String(img.license).slice(0, 40), license_url: img.license_url ? String(img.license_url).slice(0, 200) : null, author: String(img.author || "Unknown author").slice(0, 80), title: String(img.title || "").slice(0, 120), query: String(img.query || "").slice(0, 80) };
  } catch { return null; }
}

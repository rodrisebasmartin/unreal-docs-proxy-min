import fetch from "node-fetch";
import * as cheerio from "cheerio";

/**
 * /api/assets_plus
 * Búsqueda keyless en: Unreal Marketplace (Next.js __NEXT_DATA__) + itch.io (HTML).
 * Parámetros:
 *   q       (string, required)     → términos de búsqueda (ej: "RPG icons", "sword animations")
 *   only    ("marketplace"|"itch"|"all" = default)
 *   price   ("free"|"paid"|"any" = default) → filtro heurístico
 *   license (string, optional)     → (solo itch: CC0/MIT/etc. por heurística en texto)
 */

const MARKET_SEARCH = (q) =>
  `https://www.unrealengine.com/marketplace/en-US/assets?keywords=${encodeURIComponent(q)}&sortBy=Relevance`;
const ITCH_SEARCH = (q) =>
  `https://itch.io/search?q=${encodeURIComponent(q)}&tags=unreal`;

const MAX_RESULTS = 12;

function pick(str, rx, group = 1) {
  const m = rx.exec(str);
  return m ? m[group] : null;
}

/* ---------- Unreal Marketplace ---------- */
async function searchMarketplace(q) {
  const url = MARKET_SEARCH(q);
  const r = await fetch(url, { headers: { "User-Agent": "UA-Assets/1.2" } });
  const html = await r.text();

  // Extrae el JSON Next.js __NEXT_DATA__
  const jsonText = pick(
    html,
    /<script[^>]*id="__NEXT_DATA__"[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!jsonText) return [];

  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }

  // Ruta típica: data.props.pageProps.apolloState → nodos con productos
  const apollo = data?.props?.pageProps?.apolloState;
  if (!apollo || typeof apollo !== "object") return [];

  const out = [];
  for (const [key, value] of Object.entries(apollo)) {
    // Heurística: nodos tipo ProductCard / Offer / Asset con slug y title
    if (value && typeof value === "object") {
      const title = value?.title || value?.name || value?.assetTitle;
      const slug =
        value?.slug ||
        value?.urlSlug ||
        (value?.assetSlug ? value.assetSlug : null);
      const isProduct =
        !!title &&
        !!slug &&
        (key.toLowerCase().includes("product") ||
          key.toLowerCase().includes("asset") ||
          key.toLowerCase().includes("offer"));

      if (isProduct) {
        const price =
          value?.price?.display ||
          (value?.isFree ? "Free" : undefined) ||
          (value?.priceString || undefined);
        const productUrl = `https://www.unrealengine.com/marketplace/en-US/product/${slug}`;
        out.push({
          title,
          url: productUrl,
          store: "marketplace",
          price: price || "Unknown",
          license: "Unknown"
        });
      }
    }
  }

  // Dedupe por URL y recorte
  const seen = new Set();
  const deduped = out.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
  return deduped.slice(0, MAX_RESULTS);
}

/* ---------- itch.io ---------- */
function inferPriceItch(text) {
  const t = (text || "").toLowerCase();
  if (/\bfree\b|pay\s*what\s*you\s*want/.test(t)) return "Free (inferred)";
  if (/\$\d+|\d+(\.\d{1,2})?\s*(usd|eur|ars|brl)/.test(t)) return "Paid (inferred)";
  return "Unknown";
}
function inferLicense(text) {
  const t = (text || "").toLowerCase();
  if (/\bcc0\b|creative\s*commons\s*zero/.test(t)) return "CC0 (inferred)";
  if (/\bmit\b/.test(t)) return "MIT (inferred)";
  if (/\bgpl\b/.test(t)) return "GPL (inferred)";
  if (/\bcommercial\s+use\b/.test(t)) return "Commercial Use (inferred)";
  return "Unknown";
}

async function searchItch(q) {
  const url = ITCH_SEARCH(q);
  const r = await fetch(url, { headers: { "User-Agent": "UA-Assets/1.2" } });
  const html = await r.text();
  const $ = cheerio.load(html);

  const out = [];
  $(".game_cell").each((_, el) => {
    const a = $(el).find(".game_link, .thumb_link").first();
    const title = a.attr("data-title") || a.attr("title") || a.text().trim();
    const href = a.attr("href");
    if (!href) return;

    const priceText =
      $(el).find(".price_value").first().text().trim() ||
      $(el).find(".meta").first().text().trim();

    const snippet =
      $(el).find(".game_text").first().text().trim() ||
      $(el).find(".sub").first().text().trim();

    out.push({
      title: title || href,
      url: href.startsWith("http") ? href : `https://itch.io${href}`,
      store: "itch",
      price: inferPriceItch(`${priceText} ${snippet}`),
      license: inferLicense(`${title} ${snippet}`)
    });
  });

  // Dedupe + recorte
  const seen = new Set();
  const deduped = out.filter((x) => (seen.has(x.url) ? false : (seen.add(x.url), true)));
  return deduped.slice(0, MAX_RESULTS);
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  try {
    const { q, only = "all", price = "any", license } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: "Missing or too short 'q'" });
    }

    let results = [];
    if (only === "marketplace" || only === "all") {
      results.push(...(await searchMarketplace(q)));
    }
    if (only === "itch" || only === "all") {
      results.push(...(await searchItch(q)));
    }

    // Filtros opcionales
    if (price !== "any") {
      const wantFree = price.toLowerCase() === "free";
      results = results.filter((r) =>
        wantFree ? /free/i.test(r.price) : !/free/i.test(r.price)
      );
    }
    if (license && license.trim()) {
      const lic = license.toLowerCase();
      results = results.filter((r) => (r.license || "unknown").toLowerCase().includes(lic));
    }

    // Orden: marketplace primero, luego itch; free antes que paid; alfabético
    results.sort((a, b) => {
      const storeRank = (s) => (s === "marketplace" ? 0 : s === "itch" ? 1 : 2);
      const priceRank = (p) => (/free/i.test(p) ? 0 : 1);
      return (
        storeRank(a.store) - storeRank(b.store) ||
        priceRank(a.price) - priceRank(b.price) ||
        a.title.localeCompare(b.title)
      );
    });

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=120");
    res.status(200).json({ query: q, count: results.length, results: results.slice(0, MAX_RESULTS) });
  } catch (e) {
    res.status(500).json({ error: "assets_plus provider error", detail: String(e) });
  }
}

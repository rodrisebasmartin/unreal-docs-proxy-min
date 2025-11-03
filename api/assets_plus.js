import fetch from "node-fetch";
import * as cheerio from "cheerio";

/**
 * /api/assets_plus
 * Keyless search across Unreal Marketplace + itch.io (assets/resources).
 * - Usa resultados HTML de DuckDuckGo (GET + POST mirror) con filtros de sitio.
 * - Decodifica redirecciones (?uddg=...).
 * - Filtra y normaliza a páginas tipo "producto".
 * Params:
 *   q: string (required)         → términos de búsqueda (ej: "RPG icons", "sword animations", "VFX fire")
 *   only: "marketplace"|"itch"|"all" (default "all")
 *   price: "free"|"paid"|"any"  (default "any")  → heurístico textual
 *   license: string (optional)   → filtro textual (ej: "cc0", "mit", "commercial")
 */

const DDG_HTML_GET = (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=us-en`;
const DDG_HTML_POST = "https://html.duckduckgo.com/html";

const MARKET_HOST = "www.unrealengine.com";
const ITCH_HOST = "itch.io";
const MAX_RESULTS = 12;

function normalizeHref(href) {
  if (!href) return null;
  try {
    if (/^https?:\/\//i.test(href)) return href;
    const u = new URL(href, "https://duckduckgo.com");
    if (u.pathname === "/l/") {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
  } catch {}
  return null;
}

function parseDDGHtml(html) {
  const $ = cheerio.load(html);
  const out = [];

  const add = (title, href, snippet) => {
    const url = normalizeHref(href);
    if (!url) return;
    out.push({ title: (title || "").trim(), url, snippet: (snippet || "").trim() });
  };

  // Selectores principales
  $("a.result__a, .result__title a").each((_, a) => {
    const $a = $(a);
    const title = $a.text();
    const href = $a.attr("href");
    const snippet =
      $a.closest(".result").find(".result__snippet, .result__snippet.js-result-snippet").first().text() ||
      $a.parent().find(".result__snippet").first().text() ||
      "";
    add(title, href, snippet);
  });

  // Fallback de enlaces redirigidos /l/?uddg=
  if (out.length === 0) {
    $('a[href^="/l/?uddg="]').each((_, a) => {
      const $a = $(a);
      add($a.text(), $a.attr("href"), "");
    });
  }

  // Fallback genérico
  if (out.length === 0) {
    $("#links a, .results a").each((_, a) => {
      const $a = $(a);
      add($a.text(), $a.attr("href"), "");
    });
  }

  // Dedupe
  const seen = new Set();
  return out.filter(r => {
    if (!r.url) return false;
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

function inferStore(url) {
  try {
    const u = new URL(url);
    if (u.hostname === MARKET_HOST && u.pathname.includes("/marketplace/")) return "marketplace";
    if (u.hostname.endsWith(ITCH_HOST)) return "itch";
  } catch {}
  return "other";
}

// ✅ Versión más permisiva (parche #1)
function isProductLike(url) {
  try {
    const u = new URL(url);

    // Unreal Marketplace
    if (u.hostname === MARKET_HOST) {
      const p = u.pathname.toLowerCase();
      if (!p.includes("/marketplace/")) return false;
      // excluir listados o búsquedas
      if (/(\/category\/|\/free|\/search|\/collections|\/page\/\d+)/.test(p)) return false;
      return true; // aceptamos detalle de producto y otras variantes válidas
    }

    // itch.io: producto suele ser subdominio author.itch.io/<project>
    if (u.hostname.endsWith(ITCH_HOST)) {
      const isRoot = u.hostname === ITCH_HOST;
      const depth = u.pathname.split("/").filter(Boolean).length;
      if (isRoot) return false;                // itch.io/...
      if (u.pathname.startsWith("/t/")) return false; // tags
      return depth <= 1; // /project-name
    }
  } catch {}
  return false;
}

function inferPrice(title, snippet) {
  const text = `${title} ${snippet}`.toLowerCase();
  if (/\bfree\b|pay\s*what\s*you\s*want/.test(text)) return "Free (inferred)";
  if (/\$\d+|\d+(\.\d{1,2})?\s*usd|\bpaid\b/.test(text)) return "Paid (inferred)";
  return "Unknown";
}

function matchLicense(text) {
  const t = text.toLowerCase();
  if (/\bcc0\b|creative\s*commons\s*zero/.test(t)) return "CC0 (inferred)";
  if (/\bmit\b/.test(t)) return "MIT (inferred)";
  if (/\bgpl\b/.test(t)) return "GPL (inferred)";
  if (/\bcommercial\s+use\b/.test(t)) return "Commercial Use (inferred)";
  return "Unknown";
}

export default async function handler(req, res) {
  try {
    const { q, only = "all", price = "any", license } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: "Missing or too short 'q'" });
    }

    // ✅ Queries ampliadas (parche #2)
    const queries = [];
    if (only === "marketplace" || only === "all") {
      queries.push(`site:${MARKET_HOST} inurl:marketplace/product ${q}`);
      queries.push(`site:${MARKET_HOST} inurl:marketplace ${q}`);
    }
    if (only === "itch" || only === "all") {
      queries.push(`site:${ITCH_HOST} unreal ${q}`);
    }

    const headers = { "User-Agent": "UnrealAssetsPlus/1.1 (+educational)" };

    const aggregate = [];
    for (const query of queries) {
      // GET
      let resp = await fetch(DDG_HTML_GET(query), { headers });
      let html = await resp.text();
      let batch = parseDDGHtml(html);

      // Fallback: POST mirror
      if (batch.length === 0) {
        const post = await fetch(DDG_HTML_POST, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ q: query, kl: "us-en" })
        });
        html = await post.text();
        batch = parseDDGHtml(html);
      }

      // Filtrado y normalización
      for (const r of batch) {
        const store = inferStore(r.url);
        if (store === "other") continue;
        if (!isProductLike(r.url)) continue;

        const priceTag = inferPrice(r.title, r.snippet);
        const lic = matchLicense(`${r.title} ${r.snippet}`);

        aggregate.push({
          title: r.title || r.url.split("/").pop().replace(/[-_]/g, " "),
          url: r.url,
          store,
          price: priceTag,
          license: lic
        });
      }
    }

    // Filtros opcionales
    let results = aggregate;

    if (price && price !== "any") {
      const wantFree = price.toLowerCase() === "free";
      results = results.filter(r => wantFree ? /free/i.test(r.price) : !/free/i.test(r.price));
    }
    if (license && license.trim()) {
      const lic = license.toLowerCase();
      results = results.filter(r => (r.license || "unknown").toLowerCase().includes(lic));
    }

    // Dedupe + orden + corte
    const seen = new Set();
    results = results.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    results.sort((a,b) => {
      const storeRank = (s) => s === "marketplace" ? 0 : s === "itch" ? 1 : 2;
      const priceRank = (p) => /free/i.test(p) ? 0 : 1;
      const x = storeRank(a.store) - storeRank(b.store);
      if (x !== 0) return x;
      const y = priceRank(a.price) - priceRank(b.price);
      if (y !== 0) return y;
      return a.title.localeCompare(b.title);
    });

    results = results.slice(0, MAX_RESULTS);

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=120");
    return res.status(200).json({ query: q, count: results.length, results });
  } catch (e) {
    return res.status(500).json({ error: "assets_plus failed", detail: String(e) });
  }
}

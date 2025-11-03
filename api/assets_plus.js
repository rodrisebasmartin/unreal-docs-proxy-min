import fetch from "node-fetch";
import * as cheerio from "cheerio";

/**
 * /api/assets_plus
 * Keyless search across Unreal Marketplace + itch.io (assets/resources).
 * - Uses DuckDuckGo HTML (GET + POST mirror) with site filters.
 * - Decodes DDG redirect (?uddg=...).
 * - Filters and normalizes to product-like pages.
 * Query params:
 *   q: string (required) - search terms (e.g., "RPG icons", "sword animations", "VFX fire")
 *   only: "marketplace" | "itch" | "all" (default "all")
 *   price: "free" | "paid" | "any" (default "any") -- heuristic textual filter
 *   license: string (optional) - e.g., "cc0", "mit", "commercial" (heuristic textual match)
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

  // Primary selectors
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

  // Fallback selectors
  if (out.length === 0) {
    $("#links a, .results a").each((_, a) => {
      const $a = $(a);
      add($a.text(), $a.attr("href"), "");
    });
  }

  // dedupe by final URL
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

function isProductLike(url) {
  try {
    const u = new URL(url);
    if (u.hostname === MARKET_HOST) {
      // Prefer product pages: /marketplace/en-US/product/...
      return /\/marketplace\/.+\/product\//i.test(u.pathname);
    }
    if (u.hostname.endsWith(ITCH_HOST)) {
      // itch product pages are usually like: https://author.itch.io/project-name
      // exclude itch.io/tags or /games? queries
      return u.hostname !== ITCH_HOST && !u.pathname.startsWith("/t/") && u.pathname.split("/").filter(Boolean).length === 1;
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
  return null;
}

export default async function handler(req, res) {
  try {
    const { q, only = "all", price = "any", license } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: "Missing or too short 'q'" });
    }

    const queries = [];
    if (only === "marketplace" || only === "all") {
      queries.push(`site:${MARKET_HOST} /marketplace/ ${q}`);
    }
    if (only === "itch" || only === "all") {
      // Focus itch on UE/unreal keywords to improve relevance
      queries.push(`site:${ITCH_HOST} unreal ${q}`);
    }

    const headers = { "User-Agent": "UnrealAssetsPlus/1.0 (+educational)" };

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

      // Filter and normalize
      for (const r of batch) {
        const store = inferStore(r.url);
        if (store === "other") continue;
        if (!isProductLike(r.url)) continue;

        const priceTag = inferPrice(r.title, r.snippet);
        const lic = matchLicense(`${r.title} ${r.snippet}`) || "Unknown";
        aggregate.push({
          title: r.title || r.url.split("/").pop().replace(/[-_]/g, " "),
          url: r.url,
          store,
          price: priceTag,
          license: lic
        });
      }
    }

    // Optional filters
    let results = aggregate;

    if (price && price !== "any") {
      const wantFree = price.toLowerCase() === "free";
      results = results.filter(r => wantFree ? /free/i.test(r.price) : !/free/i.test(r.price));
    }
    if (license) {
      const lic = license.toLowerCase();
      results = results.filter(r => r.license.toLowerCase().includes(lic));
    }

    // Deduplicate by URL
    const seen = new Set();
    results = results.filter(r => {
      if (seen.has(r.url)) return false;
      seen.add(r.url);
      return true;
    });

    // Sort: marketplace first, then itch; free before paid; keep at most 12
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

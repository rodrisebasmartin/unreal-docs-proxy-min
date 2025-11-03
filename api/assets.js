import fetch from "node-fetch";
import * as cheerio from "cheerio";

const DDG_HTML_GET = (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=us-en`;
const DDG_HTML_POST = "https://html.duckduckgo.com/html";

const MARKET_HOST = "www.unrealengine.com";
const PRODUCT_PATH_FRAGMENT = "/marketplace/";
const MAX_RESULTS = 10;

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

function isMarketplaceProduct(url) {
  try {
    const u = new URL(url);
    return (
      u.hostname === MARKET_HOST &&
      u.pathname.includes(PRODUCT_PATH_FRAGMENT) &&
      /\/product\//i.test(u.pathname)
    );
  } catch {
    return false;
  }
}

function parseDDGHtml(html) {
  const $ = cheerio.load(html);
  const out = [];

  const add = (title, href, snippet) => {
    const url = normalizeHref(href);
    if (!url || !isMarketplaceProduct(url)) return;
    out.push({ title: (title || "").trim(), url, snippet: (snippet || "").trim() });
  };

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

  if (out.length === 0) {
    $("#links a, .results a").each((_, a) => {
      const $a = $(a);
      add($a.text(), $a.attr("href"), "");
    });
  }

  const seen = new Set();
  return out.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

function inferPrice(title, snippet) {
  const text = `${title} ${snippet}`.toLowerCase();
  if (/\bfree\b/.test(text)) return "Free (inferred)";
  return "Unknown";
}

export default async function handler(req, res) {
  try {
    const { q, price, kind } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: "Missing or too short 'q'" });
    }

    const terms = [q];
    if (kind) terms.push(kind);
    const query = `site:${MARKET_HOST} ${PRODUCT_PATH_FRAGMENT} ${terms.join(" ")}`;

    let resp = await fetch(DDG_HTML_GET(query), { headers: { "User-Agent": "UnrealAssetsProxy/1.0 (+educational)" } });
    let html = await resp.text();
    let results = parseDDGHtml(html);

    if (results.length === 0) {
      const post = await fetch(DDG_HTML_POST, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "UnrealAssetsProxy/1.0 (+educational)"
        },
        body: new URLSearchParams({ q: query, kl: "us-en" })
      });
      html = await post.text();
      results = parseDDGHtml(html);
    }

    let items = results.slice(0, MAX_RESULTS).map(r => ({
      title: r.title || r.url.split("/").pop().replace(/[-_]/g, " "),
      url: r.url,
      price: inferPrice(r.title, r.snippet)
    }));

    if (price && price.toLowerCase() == "free") {
      items = items.filter(i => i.price.toLowerCase().includes("free"));
    }

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=60");
    return res.status(200).json({ query: q, count: items.length, results: items });
  } catch (e) {
    return res.status(500).json({ error: "Asset search failed", detail: String(e) });
  }
}

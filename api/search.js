import fetch from "node-fetch";
import * as cheerio from "cheerio";

// 1) Endpoint principal (GET) y 2) fallback (POST al html mirror)
const DDG_HTML_GET = (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=us-en`;
const DDG_HTML_POST = "https://html.duckduckgo.com/html";

const ALLOWLIST = [
  "dev.epicgames.com",
  "docs.unrealengine.com",
  "forums.unrealengine.com",
  "www.unrealengine.com"
];

const isAllowed = (url) => {
  try {
    const { hostname } = new URL(url);
    return ALLOWLIST.some(d => hostname.endsWith(d.replace(/^\*\./, "")));
  } catch { return false; }
};

function parseDDGHtml(html) {
  const $ = cheerio.load(html);
  const out = [];

  // Selector clásico
  $("a.result__a").each((_, a) => {
    const title = $(a).text().trim();
    const url = $(a).attr("href");
    if (!url || !isAllowed(url)) return;
    const snippet =
      $(a).parent().find(".result__snippet, .result__snippet.js-result-snippet").first().text().trim() ||
      $(a).closest(".result").find(".result__snippet").first().text().trim() ||
      "";
    out.push({ title, url, snippet });
  });

  // Respaldo: enlaces en contenedor de resultados
  if (out.length === 0) {
    $("#links a, .results a").each((_, a) => {
      const url = $(a).attr("href");
      const title = $(a).text().trim();
      if (!url || !title || !isAllowed(url)) return;
      out.push({ title, url, snippet: "" });
    });
  }

  // Evitar duplicados
  const seen = new Set();
  return out.filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  });
}

export default async function handler(req, res) {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: "Missing or too short 'q'" });
    }

    // 1) Intento con GET
    let resp = await fetch(DDG_HTML_GET(q), {
      headers: { "User-Agent": "UnrealDocsProxy/1.1 (+educational)" }
    });
    let html = await resp.text();
    let results = parseDDGHtml(html);

    // 2) Fallback con POST al mirror html
    if (results.length === 0) {
      const post = await fetch(DDG_HTML_POST, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "UnrealDocsProxy/1.1 (+educational)"
        },
        body: new URLSearchParams({ q, kl: "us-en" })
      });
      html = await post.text();
      results = parseDDGHtml(html);
    }

    res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=60");
    return res.status(200).json({ query: q, count: results.length, results });
  } catch (e) {
    return res.status(500).json({ error: "Search failed", detail: String(e) });
  }
}

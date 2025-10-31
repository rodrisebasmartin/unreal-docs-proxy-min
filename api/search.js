import fetch from "node-fetch";
import * as cheerio from "cheerio";

const DDG_HTML_GET = (q) => `https://duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=us-en`;
const DDG_HTML_POST = "https://html.duckduckgo.com/html";

const ALLOWLIST = [
  "dev.epicgames.com",
  "docs.unrealengine.com",
  "forums.unrealengine.com",
  "www.unrealengine.com"
];

const isAllowed = (raw) => {
  try {
    const { hostname } = new URL(raw);
    return ALLOWLIST.some(d => hostname.endsWith(d.replace(/^\*\./, "")));
  } catch {
    return false;
  }
};

// DDG a veces devuelve /l/?uddg=<urlCodificada>. Decodificamos eso.
function normalizeHref(href) {
  if (!href) return null;
  try {
    // href directo (https://...)
    if (/^https?:\/\//i.test(href)) return href;

    // href redirect de DDG: /l/?uddg=<ENCODED_URL>
    const u = new URL(href, "https://duckduckgo.com");
    if (u.pathname === "/l/") {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
  } catch {
    // ignoramos errores de URL
  }
  return null;
}

function parseDDGHtml(html) {
  const $ = cheerio.load(html);
  const out = [];

  // selectores principales
  $("a.result__a, .result__title a").each((_, a) => {
    const title = $(a).text().trim();
    const normalized = normalizeHref($(a).attr("href"));
    if (!normalized || !isAllowed(normalized)) return;
    const snippet =
      $(a).closest(".result").find(".result__snippet, .result__snippet.js-result-snippet").first().text().trim() ||
      $(a).parent().find(".result__snippet").first().text().trim() ||
      "";
    out.push({ title, url: normalized, snippet });
  });

  // respaldo muy laxo
  if (out.length === 0) {
    $("#links a, .results a").each((_, a) => {
      const title = $(a).text().trim();
      const normalized = normalizeHref($(a).attr("href"));
      if (!normalized || !title || !isAllowed(normalized)) return;
      out.push({ title, url: normalized, snippet: "" });
    });
  }

  // deduplicar
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

    // primer intento con GET
    let resp = await fetch(DDG_HTML_GET(q), {
      headers: { "User-Agent": "UnrealDocsProxy/1.2 (+educational)" }
    });
    let html = await resp.text();
    let results = parseDDGHtml(html);

    // fallback con POST (mirror HTML)
    if (results.length === 0) {
      const post = await fetch(DDG_HTML_POST, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "UnrealDocsProxy/1.2 (+educational)"
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

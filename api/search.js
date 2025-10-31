import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

// Sitemaps por tipo de fuente
const MAPS = {
  docs: [
    "https://dev.epicgames.com/documentation/en-us/sitemap.xml",
    "https://docs.unrealengine.com/sitemap.xml"
  ],
  forums: ["https://forums.unrealengine.com/sitemap.xml"],
  marketplace: ["https://www.unrealengine.com/sitemap.xml"],
  all: [
    "https://dev.epicgames.com/sitemap.xml",
    "https://dev.epicgames.com/documentation/en-us/sitemap.xml",
    "https://docs.unrealengine.com/sitemap.xml",
    "https://forums.unrealengine.com/sitemap.xml",
    "https://www.unrealengine.com/sitemap.xml"
  ]
};

function normalizeQuery(q) {
  return q.replace(/site:[^\s]+/gi, " ").replace(/["']/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function score(url, title, terms) {
  let s = 0;
  const text = (title + " " + url).toLowerCase();
  for (const t of terms) {
    if (!t) continue;
    if (text.includes(t)) s += 2;
    if (t === "blueprint" || t === "blueprints") s += 1;
  }
  if (/dev\.epicgames\.com\/documentation/i.test(url)) s += 3;
  if (/docs\.unrealengine\.com/i.test(url)) s += 3;
  if (/forums\.unrealengine\.com/i.test(url)) s -= 2;        // de-priorizar foros
  if (/unrealengine\.com\/marketplace/i.test(url)) s -= 1;    // de-priorizar marketplace
  return s;
}

async function fetchAndParse(url) {
  const r = await fetch(url, { headers: { "User-Agent": "UnrealDocsProxy/2.1 (+educational)" } });
  if (!r.ok) return null;
  const xml = await r.text();
  const parser = new XMLParser({ ignoreAttributes: false });
  return parser.parse(xml);
}

export default async function handler(req, res) {
  try {
    const { q, only } = req.query;
    if (!q || q.trim().length < 2) return res.status(400).json({ error: "Missing or too short 'q'" });

    const mode = (only && ["docs","forums","marketplace","all"].includes(only)) ? only : "docs";
    const sitemaps = MAPS[mode];

    const terms = normalizeQuery(q).split(" ").filter(Boolean);
    const seen = new Set();
    const found = [];

    for (const sm of sitemaps) {
      const obj = await fetchAndParse(sm);
      if (!obj) continue;

      // sitemapindex → traer hasta 3 hijos
      const childList = [];
      if (obj.sitemapindex?.sitemap) {
        const arr = Array.isArray(obj.sitemapindex.sitemap) ? obj.sitemapindex.sitemap : [obj.sitemapindex.sitemap];
        for (const s of arr.slice(0, 3)) childList.push(s.loc || s["loc"]);
      }

      const urlsetUrls = [];
      if (obj.urlset?.url) {
        const arr = Array.isArray(obj.urlset.url) ? obj.urlset.url : [obj.urlset.url];
        for (const u of arr) urlsetUrls.push(u.loc || u["loc"]);
      }

      // procesar hijos
      for (const child of childList) {
        if (!child) continue;
        const cobj = await fetchAndParse(child);
        if (!cobj?.urlset?.url) continue;
        const arr = Array.isArray(cobj.urlset.url) ? cobj.urlset.url : [cobj.urlset.url];
        for (const u of arr) {
          const loc = (u.loc || u["loc"] || "").trim();
          if (!loc || seen.has(loc)) continue;
          const title = loc.split("/").slice(-1)[0].replace(/[-_]/g, " ");
          const sc = score(loc, title, terms);
          if (sc > 0) { seen.add(loc); found.push({ title, url: loc, score: sc }); }
        }
      }

      // procesar urls directas
      for (const loc of urlsetUrls) {
        if (!loc) continue;
        if (seen.has(loc)) continue;
        const title = loc.split("/").slice(-1)[0].replace(/[-_]/g, " ");
        const sc = score(loc, title, terms);
        if (sc > 0) { seen.add(loc); found.push({ title, url: loc, score: sc }); }
      }
    }

    found.sort((a,b) => b.score - a.score);
    const results = found.slice(0, 10).map(({title, url}) => ({ title: title.trim() || url, url, snippet: "" }));

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=120");
    return res.status(200).json({ query: q, count: results.length, results, mode });
  } catch (e) {
    return res.status(500).json({ error: "Search failed", detail: String(e) });
  }
}

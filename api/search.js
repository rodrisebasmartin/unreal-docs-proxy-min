import fetch from "node-fetch";
import { XMLParser } from "fast-xml-parser";

// We'll search official sitemaps directly (no search engine, no keys)
const SITEMAPS = [
  "https://dev.epicgames.com/sitemap.xml",
  "https://dev.epicgames.com/documentation/en-us/sitemap.xml",
  "https://docs.unrealengine.com/sitemap.xml",
  "https://forums.unrealengine.com/sitemap.xml",
  "https://www.unrealengine.com/sitemap.xml"
];

function normalizeQuery(q) {
  // remove site: filters & quotes for matching
  return q.replace(/site:[^\s]+/gi, " ").replace(/["']/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function score(url, title, terms) {
  let s = 0;
  const text = (title + " " + url).toLowerCase();
  for (const t of terms) {
    if (!t) continue;
    if (text.includes(t)) s += 2;
    // boost exact phrase 'blueprint'/'blueprints'
    if (t === "blueprint" || t === "blueprints") s += 1;
  }
  // prefer official documentation paths
  if (/dev\.epicgames\.com\/documentation/i.test(url)) s += 2;
  if (/docs\.unrealengine\.com/i.test(url)) s += 2;
  return s;
}

export default async function handler(req, res) {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: "Missing or too short 'q'" });
    }

    const nq = normalizeQuery(q);
    const terms = nq.split(" ").filter(Boolean);

    const parser = new XMLParser({ ignoreAttributes: false });
    const seen = new Set();
    const found = [];

    for (const sm of SITEMAPS) {
      try {
        const r = await fetch(sm, { headers: { "User-Agent": "UnrealDocsProxy/2.0 (+educational)" } });
        if (!r.ok) continue;
        const xml = await r.text();
        const obj = parser.parse(xml);

        // Two common formats: sitemapindex/sitemap and urlset/url
        const urlEntries = [];
        if (obj.sitemapindex && obj.sitemapindex.sitemap) {
          const sitemaps = Array.isArray(obj.sitemapindex.sitemap) ? obj.sitemapindex.sitemap : [obj.sitemapindex.sitemap];
          for (const s of sitemaps) {
            const loc = (s.loc || s["loc"] || "").trim();
            if (loc) urlEntries.push({ loc });
          }
        }
        if (obj.urlset && obj.urlset.url) {
          const urls = Array.isArray(obj.urlset.url) ? obj.urlset.url : [obj.urlset.url];
          for (const u of urls) {
            const loc = (u.loc || u["loc"] || "").trim();
            if (loc) urlEntries.push({ loc });
          }
        }

        // If this sitemap is an index, fetch child sitemaps shallowly (up to 3)
        const childSitemaps = urlEntries.filter(e => /sitemap.*\.xml(\.gz)?$/i.test(e.loc)).slice(0, 3);
        for (const child of childSitemaps) {
          try {
            const cr = await fetch(child.loc, { headers: { "User-Agent": "UnrealDocsProxy/2.0 (+educational)" } });
            if (!cr.ok) continue;
            const cxml = await cr.text();
            const cobj = parser.parse(cxml);
            if (cobj.urlset && cobj.urlset.url) {
              const urls = Array.isArray(cobj.urlset.url) ? cobj.urlset.url : [cobj.urlset.url];
              for (const u of urls) {
                const loc = (u.loc || u["loc"] || "").trim();
                if (!loc || seen.has(loc)) continue;
                // Basic filtering: only Epic/UE domains already ensured by sitemap sources
                const title = loc.split("/").slice(-1)[0].replace(/[-_]/g, " ");
                const sc = score(loc, title, terms);
                if (sc > 0) {
                  seen.add(loc);
                  found.push({ title, url: loc, score: sc });
                }
              }
            }
          } catch {}
        }

        // Also consider direct urlset entries of the current sitemap
        for (const e of urlEntries) {
          const loc = e.loc;
          if (!loc || seen.has(loc)) continue;
          const title = loc.split("/").slice(-1)[0].replace(/[-_]/g, " ");
          const sc = score(loc, title, terms);
          if (sc > 0) {
            seen.add(loc);
            found.push({ title, url: loc, score: sc });
          }
        }

      } catch {}
    }

    // sort by score desc and limit
    found.sort((a,b) => b.score - a.score);
    const results = found.slice(0, 10).map(({title, url}) => ({
      title: title.trim() || url,
      url,
      snippet: ""
    }));

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=120");
    return res.status(200).json({ query: q, count: results.length, results });
  } catch (e) {
    return res.status(500).json({ error: "Search failed", detail: String(e) });
  }
}

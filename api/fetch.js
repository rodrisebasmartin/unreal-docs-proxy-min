import fetch from "node-fetch";
import * as cheerio from "cheerio";

const ALLOWLIST = ["dev.epicgames.com","docs.unrealengine.com","forums.unrealengine.com","www.unrealengine.com"];
const isAllowed = (raw) => { 
  try { 
    return ALLOWLIST.some(d => new URL(raw).hostname.endsWith(d.replace(/^\*\./,""))); 
  } catch { 
    return false; 
  } 
};

const extractText = ($) => {
  const $root = $("article, main").first().length ? $("article, main").first() : $("body");
  $root.find("nav, header, footer, script, style, noscript").remove();
  let text = "";
  $root.find("h1,h2,h3,h4,h5,p,li,code,pre").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t) text += t + "\n";
  });
  return text.trim();
};

export default async function handler(req, res) {
  try {
    const { url } = req.query;
    if (!url || !isAllowed(url)) return res.status(400).json({ error: "Missing or disallowed 'url'" });

    const resp = await fetch(url, { headers: { "User-Agent": "UnrealDocsProxy/1.0" } });
    const html = await resp.text();
    const $ = cheerio.load(html);
    const title = $("title").first().text().trim();
    const content = extractText($).slice(0, 40000);

    res.setHeader("Cache-Control", "s-maxage=1800, stale-while-revalidate=120");
    return res.status(200).json({ url, title, length: content.length, content });
  } catch (e) {
    return res.status(500).json({ error: "Fetch failed", detail: String(e) });
  }
}

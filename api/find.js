// Clean Player finder.
// Opens a public web page and returns the video it openly shares about itself:
// sharing tags (og:video), page video info (schema.org VideoObject), <video> tags,
// embedded players, plain stream links, and cleaned match fixture links.

const BLOCKED_HOST = /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|[?::1]?$|.*\.local$\vert{}.*\.internal$)/i;

function decode(s) {
  return String(s)
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/gi, " ")
    .replace(/\\\//g, "/");
}

function attrs(tag) {
  const o = {};
  tag.replace(/([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (_, k, __, a, b) => {
    o[k.toLowerCase()] = decode(a !== undefined ? a : b);
  });
  return o;
}

function kindOf(u) {
  if (/\.m3u8(\?|#|$)/i.test(u)) return "stream";
  if (/\.(mp4|webm|ogg|ogv|mov|m4v)(\?|#|$)/i.test(u)) return "file";
  return "embed";
}

function toEmbed(u) {
  let x;
  try { x = new URL(u); } catch { return null; }
  const h = x.hostname.replace(/^(www|m)\./, "");
  let id = null;
  if (h === "youtu.be") id = x.pathname.slice(1).split("/")[0];
  else if (h.endsWith("youtube.com") || h.endsWith("youtube-nocookie.com")) {
    id = x.searchParams.get("v");
    if (!id) {
      const m = x.pathname.match(/\/(embed|shorts|live|v)\/([\w-]{6,})/);
      if (m) id = m[2];
    }
  }
  if (id) return "https://www.youtube-nocookie.com/embed/" + id;
  if (h === "vimeo.com" || h === "player.vimeo.com") {
    const m = x.pathname.match(/(\d{5,})/);
    if (m) return "https://player.vimeo.com/video/" + m[1];
  }
  if (h.endsWith("dailymotion.com")) {
    const m = x.pathname.match(/\/(?:embed\/)?video\/([a-z0-9]+)/i);
    if (m) return "https://www.dailymotion.com/embed/video/" + m[1];
  }
  if (h === "dai.ly" && x.pathname.length > 1) return "https://www.dailymotion.com/embed/video/" + x.pathname.slice(1);
  return null;
}

function siteOf(hostname) {
  const parts = hostname.toLowerCase().split(".");
  const twoPart = /^(co|com|org|net|gov|ac|ltd|plc)$/.test(parts[parts.length - 2] || "") && parts.length > 2;
  return parts.slice(twoPart ? -3 : -2).join(".");
}

async function getPage(href) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(href, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CleanPlayer/1.0)",
        "Accept": "text/html,application/xhtml+xml,*/*"
      }
    });
    return r;
  } finally {
    clearTimeout(timer);
  }
}

function extract(html, pageHref) {
  const found = [];
  const frames = [];
  const links = [];

  function add(raw, from) {
    if (!raw || typeof raw !== "string") return;
    let u;
    try { u = new URL(decode(raw.trim()), pageHref).href; } catch { return; }
    if (!/^https?:/i.test(u)) return;
    const e = toEmbed(u);
    found.push({ url: e || u, kind: e ? "embed" : kindOf(u), from });
  }

  function addLink(raw, rawText) {
    if (!raw || typeof raw !== "string") return;
    let u;
    try { u = new URL(decode(raw.trim()), pageHref).href; } catch { return; }
    if (!/^https?:/i.test(u)) return;

    const uObj = new URL(u);
    const pathname = uObj.pathname.toLowerCase();
    const hostname = uObj.hostname.toLowerCase();

    if (pathname === "/" || pathname === "" || pathname === "/index.html") return;

    const hasVs = /[-_]vs[-_]|\bvs\b/.test(pathname);
    const hasNumericId = /\/\d{4,}\/?$/.test(pathname) || /\/\d{4,}\//.test(pathname);
    const isStreamSubdomain = /^links\.|^live\d*\./i.test(hostname);

    if (!hasVs && !hasNumericId && !isStreamSubdomain) {
      const segments = pathname.split("/").filter(Boolean);
      if (segments.length <= 2 && !/\d/.test(pathname)) {
        return;
      }
    }

    // Clean up text: decode entities, normalize whitespace, and strip out status/timer clutter
    let text = decode(rawText.replace(/<[^>]*>/g, " "));
    text = text.replace(/^(Match Started|Ended|\d+\s*(min|hr|hrs|hours|m)(\s*and\s*\d+\s*(min|m))?\s*from\s*now)\s*/i, "").trim();
    text = text.replace(/\s+/g, " ");

    if (!text) text = u;

    links.push({ url: u, text });
  }

  function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    const types = [].concat(o["@type"] || []);
    if (types.includes("VideoObject")) {
      add(o.contentUrl, "Page video info");
      add(o.embedUrl, "Page video info");
    }
    Object.values(o).forEach(v => { if (v && typeof v === "object") walk(v); });
  }

  const metas = (html.match(/<meta\b[^>]*>/gi) || []).map(attrs);
  const meta = name => metas
    .filter(m => (m.property || m.name || "").toLowerCase() === name)
    .map(m => m.content);

  ["og:video:secure_url", "og:video:url", "og:video", "twitter:player:stream"]
    .forEach(n => meta(n).forEach(u => add(u, "Shared video tag")));

  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { walk(JSON.parse(m[1])); } catch {}
  }

  for (const tag of html.match(/<(video|source)\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    add(a.src || a["data-src"], "Video on page");
  }

  for (const tag of html.match(/<iframe\b[^>]*>/gi) || []) {
    const a = attrs(tag);
    const s = a.src || a["data-src"];
    if (!s) continue;
    let abs;
    try { abs = new URL(decode(s), pageHref).href; } catch { continue; }
    if (!/^https?:/i.test(abs)) continue;
    frames.push(abs);
    if (toEmbed(abs) || /player|embed|video/i.test(abs)) add(abs, "Embedded player");
  }
  meta("twitter:player").forEach(u => add(u, "Shared player tag"));

  for (const m of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+?\.(m3u8|mp4)(\?[^\s"'<>\\]*)?/gi)) {
    add(m[0], "Link in page");
  }

  for (const tag of html.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)) {
    const aAttrs = attrs(tag[0]);
    const href = aAttrs.href;
    if (href && !href.startsWith("#") && !href.startsWith("javascript:")) {
      addLink(href, tag[1]);
    }
  }

  const title = (meta("og:title")[0] || (html.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || "").trim();
  return { found, frames, links, title: decode(title) };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  const send = (code, obj) => {
    res.statusCode = code;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(obj));
  };

  let page;
  try { page = new URL(String((req.query && req.query.url) || "")); }
  catch { return send(400, { error: "That isn't a full web address. It should start with https://" }); }
  if (!/^https?:$/.test(page.protocol) || BLOCKED_HOST.test(page.hostname)) {
    return send(400, { error: "That address can't be checked." });
  }

  let html;
  try {
    const r = await getPage(page.href);
    if (!r.ok) return send(502, { error: `That site answered with error ${r.status}. It may need a login or block outside apps.` });
    const type = r.headers.get("content-type") || "";
    if (/mpegurl|video\//i.test(type)) {
      return send(200, { title: page.hostname, results: [{ url: page.href, kind: /mpegurl/i.test(type) ? "stream" : "file", from: "Direct link" }], links: [] });
    }
    html = (await r.text()).slice(0, 3000000);
  } catch {
    return send(502, { error: "Couldn't reach that page. Check the link and try again." });
  }

  const first = extract(html, page.href);
  let found = first.found;

  if (!found.length) {
    const site = siteOf(page.hostname);
    const own = [...new Set(first.frames)]
      .filter(f => { try { const h = new URL(f).hostname; return siteOf(h) === site && !BLOCKED_HOST.test(h); } catch { return false; } })
      .slice(0, 3);
    for (const f of own) {
      try {
        const r = await getPage(f);
        if (!r.ok) continue;
        const inner = extract((await r.text()).slice(0, 3000000), f);
        inner.found.forEach(x => { x.from = "Site's own player"; });
        found = found.concat(inner.found);
        if (!inner.found.length) found.push({ url: f, kind: "embed", from: "Site's own player" });
      } catch {}
    }
  }

  const seen = new Set();
  found = found.filter(x => !seen.has(x.url) && seen.add(x.url));
  const rank = { stream: 0, file: 1, embed: 2 };
  found.sort((a, b) => rank[a.kind] - rank[b.kind]);

  const seenLinks = new Set();
  const uniqueLinks = first.links.filter(l => !seenLinks.has(l.url) && seenLinks.add(l.url));

  return send(200, {
    title: first.title || page.hostname,
    results: found.slice(0, 10),
    links: uniqueLinks.slice(0, 40)
  });
};

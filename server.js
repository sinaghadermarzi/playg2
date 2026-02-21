const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const SEARCH_RESULT_LIMIT = 6;
const PUBLIC_DIR = path.join(__dirname, "public");

function withTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timeout) };
}

async function fetchText(url) {
  const timer = withTimeout(8000);
  try {
    const res = await fetch(url, {
      signal: timer.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; EventCrawler/1.0)" },
    });
    if (!res.ok) return "";
    return await res.text();
  } catch {
    return "";
  } finally {
    timer.clear();
  }
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function findCandidatePages(query) {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url);
  if (!html) return [];

  const links = [];
  const regex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gims;
  let match;

  while ((match = regex.exec(html)) !== null && links.length < SEARCH_RESULT_LIMIT) {
    const href = decodeHtmlEntities(match[1]);
    const title = decodeHtmlEntities(match[2].replace(/<[^>]+>/g, "").trim());
    if (href.startsWith("http")) links.push({ title, href });
  }

  return links;
}

function normalizeMaybeArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  return [value];
}

function eventFromJsonLd(eventObj, pageUrl) {
  const location = eventObj.location || {};
  const address = location.address || {};
  const addressText = typeof address === "string"
    ? address
    : [address.streetAddress, address.addressLocality, address.addressRegion, address.postalCode].filter(Boolean).join(", ");

  return {
    title: eventObj.name || "Untitled event",
    startDate: eventObj.startDate || "Unknown date",
    endDate: eventObj.endDate || null,
    venue: location.name || "Unknown venue",
    address: addressText || "Address unavailable",
    url: eventObj.url || pageUrl,
    source: new URL(pageUrl).hostname,
  };
}

function parseEventScripts(html, pageUrl) {
  const events = [];
  const scriptRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gim;
  let scriptMatch;

  while ((scriptMatch = scriptRegex.exec(html)) !== null) {
    const jsonText = scriptMatch[1].trim();
    if (!jsonText) continue;

    try {
      const parsed = JSON.parse(jsonText);
      const nodes = normalizeMaybeArray(parsed["@graph"] || parsed);
      nodes.forEach((node) => {
        if (!node || typeof node !== "object") return;
        const nodeType = normalizeMaybeArray(node["@type"]);
        const isEvent = nodeType.some((type) => String(type).toLowerCase() === "event");
        if (isEvent) events.push(eventFromJsonLd(node, pageUrl));
      });
    } catch {}
  }

  return events;
}

function dedupeEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = `${event.title}|${event.startDate}|${event.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function eventMatchesLocation(event, location) {
  return `${event.venue} ${event.address}`.toLowerCase().includes(location.toLowerCase());
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function serveStatic(req, res) {
  const rawPath = req.url === "/" ? "/index.html" : req.url;
  const sanitizedPath = path.normalize(rawPath).replace(/^([.][.][/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, sanitizedPath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    const type = ext === ".html" ? "text/html" : "text/plain";
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(data);
  });
}

async function handleSearch(req, res) {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", async () => {
    let payload;
    try {
      payload = JSON.parse(body || "{}");
    } catch {
      sendJson(res, 400, { error: "Invalid JSON." });
      return;
    }

    const { location, keyword = "events" } = payload;
    if (!location || typeof location !== "string" || !location.trim()) {
      sendJson(res, 400, { error: "A location is required." });
      return;
    }

    const normalizedLocation = location.trim();
    const normalizedKeyword = typeof keyword === "string" && keyword.trim() ? keyword.trim() : "events";
    const pages = await findCandidatePages(`${normalizedKeyword} near ${normalizedLocation}`);

    const crawled = await Promise.all(pages.map(async (page) => {
      const html = await fetchText(page.href);
      if (!html) return [];
      return parseEventScripts(html, page.href);
    }));

    const events = dedupeEvents(crawled.flat()).filter((event) => eventMatchesLocation(event, normalizedLocation));
    sendJson(res, 200, {
      location: normalizedLocation,
      keyword: normalizedKeyword,
      scannedPages: pages.length,
      foundEvents: events.length,
      events,
    });
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/events/search") {
    handleSearch(req, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`Event crawler app running on port ${PORT}`);
});

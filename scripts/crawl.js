import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import { parseStringPromise } from "xml2js";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const SOURCES_PATH = path.join(ROOT, "sources.json");
const SEEN_PATH = path.join(ROOT, "data", "seen.json");
const FEED_PATH = path.join(ROOT, "docs", "feed.xml");
const INDEX_PATH = path.join(ROOT, "docs", "index.html");

const MAX_FEED_ITEMS = 100;
const RSS_TIMEOUT_MS = 30000;
const HTML_TIMEOUT_MS = 15000;

const requestHeaders = {
  "User-Agent":
    "Mozilla/5.0 (compatible; RegRadar/1.0; +https://github.com/reg-radar)",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-IN,en;q=0.9",
};

function upgradeToHttps(url) {
  return url.replace(/^http:\/\//i, "https://");
}

async function fetchUrl(url, { timeoutMs, kind }) {
  console.log(`  Fetching ${kind}: ${url} (max ${timeoutMs / 1000}s)`);

  const response = await axios.get(url, {
    timeout: timeoutMs,
    maxRedirects: 5,
    headers: requestHeaders,
    beforeRedirect: (options) => {
      options.href = upgradeToHttps(options.href);
    },
  });

  return response;
}

function getPagesBaseUrl() {
  const repo = process.env.GITHUB_REPOSITORY || "USERNAME/reg-radar";
  const [owner, name] = repo.split("/");
  return `https://${owner}.github.io/${name}/`;
}

function getRepoUrl() {
  const repo = process.env.GITHUB_REPOSITORY || "USERNAME/reg-radar";
  return `https://github.com/${repo}`;
}

function toAbsoluteUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function normalizeItem(item) {
  return {
    title: (item.title || "").trim(),
    link: (item.link || "").trim(),
    pubDate: item.pubDate || new Date().toISOString(),
    tag: item.tag || "",
    source: item.source || "",
    type: item.type || "",
  };
}

function toRfc822(dateInput) {
  const date = dateInput ? new Date(dateInput) : new Date();
  if (Number.isNaN(date.getTime())) {
    return new Date().toUTCString();
  }
  return date.toUTCString();
}

function formatIst(isoString) {
  const date = isoString ? new Date(isoString) : new Date();
  return date.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function fetchRssSource(source) {
  const response = await fetchUrl(source.url, {
    timeoutMs: RSS_TIMEOUT_MS,
    kind: "RSS",
  });
  const parsed = await parseStringPromise(response.data, {
    explicitArray: false,
    trim: true,
  });

  const channel = parsed?.rss?.channel || parsed?.feed;
  if (!channel) {
    throw new Error("No RSS channel found in response");
  }

  let rawItems = channel.item || channel.entry || [];
  if (!Array.isArray(rawItems)) {
    rawItems = rawItems ? [rawItems] : [];
  }

  const items = rawItems
    .map((entry) => {
      const link =
        entry.link?.href ||
        entry.link?._ ||
        entry.link ||
        entry.guid?._ ||
        entry.guid ||
        "";
      const title = entry.title?._ || entry.title || "";
      const pubDate =
        entry.pubDate ||
        entry.published ||
        entry.updated ||
        entry["dc:date"] ||
        new Date().toISOString();

      return normalizeItem({
        title,
        link: typeof link === "string" ? link : String(link),
        pubDate,
        tag: source.tag,
        source: source.name,
        type: "rss",
      });
    })
    .filter((item) => item.link && item.title);

  return items;
}

function isNpciLink(href) {
  if (!href) return false;
  const lower = href.toLowerCase();
  return lower.includes("/pdf/") || lower.includes("/circular") || lower.includes("npci.org.in");
}

function isMeityLink(href, text) {
  if (!href) return false;
  const lower = href.toLowerCase();
  const textLower = (text || "").toLowerCase();
  return (
    lower.includes(".pdf") ||
    lower.includes("notification") ||
    lower.includes("circular") ||
    lower.includes("/content/") ||
    textLower.includes("notification") ||
    textLower.includes("circular")
  );
}

function isFiuLink(href, text) {
  if (!href) return false;
  const lower = href.toLowerCase();
  const textLower = (text || "").toLowerCase();
  return (
    lower.includes(".pdf") ||
    lower.includes("circular") ||
    lower.endsWith(".html") ||
    textLower.includes("circular")
  );
}

async function fetchHtmlSource(source) {
  const response = await fetchUrl(source.url, {
    timeoutMs: HTML_TIMEOUT_MS,
    kind: "HTML",
  });
  const $ = cheerio.load(response.data);
  const items = [];
  const seenLinks = new Set();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    const title = $(el).text().replace(/\s+/g, " ").trim();
    const fullUrl = toAbsoluteUrl(href, source.url);

    if (!fullUrl || !title || seenLinks.has(fullUrl)) return;

    let matches = false;
    if (source.tag === "NPCI") {
      matches = isNpciLink(href) || isNpciLink(fullUrl);
    } else if (source.tag === "MeitY") {
      matches = isMeityLink(href, title);
    } else if (source.tag === "FIU") {
      matches = isFiuLink(href, title);
    } else {
      matches =
        href.includes("/PDF/") ||
        href.includes("/circular") ||
        href.toLowerCase().includes("/pdf/");
    }

    if (!matches) return;

    seenLinks.add(fullUrl);
    items.push(
      normalizeItem({
        title,
        link: fullUrl,
        pubDate: new Date().toISOString(),
        tag: source.tag,
        source: source.name,
        type: "html",
      })
    );
  });

  return items;
}

async function parseExistingFeed() {
  try {
    const raw = await fs.readFile(FEED_PATH, "utf8");
    const parsed = await parseStringPromise(raw, {
      explicitArray: false,
      trim: true,
    });
    let rawItems = parsed?.rss?.channel?.item || [];
    if (!Array.isArray(rawItems)) {
      rawItems = rawItems ? [rawItems] : [];
    }

    return rawItems.map((entry) =>
      normalizeItem({
        title: (entry.title || "").replace(/^\[[^\]]+\]\s*/, ""),
        link: entry.link || entry.guid || "",
        pubDate: entry.pubDate || new Date().toISOString(),
        tag: (entry.title?.match(/^\[([^\]]+)\]/) || [])[1] || "",
        source: "",
      })
    );
  } catch {
    return [];
  }
}

function buildFeedXml(items, baseUrl) {
  const channelItems = items
    .slice(0, MAX_FEED_ITEMS)
    .map((item) => {
      const title = item.tag ? `[${item.tag}] ${item.title}` : item.title;
      return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(item.link)}</link>
      <pubDate>${escapeXml(toRfc822(item.pubDate))}</pubDate>
      <guid isPermaLink="true">${escapeXml(item.link)}</guid>
    </item>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>RegRadar — Indian Fintech Regulatory Updates</title>
    <link>${escapeXml(baseUrl)}</link>
    <description>Weekly tracker for RBI, NPCI, MeitY and FIU circulars</description>
    <language>en-in</language>
    <lastBuildDate>${escapeXml(toRfc822(new Date()))}</lastBuildDate>
${channelItems}
  </channel>
</rss>
`;
}

function tagBadgeColor(tag) {
  const colors = {
    RBI: "#1e40af",
    NPCI: "#047857",
    MeitY: "#7c3aed",
    FIU: "#b45309",
  };
  return colors[tag] || "#374151";
}

function typeBadgeColor(type) {
  return type === "rss" ? "#0369a1" : "#6d28d9";
}

function typeLabel(type) {
  return type === "rss" ? "RSS" : type === "html" ? "HTML" : "—";
}

function mergeTrackedItems(existingItems, crawledItems, feedItems) {
  const map = new Map();

  for (const item of existingItems) {
    if (item.link) map.set(item.link, normalizeItem(item));
  }
  for (const item of feedItems) {
    if (item.link && !map.has(item.link)) {
      map.set(item.link, normalizeItem({ ...item, type: item.type || "rss" }));
    }
  }
  for (const item of crawledItems) {
    if (item.link) map.set(item.link, normalizeItem(item));
  }

  return [...map.values()].sort(
    (a, b) => new Date(b.pubDate) - new Date(a.pubDate)
  );
}

function buildItemTableRows(items, { includeSource = false } = {}) {
  return items
    .map((item) => {
      const date = formatIst(item.pubDate);
      const type = typeLabel(item.type);
      const sourceCell = includeSource
        ? `<td style="padding:10px;font-size:13px;color:#6b7280">${escapeHtml(item.source || "—")}</td>`
        : "";
      return `        <tr>
          <td style="padding:10px"><span style="background:${tagBadgeColor(item.tag)};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">${escapeHtml(item.tag)}</span></td>
          <td style="padding:10px"><span style="background:${typeBadgeColor(item.type)};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;text-transform:uppercase">${escapeHtml(type)}</span></td>
          ${sourceCell}
          <td style="padding:10px">${escapeHtml(item.title)}</td>
          <td style="padding:10px;font-size:13px;color:#6b7280;white-space:nowrap">${escapeHtml(date)}</td>
          <td style="padding:10px"><a href="${escapeHtml(item.link)}" target="_blank" rel="noopener noreferrer" style="color:#2563eb">View</a></td>
        </tr>`;
    })
    .join("\n");
}

function buildIndexHtml({
  statuses,
  newItems,
  allTracked,
  runStats,
  lastRun,
  baseUrl,
  repoUrl,
}) {
  const lastUpdated = formatIst(lastRun);
  const { rssThisRun, htmlThisRun, totalTracked, rssTracked, htmlTracked, successCount, failedCount, totalSources } =
    runStats;

  const allOk = failedCount === 0;
  const runBannerBg = allOk ? "#ecfdf5" : failedCount === totalSources ? "#fef2f2" : "#fffbeb";
  const runBannerBorder = allOk ? "#6ee7b7" : failedCount === totalSources ? "#fca5a5" : "#fcd34d";
  const runBannerColor = allOk ? "#065f46" : failedCount === totalSources ? "#991b1b" : "#92400e";
  const runBannerIcon = allOk ? "✓" : failedCount === totalSources ? "✗" : "⚠";
  const runBannerText = allOk
    ? `<strong>${successCount}/${totalSources} sources OK</strong> — all sources responded successfully.`
    : failedCount === totalSources
      ? `<strong>0/${totalSources} sources OK</strong> — all sources failed. Check errors below.`
      : `<strong>${successCount}/${totalSources} sources OK</strong> — ${failedCount} source${failedCount === 1 ? "" : "s"} failed. See errors below.`;

  const statusRows = statuses
    .map((s) => {
      const bg = s.success ? "#ecfdf5" : "#fef2f2";
      const icon = s.success ? "✓" : "✗";
      const itemsFound = s.success ? String(s.count) : "—";
      const checked = formatIst(s.checkedAt);
      const type = typeLabel(s.type);
      const errorCell = s.success
        ? `<td style="padding:10px;font-size:13px;color:#9ca3af">—</td>`
        : `<td style="padding:10px;font-size:13px;color:#dc2626">${escapeHtml(s.error || "Unknown error")}</td>`;
      return `        <tr style="background:${bg}">
          <td style="padding:10px;text-align:center;font-weight:bold;color:${s.success ? "#059669" : "#dc2626"}">${icon}</td>
          <td style="padding:10px">${escapeHtml(s.name)}</td>
          <td style="padding:10px"><span style="background:${typeBadgeColor(s.type)};color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;text-transform:uppercase">${escapeHtml(type)}</span></td>
          <td style="padding:10px"><span style="background:${tagBadgeColor(s.tag)};color:#fff;padding:2px 8px;border-radius:4px;font-size:12px">${escapeHtml(s.tag)}</span></td>
          <td style="padding:10px;text-align:center">${itemsFound}</td>
          ${errorCell}
          <td style="padding:10px;font-size:13px;color:#6b7280">${escapeHtml(checked)}</td>
        </tr>`;
    })
    .join("\n");

  let newSection;
  if (newItems.length === 0) {
    newSection = `      <p style="color:#059669;background:#ecfdf5;padding:16px;border-radius:8px;margin:0">
        No new circulars found this week. All systems operational.
      </p>`;
  } else {
    const newRows = buildItemTableRows(newItems);
    newSection = `      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#f3f4f6;text-align:left">
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Tag</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Type</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Title</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Date</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Link</th>
            </tr>
          </thead>
          <tbody>
${newRows}
          </tbody>
        </table>
      </div>`;
  }

  let trackedSection;
  if (allTracked.length === 0) {
    trackedSection = `      <p style="color:#6b7280;margin:0">No circulars tracked yet. Run the crawler to populate this list.</p>`;
  } else {
    const trackedRows = buildItemTableRows(allTracked, { includeSource: true });
    trackedSection = `      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#f3f4f6;text-align:left">
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Tag</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Type</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Source</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Title</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Date</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Link</th>
            </tr>
          </thead>
          <tbody>
${trackedRows}
          </tbody>
        </table>
      </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>RegRadar — Indian Fintech Regulatory Monitor</title>
  <link rel="alternate" type="application/rss+xml" title="RegRadar RSS Feed" href="feed.xml">
</head>
<body style="margin:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f9fafb;color:#111827;line-height:1.5">
  <div style="max-width:960px;margin:0 auto;padding:24px 16px 48px">
    <header style="margin-bottom:32px">
      <h1 style="margin:0 0 4px;font-size:2rem;font-weight:700">RegRadar</h1>
      <p style="margin:0 0 8px;color:#6b7280;font-size:1.1rem">Indian Fintech Regulatory Monitor</p>
      <p style="margin:0 0 8px;font-size:14px;color:#9ca3af">Last updated: ${escapeHtml(lastUpdated)} IST</p>
      <p style="margin:0 0 12px;font-size:14px;color:#374151">
        This run: <strong>${rssThisRun} from RSS</strong> · <strong>${htmlThisRun} from HTML scrape</strong>
        &nbsp;|&nbsp; Total tracked: <strong>${totalTracked}</strong> (${rssTracked} RSS · ${htmlTracked} HTML)
      </p>
      <p style="margin:0"><a href="feed.xml" style="color:#2563eb;font-size:14px">Subscribe to RSS feed</a></p>
    </header>

    <div style="margin-bottom:24px;padding:14px 16px;border-radius:8px;border:1px solid ${runBannerBorder};background:${runBannerBg};color:${runBannerColor};font-size:14px">
      <div style="margin-bottom:4px;font-size:13px;opacity:0.85">
        Latest run: <time datetime="${escapeHtml(lastRun)}">${escapeHtml(lastUpdated)} IST</time>
      </div>
      <div><span style="font-weight:bold;margin-right:6px">${runBannerIcon}</span>${runBannerText}</div>
    </div>

    <section style="margin-bottom:32px">
      <h2 style="margin:0 0 12px;font-size:1.25rem">Crawl Status</h2>
      <div style="overflow-x:auto;background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1)">
        <table style="width:100%;border-collapse:collapse;font-size:14px">
          <thead>
            <tr style="background:#f3f4f6;text-align:left">
              <th style="padding:10px;border-bottom:2px solid #e5e7eb;width:40px"></th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Source</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Type</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Tag</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Items Found</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Error</th>
              <th style="padding:10px;border-bottom:2px solid #e5e7eb">Last Checked</th>
            </tr>
          </thead>
          <tbody>
${statusRows}
          </tbody>
        </table>
      </div>
    </section>

    <section style="margin-bottom:32px">
      <h2 style="margin:0 0 12px;font-size:1.25rem">New This Week</h2>
      <div style="background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);padding:16px">
${newSection}
      </div>
    </section>

    <section style="margin-bottom:32px">
      <h2 style="margin:0 0 12px;font-size:1.25rem">All Tracked Circulars</h2>
      <p style="margin:0 0 12px;font-size:14px;color:#6b7280">${totalTracked} circulars tracked across all sources</p>
      <div style="background:#fff;border-radius:8px;box-shadow:0 1px 3px rgba(0,0,0,0.1);padding:16px">
${trackedSection}
      </div>
    </section>

    <footer style="border-top:1px solid #e5e7eb;padding-top:16px;font-size:13px;color:#9ca3af;text-align:center">
      Powered by GitHub Actions | Source code: <a href="${escapeHtml(repoUrl)}" style="color:#2563eb">GitHub</a>
    </footer>
  </div>
</body>
</html>
`;
}

async function main() {
  console.log("RegRadar crawl starting...\n");

  console.log("STEP 1 — Loading sources and seen.json");
  const sources = await loadJson(SOURCES_PATH, []);
  const seen = await loadJson(SEEN_PATH, { urls: [], items: [], last_run: null });
  if (!Array.isArray(seen.urls)) seen.urls = [];
  if (!Array.isArray(seen.items)) seen.items = [];
  console.log(`  Loaded ${sources.length} sources, ${seen.urls.length} seen URLs\n`);

  console.log("STEP 2 — Crawling sources");
  const allItems = [];
  const statuses = [];

  for (const source of sources) {
    const checkedAt = new Date().toISOString();
    console.log(`\nProcessing: ${source.name} (${source.tag}, ${source.type})`);

    try {
      let items;
      if (source.type === "rss") {
        items = await fetchRssSource(source);
      } else if (source.type === "html") {
        items = await fetchHtmlSource(source);
      } else {
        throw new Error(`Unknown source type: ${source.type}`);
      }

      allItems.push(...items.map((item) => normalizeItem({ ...item, type: source.type })));
      statuses.push({
        name: source.name,
        tag: source.tag,
        type: source.type,
        success: true,
        count: items.length,
        checkedAt,
      });
      console.log(`  ✓ Success — ${items.length} items`);
    } catch (err) {
      const message = err?.message || String(err);
      statuses.push({
        name: source.name,
        tag: source.tag,
        type: source.type,
        success: false,
        error: message,
        checkedAt,
      });
      console.log(`  ✗ Failed — ${message}`);
    }
  }

  console.log("\nSTEP 3 — Deduplicating against seen URLs");
  const seenSet = new Set(seen.urls);
  const newItems = allItems.filter((item) => item.link && !seenSet.has(item.link));
  console.log(`  Total collected: ${allItems.length}, new: ${newItems.length}`);

  console.log("\nSTEP 4 — Saving seen.json");
  const now = new Date().toISOString();
  const existingFeedItems = await parseExistingFeed();
  const allTracked = mergeTrackedItems(seen.items, allItems, existingFeedItems);

  for (const item of newItems) {
    if (!seenSet.has(item.link)) {
      seen.urls.push(item.link);
      seenSet.add(item.link);
    }
  }
  seen.items = allTracked;
  seen.last_run = now;
  await fs.mkdir(path.dirname(SEEN_PATH), { recursive: true });
  await fs.writeFile(SEEN_PATH, JSON.stringify(seen, null, 2) + "\n", "utf8");
  console.log(`  Updated seen.json — ${seen.urls.length} total URLs`);

  console.log("\nSTEP 5 — Generating docs/feed.xml");
  const baseUrl = getPagesBaseUrl();
  const feedItemMap = new Map();

  for (const item of newItems) {
    feedItemMap.set(item.link, item);
  }
  for (const item of existingFeedItems) {
    if (!feedItemMap.has(item.link)) {
      feedItemMap.set(item.link, item);
    }
  }

  const feedItems = [...feedItemMap.values()].sort(
    (a, b) => new Date(b.pubDate) - new Date(a.pubDate)
  );
  const feedXml = buildFeedXml(feedItems, baseUrl);
  await fs.mkdir(path.dirname(FEED_PATH), { recursive: true });
  await fs.writeFile(FEED_PATH, feedXml, "utf8");
  console.log(`  Wrote feed.xml with ${Math.min(feedItems.length, MAX_FEED_ITEMS)} items`);

  console.log("\nSTEP 6 — Generating docs/index.html");
  const runStats = {
    rssThisRun: allItems.filter((i) => i.type === "rss").length,
    htmlThisRun: allItems.filter((i) => i.type === "html").length,
    totalTracked: allTracked.length,
    rssTracked: allTracked.filter((i) => i.type === "rss").length,
    htmlTracked: allTracked.filter((i) => i.type === "html").length,
    successCount: statuses.filter((s) => s.success).length,
    failedCount: statuses.filter((s) => !s.success).length,
    totalSources: statuses.length,
  };
  const indexHtml = buildIndexHtml({
    statuses,
    newItems,
    allTracked,
    runStats,
    lastRun: now,
    baseUrl,
    repoUrl: getRepoUrl(),
  });
  await fs.writeFile(INDEX_PATH, indexHtml, "utf8");
  console.log("  Wrote index.html");

  const successCount = statuses.filter((s) => s.success).length;
  const failedCount = statuses.filter((s) => !s.success).length;

  console.log("\nSTEP 7 — Summary");
  console.log("Crawl complete");
  console.log(`Sources: ${successCount} success, ${failedCount} failed`);
  console.log(`New circulars: ${newItems.length}`);
}

main().catch((err) => {
  console.error("Fatal error:", err?.message || err);
  process.exit(1);
});

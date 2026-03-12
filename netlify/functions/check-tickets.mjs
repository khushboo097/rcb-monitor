// Netlify Scheduled Function — runs every 2 minutes
// Three independent detection layers:
//   LAYER 1: Twitter/X Syndication API (no auth, powers embedded widgets)
//   LAYER 2: RSSHub public instance (scrapes @RCBTweets RSS)
//   LAYER 3: royalchallengers.com website signals (shop page + nav + fixtures)
// Any layer firing sends an urgent ntfy push to your phone.

const NTFY_TOPIC = "rcb-tickets-monitor";
const NTFY_SERVER = "https://ntfy.sh";
const RCB_HANDLE = "RCBTweets";

// Tweet keywords that indicate tickets going on sale
const TICKET_TWEET_KEYWORDS = [
  "ticket",
  "tickets",
  "book now",
  "buy now",
  "live now",
  "on sale",
  "shop.royalchallengers",
  "chinnaswamy",
  "srh",
  "sunrisers",
  "rcb",
  "ipl2026"
];

const FETCH_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-IN,en;q=0.9",
  "Cache-Control": "no-cache, no-store",
  Pragma: "no-cache",
};

// ─── LAYER 1: Twitter Syndication API ─────────────────────────────────────
// Powers Twitter's own embed widgets — no auth required, no rate limit for
// light personal use. Returns HTML containing tweet text we can parse.
// URL: https://syndication.twitter.com/srv/timeline-profile/screen-name/RCBTweets
async function checkTwitterSyndication() {
  const url = `https://syndication.twitter.com/srv/timeline-profile/screen-name/${RCB_HANDLE}?dnt=true&lang=en`;

  try {
    const res = await fetch(url, {
      headers: {
        ...FETCH_HEADERS,
        Accept: "text/html,*/*",
        Referer: "https://twitter.com/",
      },
      signal: AbortSignal.timeout(12000),
    });

    if (!res.ok) {
      console.log(`Syndication API returned ${res.status}`);
      return { found: false, source: "syndication", error: `HTTP ${res.status}` };
    }

    const body = await res.text();

    // Syndication API can return JSON or HTML depending on endpoint
    // Try JSON parsing first (returns tweet objects with full_text)
    try {
      const data = JSON.parse(body);
      const tweets = extractTweetsFromJSON(data);
      console.log(`Syndication: found ${tweets.length} tweets`);
      tweets.forEach((t, i) => console.log(`  [${i + 1}] ${t.text.substring(0, 150)}`));
      for (const tweet of tweets) {
        if (isTweetAboutTickets(tweet.text)) {
          return {
            found: true,
            source: "Twitter Syndication API",
            reason: `@RCBTweets tweeted about tickets: "${tweet.text.substring(0, 120)}..."`,
            tweetText: tweet.text,
          };
        }
      }
      return { found: false, source: "syndication", checked: true };
    } catch (_) {
      // Not JSON — fall back to HTML parsing
      console.log(`Syndication: response is HTML (${body.length} chars), extracting tweets...`);
      const result = parseTweetsFromHTML(body, "Twitter Syndication API");
      console.log(`Syndication HTML parse result: found=${result.found}, checked=${result.checked}`);
      return result;
    }
  } catch (err) {
    console.log(`Syndication API error: ${err.message}`);
    return { found: false, source: "syndication", error: err.message };
  }
}

// ─── LAYER 2: RSSHub ──────────────────────────────────────────────────────
// RSSHub is a well-maintained open-source RSS aggregator that scrapes Twitter.
// Public instance at rsshub.app. Falls back to self-hosted instances.
async function checkRSSHub() {
  const instances = [
    `https://rsshub.app/twitter/user/${RCB_HANDLE}`,
    `https://hub.slarker.me/twitter/user/${RCB_HANDLE}`,
    `https://rsshub.rssforever.com/twitter/user/${RCB_HANDLE}`,
  ];

  for (const url of instances) {
    try {
      const res = await fetch(url, {
        headers: {
          ...FETCH_HEADERS,
          Accept: "application/rss+xml, application/xml, text/xml",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!res.ok) continue;

      const xml = await res.text();
      if (!xml.includes("<item>") && !xml.includes("<entry>")) continue;

      const result = parseTweetsFromRSS(xml, url);
      if (result.checked) return result;
    } catch (err) {
      console.log(`RSSHub instance ${url} error: ${err.message}`);
    }
  }

  return { found: false, source: "rsshub", error: "All instances failed or returned no items" };
}

// ─── LAYER 3: Website signals ─────────────────────────────────────────────
// Three sub-checks on royalchallengers.com itself (from previous version)
async function checkWebsite() {
  const checks = await Promise.allSettled([
    checkShopTicketsPage(),
    checkHomepageNav(),
    checkFixturesPage(),
  ]);

  for (const r of checks) {
    if (r.status === "fulfilled" && r.value.found) return r.value;
  }
  return { found: false, source: "website" };
}

async function checkShopTicketsPage() {
  const paths = [
    "https://shop.royalchallengers.com/tickets",
    "https://shop.royalchallengers.com/match-tickets",
    "https://shop.royalchallengers.com/ipl-2026-tickets",
  ];
  for (const url of paths) {
    try {
      const res = await fetch(url, {
        headers: FETCH_HEADERS,
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      if (res.status === 200) {
        const html = await res.text();
        const lower = html.toLowerCase();
        if (
          lower.includes("ticket") &&
          (lower.includes("srh") || lower.includes("sunrisers") ||
            lower.includes("chinnaswamy") || lower.includes("add to cart") ||
            lower.includes("select seat") || lower.includes("march 28"))
        ) {
          return { found: true, source: "website-shop", url, reason: `Shop ticket page live at ${url}` };
        }
      }
    } catch (_) {}
  }
  return { found: false };
}

async function checkHomepageNav() {
  try {
    const res = await fetch("https://www.royalchallengers.com/", {
      headers: FETCH_HEADERS, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { found: false };
    const html = await res.text();
    // Only match href in actual <a> tags, not CSS selectors or style blocks
    const patterns = [
      /<a\s[^>]*href=["'][^"']*shop\.royalchallengers\.com[^"']*ticket[^"']*["'][^>]*>/i,
      /<a\s[^>]*href=["'][^"']*royalchallengers\.com\/(buy-)?tickets[^"']*["'][^>]*>/i,
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m) return { found: true, source: "website-nav", url: "https://www.royalchallengers.com/", reason: `Ticket href in homepage: ${m[0].substring(0, 80)}` };
    }
  } catch (_) {}
  return { found: false };
}

async function checkFixturesPage() {
  try {
    const res = await fetch("https://www.royalchallengers.com/fixtures", {
      headers: FETCH_HEADERS, signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { found: false };
    const html = await res.text();
    const m = html.match(/href=["'][^"']*shop\.royalchallengers\.com[^"']*ticket[^"']*["']/i);
    if (m) return { found: true, source: "website-fixtures", url: "https://www.royalchallengers.com/fixtures", reason: `Ticket CTA on fixtures: ${m[0].substring(0, 80)}` };
    const lower = html.toLowerCase();
    if ((lower.includes("buy tickets") || lower.includes("book tickets")) &&
        (lower.includes("srh") || lower.includes("march 28") || lower.includes("chinnaswamy"))) {
      return { found: true, source: "website-fixtures", url: "https://www.royalchallengers.com/fixtures", reason: "Buy tickets CTA + match ref on fixtures page" };
    }
  } catch (_) {}
  return { found: false };
}

// ─── TWEET PARSERS ────────────────────────────────────────────────────────

// Recursively extract tweet text from syndication JSON (structure varies)
function extractTweetsFromJSON(obj, results = []) {
  if (!obj || typeof obj !== "object") return results;
  if (obj.full_text || obj.text) {
    results.push({ text: obj.full_text || obj.text });
  }
  for (const val of Object.values(obj)) {
    if (Array.isArray(val)) {
      for (const item of val) extractTweetsFromJSON(item, results);
    } else if (typeof val === "object" && val !== null) {
      extractTweetsFromJSON(val, results);
    }
  }
  return results;
}

function isTweetAboutTickets(text) {
  const lower = text.toLowerCase();
  const hasKeyword = TICKET_TWEET_KEYWORDS.some((kw) => lower.includes(kw));
  if (!hasKeyword) return false;

  const hasTicket = lower.includes("ticket") || lower.includes("tickets");
  const hasAction =
    lower.includes("live") ||
    lower.includes("on sale") ||
    lower.includes("book") ||
    lower.includes("buy") ||
    lower.includes("available") ||
    lower.includes("hurry") ||
    lower.includes("get your") ||
    lower.includes("now");
  const hasShopLink = lower.includes("shop.royalchallengers") || lower.includes("royalchallengers.com");

  return (hasTicket && hasAction) || (hasTicket && hasShopLink);
}

function isRecentTweet(dateStr) {
  // Only alert on tweets from the last 30 minutes to avoid false positives
  try {
    const tweetTime = new Date(dateStr).getTime();
    const now = Date.now();
    const thirtyMinutes = 30 * 60 * 1000;
    return now - tweetTime < thirtyMinutes;
  } catch (_) {
    return true; // If we can't parse date, assume recent
  }
}

function parseTweetsFromHTML(html, sourceName) {
  // Syndication API returns HTML with tweet text in <p> or data-* attributes
  // Extract text content between tweet-related tags
  const tweetMatches = [
    ...html.matchAll(/"text"\s*:\s*"([^"]{20,500})"/g),
    ...html.matchAll(/"full_text"\s*:\s*"([^"]{20,500})"/g),
    ...html.matchAll(/<p[^>]*class="[^"]*tweet-text[^"]*"[^>]*>([^<]+)</g),
    ...html.matchAll(/data-tweet-text="([^"]{20,500})"/g),
  ];
  console.log(`  ${sourceName}: matched ${tweetMatches.length} tweet texts`);
  tweetMatches.slice(0, 10).forEach((m, i) => {
    const text = m[1].replace(/\\n/g, " ").substring(0, 120);
    console.log(`    [${i + 1}] ${text}`);
  });

  for (const match of tweetMatches) {
    const text = match[1].replace(/\\n/g, " ").replace(/\\u[0-9a-f]{4}/gi, "");
    if (isTweetAboutTickets(text)) {
      return {
        found: true,
        source: sourceName,
        reason: `@RCBTweets tweeted about tickets: "${text.substring(0, 120)}..."`,
        tweetText: text,
      };
    }
  }

  // Also check if the raw HTML itself contains ticket keywords (fallback)
  const lower = html.toLowerCase();
  const hasTicketSignal =
    lower.includes("tickets live") ||
    lower.includes("tickets are live") ||
    lower.includes("get your tickets") ||
    lower.includes("book your tickets") ||
    (lower.includes("ticket") && lower.includes("shop.royalchallengers"));

  if (hasTicketSignal) {
    return {
      found: true,
      source: sourceName,
      reason: `Ticket sale signal detected in @RCBTweets timeline`,
    };
  }

  return { found: false, source: sourceName, checked: true };
}

function parseTweetsFromRSS(xml, instanceUrl) {
  // Parse RSS/Atom <item> or <entry> blocks
  const itemRegex = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/gi;
  const items = [...xml.matchAll(itemRegex)];

  if (items.length === 0) return { found: false, checked: false };

  for (const item of items) {
    const itemContent = item[1];

    // Extract pub date
    const dateMatch =
      itemContent.match(/<pubDate>([^<]+)<\/pubDate>/) ||
      itemContent.match(/<published>([^<]+)<\/published>/) ||
      itemContent.match(/<updated>([^<]+)<\/updated>/);
    const pubDate = dateMatch ? dateMatch[1].trim() : null;

    // Only look at recent tweets
    if (pubDate && !isRecentTweet(pubDate)) continue;

    // Extract tweet text from title or description
    const titleMatch = itemContent.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/i);
    const descMatch = itemContent.match(/<description[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i);
    const contentMatch = itemContent.match(/<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/i);

    const rawText = [titleMatch?.[1], descMatch?.[1], contentMatch?.[1]]
      .filter(Boolean)
      .join(" ")
      .replace(/<[^>]+>/g, " ") // Strip HTML tags
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();

    if (rawText.length > 10 && isTweetAboutTickets(rawText)) {
      return {
        found: true,
        source: `RSSHub (${instanceUrl})`,
        reason: `@RCBTweets tweeted about tickets: "${rawText.substring(0, 120)}..."`,
        tweetText: rawText,
        checked: true,
      };
    }
  }

  return { found: false, source: "rsshub", checked: true };
}

// ─── NOTIFICATION ─────────────────────────────────────────────────────────
async function sendPushNotification(result) {
  const isTwitter = result.source?.includes("syndication") || result.source?.includes("RSSHub");
  const body = isTwitter
    ? `@RCBTweets just posted about tickets! ${result.tweetText ? `"${result.tweetText.substring(0, 100)}"` : ""} → Go to shop.royalchallengers.com NOW!`
    : `RCB ticket sale detected via website! ${result.reason} → Go to shop.royalchallengers.com NOW!`;

  try {
    await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: "RCB TICKETS ARE LIVE - BUY NOW!",
        Priority: "urgent",
        Tags: "rotating_light,cricket,ticket",
        Click: "https://shop.royalchallengers.com",
        Actions: "view, Buy Tickets NOW, https://shop.royalchallengers.com, clear=true; view, See Tweet, https://twitter.com/RCBTweets",
        "Content-Type": "text/plain",
      },
      body,
    });
    console.log("✅ Push sent via ntfy.sh");
  } catch (err) {
    console.error("ntfy push failed:", err.message);
  }
}

async function sendHeartbeat(details) {
  try {
    const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}-log`, {
      method: "POST",
      headers: {
        Title: "RCB Watch - No tickets yet",
        Priority: "default",
        Tags: "eyes",
        "Content-Type": "text/plain",
      },
      body: `${new Date().toISOString()} — ${details}`,
    });
    console.log(`Heartbeat sent: ${res.status} ${res.statusText}`);
  } catch (err) {
    console.error("Heartbeat failed:", err.message);
  }
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────
export const handler = async () => {
  console.log(`[${new Date().toISOString()}] Starting 3-layer RCB ticket check...`);

  try {
    // Run all three layers in parallel
    const [twitterResult, rsshubResult, websiteResult] = await Promise.allSettled([
      checkTwitterSyndication(),
      checkRSSHub(),
      checkWebsite(),
    ]);

    const results = [twitterResult, rsshubResult, websiteResult].map(
      (r) => (r.status === "fulfilled" ? r.value : { found: false, error: r.reason?.message })
    );

    console.log("Layer results:", JSON.stringify(results.map(r => ({ found: r.found, source: r.source, error: r.error }))));

    // Check if any layer found tickets
    const hit = results.find((r) => r.found);
    if (hit) {
      console.log(`🎟️ TICKETS FOUND via ${hit.source}! ${hit.reason}`);
      await sendPushNotification(hit);
      return {
        statusCode: 200,
        body: JSON.stringify({ status: "TICKETS_FOUND", ...hit, timestamp: new Date().toISOString() }),
      };
    }

    // Summarise what each layer found for the heartbeat log
    const summary = results
      .map((r) => `${r.source || "unknown"}: ${r.error ? `ERR(${r.error.substring(0, 30)})` : "no tickets"}`)
      .join(" | ");

    await sendHeartbeat(summary);
    console.log(`No tickets found. ${summary}`);

    return {
      statusCode: 200,
      body: JSON.stringify({ status: "NO_TICKETS", summary, timestamp: new Date().toISOString() }),
    };
  } catch (err) {
    console.error("Fatal error:", err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};

// Run every 2 minutes
export const config = {
  schedule: "*/2 * * * *",
};

/**
 * Bot detection for email engagement (opens and clicks)
 *
 * Inverted API versus older "valid" checks:
 * - Returns { isBot, reason } for transparency
 */

// Exact-match known bot user agents (case-sensitive to avoid over-matching)
export const KNOWN_BOT_AGENTS = new Set<string>([
  "HubSpot Connect",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0",
  "AHC/2.1",
  "Amazon CloudFront",
  "Barracuda Sentinel (EE)",
  "python-requests/2.26.0",
  "Python/3.9 aiohttp/3.8.1",
  "lua-resty-http/0.07 (Lua) ngx_lua/10012",
  "lua-resty-http/0.10 (Lua) ngx_lua/10019",
  "okhttp/4.10.0",
  "python-requests/2.27.1",
  "python-requests/2.28.0",
  "lua-resty-http/0.07 (Lua) ngx_lua/10024",
  "cortex/1.0",
  "Aloha/1 CFNetwork/1404.0.5 Darwin/22.3.0",
  "Dalvik/2.1.0 (Linux; U; Android 8.0.0; SM-G930V Build/R16NW)",
  "Java/17.0.2",
  "macOS/13.4 (22F66) dataaccessd/1.0",
  "Snap URL Preview Service; bot; snapchat; https://developers.snap.com/robots",
  "iOS/16.5.1 (20F75) dataaccessd/1.0",
  "Dalvik/2.1.0 (Linux; U; Android 8.1.0; SM-J327V Build/M1AJQ)",
  "W3C-checklink/4.5 [4.160] libwww-perl/5.823",
  "yarn/1.22.4 npm/? node/v16.20.0 linux x64",
  "Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.14931; Pro)",
  "Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.16327; Pro)",
  "Social News Desk RSS Scraper",
  "iOS/16.3.1 (20D67) dataaccessd/1.0",
  "facebookexternalua",
  "Jetty/9.4.42.v20210604",
  "Microsoft Exchange/15.20 (Windows NT 10.0; Win64; x64)",
  "Dalvik/2.1.0 (Linux; U; Android 8.1.0; LM-Q710(FGN) Build/OPM1.171019.019)",
  "iOS/15.7 (19H12) dataaccessd/1.0",
  "Wget/1.9.1",
  "Office 365 Connectors",
  "Java/1.8.0_265",
  "iOS/15.7.6 (19H349) dataaccessd/1.0",
  "iOS/16.5 (20F66) dataaccessd/1.0",
  "Dalvik/2.1.0 (Linux; U; Android 12; SM-G970U Build/SP1A.210812.016)",
  "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  "Microsoft Office/16.0 (Windows NT 10.0; Microsoft Outlook 16.0.16227; Pro)",
  "python-requests/2.28.2",
  "SCMGUARD",
  "Apache-HttpClient/4.5.1 (Java/1.8.0_172)",
  "FeedBurner/1.0 (http://www.FeedBurner.com)",
]);

// Known email image proxies that correlate to legitimate opens
export const VALID_EMAIL_PROXIES = [
  "GoogleImageProxy",
  "YahooMailProxy",
  "OutlookImageProxy",
];

// Browser identifiers used to detect unusual combinations
export const BROWSER_IDENTIFIERS = [
  "Chrome/",
  "Firefox/",
  "Safari/",
  "Edge/",
  "Edg/", // modern Microsoft Edge UA token
  "Opera/",
];

// Typed reasons for decisions (exported for downstream usage)
export const OPEN_REASONS = {
  EMPTY_USER_AGENT: "empty-user-agent",
  KNOWN_BOT_AGENT: "known-bot-agent",
  BARE_MOZILLA: "bare-mozilla",
  EMAIL_IMAGE_PROXY: "email-image-proxy",
  UNUSUAL_BROWSER_COMBINATION: "unusual-browser-combination",
  LIKELY_BROWSER: "likely-browser",
  TOO_FAST_AFTER_SEND: "too-fast-after-send",
  DEFAULT_ALLOW: "default-allow",
} as const;
export type OpenReason = (typeof OPEN_REASONS)[keyof typeof OPEN_REASONS];

export const CLICK_REASONS = {
  EMPTY_USER_AGENT: "empty-user-agent",
  KNOWN_BOT_AGENT: "known-bot-agent",
  METHOD_HEAD: "method-head",
  UNUSUAL_BROWSER_COMBINATION: "unusual-browser-combination",
  TOO_FAST_AFTER_SEND: "too-fast-after-send",
  LIKELY_BROWSER: "likely-browser",
  DEFAULT_ALLOW: "default-allow",
} as const;
export type ClickReason = (typeof CLICK_REASONS)[keyof typeof CLICK_REASONS];

// -----------------------------
// Open classification (returns isBot)
// -----------------------------

export const checkOpenBot = (input: {
  userAgent: string;
  timeSinceSendMs?: number;
}): { isBot: boolean; reason: OpenReason } => {
  const userAgent = input.userAgent;
  const ua = (userAgent || "").trim();

  // 1) Known bot UAs (highest confidence)
  if (KNOWN_BOT_AGENTS.has(userAgent))
    return { isBot: true, reason: OPEN_REASONS.KNOWN_BOT_AGENT };

  // 2) Known email proxies (legit human opens via proxy)
  if (
    ua &&
    VALID_EMAIL_PROXIES.some((p) => ua.toLowerCase().includes(p.toLowerCase()))
  )
    return { isBot: false, reason: OPEN_REASONS.EMAIL_IMAGE_PROXY };

  if (userAgent.trim().toLowerCase() === "mozilla/5.0")
    return { isBot: false, reason: OPEN_REASONS.BARE_MOZILLA };

  // 3) Timing (fast-after-send ⇒ likely bot)
  if (typeof input.timeSinceSendMs === "number" && input.timeSinceSendMs < 1000)
    return { isBot: true, reason: OPEN_REASONS.TOO_FAST_AFTER_SEND };

  // 4) UA anomalies
  if (ua && hasUnusualBrowserCombination(ua))
    return {
      isBot: true,
      reason: OPEN_REASONS.UNUSUAL_BROWSER_COMBINATION,
    };

  // 5) Likely browsers
  if (ua && isLikelyBrowser(ua))
    return { isBot: false, reason: OPEN_REASONS.LIKELY_BROWSER };

  // 6) Empty UA ⇒ allow (conservative)
  if (!ua) return { isBot: false, reason: OPEN_REASONS.EMPTY_USER_AGENT };

  return { isBot: false, reason: OPEN_REASONS.DEFAULT_ALLOW };
};

const hasUnusualBrowserCombination = (userAgent: string): boolean => {
  const ua = userAgent.toLowerCase();
  let browserCount = 0;
  for (const id of BROWSER_IDENTIFIERS) {
    if (ua.indexOf(id.toLowerCase()) >= 0) browserCount += 1;
  }

  // Conservative: only treat as unusual when multiple browsers present
  if (browserCount > 1) {
    const hasChrome = ua.indexOf("chrome/") >= 0;
    const hasSafari = ua.indexOf("safari/") >= 0;
    const isWebKitCombination = hasChrome && hasSafari; // common in Chrome/Edge UAs
    return !isWebKitCombination;
  }

  return false;
};

const isLikelyBrowser = (userAgent: string): boolean => {
  const ua = userAgent.toLowerCase();

  if (
    ua.includes("iphone") ||
    ua.includes("android") ||
    ua.includes("ipad") ||
    ua.includes("mobile")
  )
    return true;

  const hasMozilla = ua.includes("mozilla/5.0") || ua.includes("mozilla/4.0");
  const hasCommonBrowser =
    ua.includes("chrome/") ||
    ua.includes("firefox/") ||
    ua.includes("safari/") ||
    ua.includes("edge/") ||
    ua.includes("msie") ||
    ua.includes("trident/");

  if (hasMozilla && hasCommonBrowser) return true;

  return false;
};

/**
 * Optional classification helper if a string label is preferred.
 */
export const classifyOpen = (userAgent: string): "human" | "bot" =>
  checkOpenBot({ userAgent }).isBot ? "bot" : "human";

// -----------------------------
// Link click classification (returns isBot)
// -----------------------------

// Common URL rewrite/protection hosts seen in enterprise email security
export const KNOWN_LINK_REWRITE_HOSTS = [
  "urldefense.com", // Proofpoint URL Defense
  "safelinks.protection.outlook.com", // Microsoft Defender Safe Links
  "linkprotect.cudasvc.com", // Barracuda Link Protect
  "mimecast.com", // Mimecast
  "proofpoint.com",
  "trendmicro.com",
];

export const checkClickBot = (input: {
  userAgent?: string;
  method?: string;
  url?: string;
  timeSinceSendMs?: number;
}): { isBot: boolean; reason: ClickReason } => {
  const ua = (input.userAgent || "").trim();
  // HEAD requests are almost always scanners
  if (input.method && input.method.toUpperCase() === "HEAD")
    return { isBot: true, reason: CLICK_REASONS.METHOD_HEAD };

  // Known bot UAs
  if (KNOWN_BOT_AGENTS.has(ua))
    return { isBot: true, reason: CLICK_REASONS.KNOWN_BOT_AGENT };

  // Strong signal: very fast clicks after send
  if (typeof input.timeSinceSendMs === "number" && input.timeSinceSendMs < 1000)
    return { isBot: true, reason: CLICK_REASONS.TOO_FAST_AFTER_SEND };

  if (hasUnusualBrowserCombination(ua))
    return {
      isBot: true,
      reason: CLICK_REASONS.UNUSUAL_BROWSER_COMBINATION,
    };

  // Conservative: empty UA treated as human
  if (!ua) return { isBot: false, reason: CLICK_REASONS.EMPTY_USER_AGENT };

  // Neutral treatment of rewrite hosts (no decision impact today)
  if (input.url) {
    try {
      const hostname = new URL(input.url).hostname.toLowerCase();
      void hostname;
    } catch {
      // ignore URL parse issues
    }
  }

  if (isLikelyBrowser(ua))
    return { isBot: false, reason: CLICK_REASONS.LIKELY_BROWSER };

  return { isBot: false, reason: CLICK_REASONS.DEFAULT_ALLOW };
};

/**
 * Optional classification helper for link clicks.
 */
export const classifyClick = (input: {
  userAgent?: string;
  method?: string;
  url?: string;
  timeSinceSendMs?: number;
}): "human" | "bot" => (checkClickBot(input).isBot ? "bot" : "human");

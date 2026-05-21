import type { SandboxTrace } from "./sandbox-types";

export type TraceFilters = {
  query: string;
  category: "all" | SandboxTrace["events"][number]["category"];
  kind: string;
  status: string;
  recency: "all" | "15m" | "1h" | "24h" | "7d";
  errorsOnly: boolean;
};

export const DEFAULT_TRACE_FILTERS: TraceFilters = {
  query: "",
  category: "all",
  kind: "all",
  status: "all",
  recency: "all",
  errorsOnly: false,
};

// ── Label / color helpers ──

const EVENT_LABEL_MAP: [string, string][] = [
  ["delivered", "Delivered"],
  ["opened", "Opened"],
  ["clicked", "Clicked"],
  ["bounced", "Bounced"],
  ["complained", "Complained"],
  ["rejected", "Rejected"],
  ["send", "Sent"],
  ["inbound", "Inbound"],
  ["outbound", "Accepted"],
  ["webhook-request", "Webhook"],
  ["webhook-response", "Response"],
  ["unknown", "Unknown"],
];

export const eventLabel = (kind: string) =>
  EVENT_LABEL_MAP.find(([k]) => kind.includes(k))?.[1] ?? kind;

const EVENT_COLOR_MAP: Record<string, string> = {
  delivered: "text-success",
  bounced: "text-destructive",
  rejected: "text-destructive",
  complained: "text-destructive",
  opened: "text-blue-400",
  clicked: "text-blue-400",
  inbound: "text-purple-400",
};

export const kindColor = (kind: string) =>
  Object.entries(EVENT_COLOR_MAP).find(([k]) => kind.includes(k))?.[1] ??
  "text-muted-foreground";

const KIND_DOT_COLOR_MAP: Record<string, string> = {
  delivered: "bg-success",
  bounced: "bg-destructive",
  rejected: "bg-destructive",
  complained: "bg-destructive",
  opened: "bg-blue-400",
  clicked: "bg-blue-400",
  inbound: "bg-purple-400",
  send: "bg-primary",
};

export const kindDotColor = (kind: string) =>
  Object.entries(KIND_DOT_COLOR_MAP).find(([k]) => kind.includes(k))?.[1] ??
  "bg-muted-foreground/50";

// ── Bot detection ──

export const getBotDetection = (
  details: unknown,
): { isBot: boolean; reason: string } | null => {
  if (
    details &&
    typeof details === "object" &&
    "botDetection" in details &&
    details.botDetection &&
    typeof details.botDetection === "object" &&
    "isBot" in details.botDetection
  )
    return details.botDetection as { isBot: boolean; reason: string };
  return null;
};

// ── Fact extraction ──

export const getEventFacts = (
  kind: string,
  details: unknown,
): { label: string; value: string }[] => {
  if (!details || typeof details !== "object") return [];
  const d = details as Record<string, unknown>;
  const facts: { label: string; value: string }[] = [];
  const str = (v: unknown) =>
    typeof v === "string" ? v : v != null ? String(v) : null;
  const emailAddr = (v: unknown) => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object" && "email" in v) return str((v as { email: string }).email);
    return null;
  };

  const from = emailAddr(d.from);
  const to = emailAddr(d.to) ?? str(d.recipient);
  const subject = str(d.subject);

  if (kind.includes("send") || kind.includes("inbound")) {
    if (from) facts.push({ label: "from", value: from });
    if (to) facts.push({ label: "to", value: to });
    if (subject) facts.push({ label: "subject", value: subject });
  } else if (kind.includes("opened") || kind.includes("clicked")) {
    if (to) facts.push({ label: "to", value: to });
    if (kind.includes("clicked") && str(d.url))
      facts.push({ label: "url", value: str(d.url)! });
    const loc = d.location as Record<string, unknown> | undefined;
    if (loc) {
      const parts = [str(loc.city), str(loc.country)].filter(Boolean);
      if (parts.length) facts.push({ label: "location", value: parts.join(", ") });
    }
    if (str(d.os) || str(d.deviceType)) {
      const parts = [str(d.os), str(d.deviceType)].filter(Boolean);
      facts.push({ label: "device", value: parts.join(" / ") });
    }
  } else if (kind.includes("delivered")) {
    if (to) facts.push({ label: "to", value: to });
  } else if (kind.includes("bounced") || kind.includes("rejected")) {
    if (to) facts.push({ label: "to", value: to });
    if (str(d.reason)) facts.push({ label: "reason", value: str(d.reason)! });
    if (str(d.severity)) facts.push({ label: "severity", value: str(d.severity)! });
  } else if (kind.includes("complained")) {
    if (to) facts.push({ label: "to", value: to });
    if (str(d.feedbackType)) facts.push({ label: "type", value: str(d.feedbackType)! });
  } else if (kind.includes("webhook-request")) {
    if (str(d.method)) facts.push({ label: "method", value: str(d.method)! });
  } else if (kind.includes("webhook-response")) {
    if (str(d.status)) facts.push({ label: "status", value: str(d.status)! });
  }

  return facts;
};

// ── Filtering ──

const RECENCY_TO_MS: Record<Exclude<TraceFilters["recency"], "all">, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const ERROR_KIND_PATTERN =
  /(bounce|bounced|reject|rejected|complain|complained|error|fail|failed)/i;

export const matchesTraceQuery = (trace: SandboxTrace, query: string) => {
  if (!query) return true;
  const haystack = [
    trace.summary,
    trace.provider,
    trace.correlation.messageId,
    trace.correlation.providerId,
    trace.correlation.recipient,
    trace.correlation.subject,
    trace.correlation.status,
    ...trace.events.flatMap((e) => [e.kind, e.category, e.summary]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(query);
};

export const hasTraceError = (trace: SandboxTrace) =>
  trace.events.some((e) => ERROR_KIND_PATTERN.test(e.kind));

export const getRecencyCutoff = (recency: TraceFilters["recency"]) =>
  recency === "all" ? null : Date.now() - RECENCY_TO_MS[recency];

// ── Event icon helpers ──

// Re-exported as a map of kind-substring → icon name, since the actual React
// icon components live in the UI layer. Components import the icon map from
// @remixicon/react directly and use eventIconKey to pick.

const EVENT_ICON_KEY_MAP: [string, string][] = [
  ["inbound", "mail"],
  ["delivered", "mail-check"],
  ["opened", "mail-open"],
  ["clicked", "link"],
  ["bounced", "error-warning"],
  ["complained", "spam"],
  ["rejected", "close-circle"],
  ["outbound", "mail-send"],
  ["send", "send-plane"],
];

export const eventIconKey = (kind: string) =>
  EVENT_ICON_KEY_MAP.find(([k]) => kind.includes(k))?.[1] ?? "question";

/** Extract the "from" address from event details */
export const extractFrom = (details: unknown): string | null => {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  const raw = d.from;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "email" in raw) return String((raw as { email: string }).email);
  return null;
};

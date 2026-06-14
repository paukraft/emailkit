import type { SandboxEvent, SandboxTrace } from "./types"

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
  ["sync", "Sync"],
  ["webhook", "Webhook"],
  ["domain", "Domain"],
  ["mailbox", "Mailbox"],
]

export const eventLabel = (kind: string) =>
  EVENT_LABEL_MAP.find(([token]) => kind.toLowerCase().includes(token))?.[1] ?? kind

const COLOR_BY_KIND: [string, string][] = [
  ["delivered", "text-success"],
  ["opened", "text-blue-500"],
  ["clicked", "text-blue-500"],
  ["bounced", "text-destructive"],
  ["rejected", "text-destructive"],
  ["complained", "text-destructive"],
  ["inbound", "text-purple-500"],
  ["send", "text-foreground"],
]

export const kindColor = (kind: string) =>
  COLOR_BY_KIND.find(([token]) => kind.toLowerCase().includes(token))?.[1] ?? "text-muted-foreground"

const DOT_BY_KIND: [string, string][] = [
  ["delivered", "bg-success"],
  ["opened", "bg-blue-500"],
  ["clicked", "bg-blue-500"],
  ["bounced", "bg-destructive"],
  ["rejected", "bg-destructive"],
  ["complained", "bg-destructive"],
  ["inbound", "bg-purple-500"],
  ["send", "bg-primary"],
]

export const dotColor = (kind: string) =>
  DOT_BY_KIND.find(([token]) => kind.toLowerCase().includes(token))?.[1] ?? "bg-muted-foreground/40"

export const STATUS_STYLE: Record<string, string> = {
  delivered: "bg-success/15 text-success",
  opened: "bg-blue-500/15 text-blue-500",
  clicked: "bg-blue-500/15 text-blue-500",
  bounced: "bg-destructive/15 text-destructive",
  rejected: "bg-destructive/15 text-destructive",
  complained: "bg-orange-500/15 text-orange-500",
}

const ERROR_PATTERN = /(bounce|reject|complain|error|fail)/i
export const hasError = (trace: SandboxTrace) =>
  trace.events.some((event) => {
    if (ERROR_PATTERN.test(event.kind)) return true
    if (event.details && typeof event.details === "object") {
      const status = (event.details as { status?: unknown }).status
      return typeof status === "number" && status >= 400
    }
    return false
  })

const extractEmail = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return extractEmail(value[0])
  if (value && typeof value === "object" && "email" in value) {
    const email = (value as { email: unknown }).email
    return typeof email === "string" ? email : undefined
  }
}

export const extractFrom = (event: SandboxEvent | undefined): string | undefined => {
  if (!event?.details || typeof event.details !== "object") return undefined
  return extractEmail((event.details as Record<string, unknown>).from)
}

export const matchesQuery = (trace: SandboxTrace, query: string) => {
  if (!query) return true
  const haystack = [
    trace.summary,
    trace.driver,
    trace.correlation.messageId,
    trace.correlation.providerId,
    trace.correlation.recipient,
    trace.correlation.subject,
    trace.correlation.status,
    ...trace.events.flatMap((event) => [event.kind, event.category, event.summary]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
  return haystack.includes(query.toLowerCase())
}

export const formatOffset = (ms: number) => {
  if (ms < 1000) return `+${ms}ms`
  if (ms < 60_000) return `+${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
  const min = Math.floor(ms / 60_000)
  const sec = Math.floor((ms % 60_000) / 1000)
  return `+${min}m${sec ? ` ${sec}s` : ""}`
}

export const traceDuration = (trace: SandboxTrace) => {
  const start = new Date(trace.startedAt).getTime()
  const end = new Date(trace.updatedAt).getTime()
  return Math.max(0, end - start)
}

export const formatFacts = (event: SandboxEvent): { label: string; value: string }[] => {
  if (!event.details || typeof event.details !== "object") return []
  const details = event.details as Record<string, unknown>
  const facts: { label: string; value: string }[] = []
  const str = (value: unknown) => (typeof value === "string" ? value : value != null ? String(value) : null)

  const from = extractEmail(details.from)
  const to = extractEmail(details.to) ?? str(details.recipient)
  const subject = str(details.subject)
  const kind = event.kind.toLowerCase()

  if (kind.includes("send") || kind.includes("inbound") || kind.includes("outbound")) {
    if (from) facts.push({ label: "from", value: from })
    if (to) facts.push({ label: "to", value: to })
    if (subject) facts.push({ label: "subject", value: subject })
  } else if (kind.includes("opened") || kind.includes("clicked")) {
    if (to) facts.push({ label: "to", value: to })
    if (kind.includes("clicked") && str(details.url)) facts.push({ label: "url", value: str(details.url)! })
    const bot = details.botDetection
    if (bot && typeof bot === "object") {
      const isBot = (bot as { isBot?: unknown }).isBot
      const reason = str((bot as { reason?: unknown }).reason)
      facts.push({ label: "bot", value: isBot ? `yes${reason ? ` (${reason})` : ""}` : "no" })
    }
  } else if (kind.includes("delivered")) {
    if (to) facts.push({ label: "to", value: to })
  } else if (kind.includes("bounced") || kind.includes("rejected")) {
    if (to) facts.push({ label: "to", value: to })
    if (str(details.reason)) facts.push({ label: "reason", value: str(details.reason)! })
  } else if (kind.includes("complained")) {
    if (to) facts.push({ label: "to", value: to })
  } else if (kind.includes("domain")) {
    if (str(details.domain)) facts.push({ label: "domain", value: str(details.domain)! })
    if (str(details.status)) facts.push({ label: "status", value: str(details.status)! })
  } else if (kind.includes("mailbox")) {
    if (str(details.email)) facts.push({ label: "email", value: str(details.email)! })
    if (str(details.status)) facts.push({ label: "status", value: str(details.status)! })
  }

  return facts
}

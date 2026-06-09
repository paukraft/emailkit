import { randomUUID } from "crypto"
import { AsyncLocalStorage } from "async_hooks"
import type { EmailAddress, Domain, Mailbox } from "emailkit"

import { sandboxDrivers } from "./drivers"
import type {
  RememberedDomain,
  RememberedMailbox,
  SandboxEvent,
  SandboxSnapshot,
  SandboxTrace,
} from "./types"

type Store = {
  traces: SandboxTrace[]
  listeners: Set<() => void>
  domains: Map<string, RememberedDomain>
  mailboxes: Map<string, RememberedMailbox>
}

type SandboxTraceContext = {
  traceId: string
  driver: string
}

const MAX_TRACES = 100
const MAX_EVENTS_PER_TRACE = 40
const MAX_DEPTH = 5
const MAX_KEYS = 30
const MAX_STRING = 1200

declare global {
  var __emailkitSandboxStore: Store | undefined
}

const traceStorage = new AsyncLocalStorage<SandboxTraceContext>()

const getStore = (): Store => {
  const current = globalThis.__emailkitSandboxStore
  if (
    !current ||
    !(current.listeners instanceof Set) ||
    !(current.domains instanceof Map) ||
    !(current.mailboxes instanceof Map)
  ) {
    globalThis.__emailkitSandboxStore = {
      traces: Array.isArray(current?.traces) ? current.traces : [],
      listeners:
        current?.listeners instanceof Set ? current.listeners : new Set(),
      domains: current?.domains instanceof Map ? current.domains : new Map(),
      mailboxes:
        current?.mailboxes instanceof Map ? current.mailboxes : new Map(),
    }
  }
  return globalThis.__emailkitSandboxStore!
}

const isSensitiveKey = (key: string) =>
  /(authorization|api[-_]?key|secret|token|password|signature|auth)/i.test(key)

const sanitize = (value: unknown, depth = 0): unknown => {
  if (value == null) return value
  if (typeof value === "string") {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}...`
      : value
  }
  if (typeof value === "number" || typeof value === "boolean") return value
  if (value instanceof Date) return value.toISOString()
  if (value instanceof Uint8Array)
    return `[Uint8Array ${value.byteLength} bytes]`
  if (value instanceof Headers)
    return sanitize(Object.fromEntries(value), depth + 1)
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[Array ${value.length}]`
    return value.slice(0, 50).map((entry) => sanitize(entry, depth + 1))
  }
  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "[Object]"
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, MAX_KEYS)
        .map(([key, entry]) => [
          key,
          isSensitiveKey(key) ? "[REDACTED]" : sanitize(entry, depth + 1),
        ])
    )
  }
  return String(value)
}

const stringValue = (...values: unknown[]) => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim()
  }
}

const emailValue = (value: unknown): string | undefined => {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return emailValue(value[0])
  if (value && typeof value === "object" && "email" in value) {
    const email = (value as EmailAddress).email
    return typeof email === "string" ? email : undefined
  }
}

const getCorrelation = (details: unknown): SandboxTrace["correlation"] => {
  if (!details || typeof details !== "object" || Array.isArray(details))
    return {}
  const record = details as Record<string, unknown>
  return {
    eventId: stringValue(record.eventId, record["event-id"]),
    messageId: stringValue(
      record.messageId,
      record["message-id"],
      record.providerId,
      record.id
    ),
    providerId: stringValue(record.providerId, record.id, record.emailId),
    recipient:
      emailValue(record.to) ?? stringValue(record.recipient, record.email),
    subject: stringValue(record.subject),
    status: stringValue(record.status),
  }
}

const mergeCorrelation = (
  current: SandboxTrace["correlation"],
  next: SandboxTrace["correlation"]
) => ({
  eventId: current.eventId ?? next.eventId,
  messageId: current.messageId ?? next.messageId,
  providerId: current.providerId ?? next.providerId,
  recipient: current.recipient ?? next.recipient,
  subject: current.subject ?? next.subject,
  status: next.status ?? current.status,
})

const notify = () => {
  for (const listener of Array.from(getStore().listeners)) {
    try {
      listener()
    } catch {
      getStore().listeners.delete(listener)
    }
  }
}

export const subscribeToSandbox = (listener: () => void) => {
  getStore().listeners.add(listener)
  return () => getStore().listeners.delete(listener)
}

export const rememberDomain = (emailDriver: string, domain: Domain) => {
  getStore().domains.set(domain.domain.toLowerCase(), { emailDriver, domain })
}

export const rememberMailbox = (
  emailDriver: string,
  mailbox: Mailbox,
  auth?: unknown
) => {
  const existing = getStore().mailboxes.get(mailbox.email.toLowerCase())
  getStore().mailboxes.set(mailbox.email.toLowerCase(), {
    emailDriver,
    mailbox,
    auth: auth !== undefined ? auth : existing?.auth,
  })
}

export const findRememberedMailbox = (email: string) =>
  getStore().mailboxes.get(email.toLowerCase())

export const findRememberedDomain = (domain: string) =>
  getStore().domains.get(domain.toLowerCase())

export const runSandboxTrace = async <T>(
  driver: string,
  fn: () => Promise<T>
): Promise<T> => {
  return traceStorage.run({ traceId: randomUUID(), driver }, fn)
}

const shouldPromoteSummary = (event: SandboxEvent) =>
  event.category !== "webhook" || event.kind === "webhook.request"

export const recordSandboxEvent = (
  input: Omit<SandboxEvent, "id" | "timestamp">
) => {
  const store = getStore()
  const event: SandboxEvent = {
    ...input,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    details: sanitize(input.details),
  }
  const correlation = getCorrelation(event.details)
  const activeTrace = traceStorage.getStore()
  const existing = store.traces.find((trace) => {
    if (
      activeTrace?.driver === event.driver &&
      trace.id === activeTrace.traceId
    )
      return true
    if (trace.driver !== event.driver) return false
    return Boolean(
      (correlation.eventId &&
        trace.correlation.eventId === correlation.eventId) ||
        (correlation.messageId &&
          trace.correlation.messageId === correlation.messageId) ||
        (correlation.providerId &&
          trace.correlation.providerId === correlation.providerId)
    )
  })

  if (existing) {
    existing.events.unshift(event)
    existing.events = existing.events.slice(0, MAX_EVENTS_PER_TRACE)
    existing.updatedAt = event.timestamp
    if (shouldPromoteSummary(event)) existing.summary = event.summary
    existing.correlation = mergeCorrelation(existing.correlation, correlation)
  } else {
    store.traces.unshift({
      id:
        activeTrace?.driver === event.driver
          ? activeTrace.traceId
          : randomUUID(),
      driver: event.driver,
      summary: event.summary,
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
      events: [event],
      correlation,
    })
  }

  store.traces = store.traces
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    )
    .slice(0, MAX_TRACES)
  notify()
  return event
}

export const getSandboxSnapshot = (): SandboxSnapshot => {
  const traces = getStore().traces
  const events = traces.flatMap((trace) => trace.events)
  return {
    drivers: sandboxDrivers,
    traces,
    stats: {
      traces: traces.length,
      events: events.length,
      sends: events.filter((event) => event.category === "send").length,
      webhooks: events.filter((event) => event.category === "webhook").length,
      hooks: events.filter((event) => event.category === "hook").length,
    },
  }
}

export const clearSandbox = () => {
  getStore().traces = []
  notify()
}

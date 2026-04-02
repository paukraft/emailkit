import { randomUUID } from "crypto";
import { AsyncLocalStorage } from "async_hooks";

import type {
  SandboxEvent,
  SandboxProviderId,
  SandboxSnapshot,
  SandboxTrace,
  SandboxTraceCorrelation,
} from "./sandbox-types";

const MAX_TRACES = 100;
const MAX_EVENTS_PER_TRACE = 20;
const MAX_DEPTH = 4;
const MAX_KEYS = 20;
const MAX_ARRAY = 20;
const MAX_STRING = 500;

type Store = {
  traces: SandboxTrace[];
};

type SandboxTraceContext = {
  traceId: string;
  provider: SandboxProviderId;
};

declare global {
  var __emailkitSandboxStore: Store | undefined;
}

const traceStorage = new AsyncLocalStorage<SandboxTraceContext>();

const redactKey = (key: string): boolean =>
  /(authorization|api[-_]?key|secret|token|password|signature)/i.test(key);

const sanitize = (value: unknown, depth = 0): unknown => {
  if (value == null) return value;

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    if (typeof value === "string" && value.length > MAX_STRING) {
      return `${value.slice(0, MAX_STRING)}…`;
    }
    return value;
  }

  if (value instanceof Uint8Array) {
    return `[Uint8Array ${value.byteLength} bytes]`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Headers) {
    return sanitize(Object.fromEntries(value.entries()), depth + 1);
  }

  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return `[Array ${value.length}]`;
    return value.slice(0, MAX_ARRAY).map((entry) => sanitize(entry, depth + 1));
  }

  if (typeof value === "object") {
    if (depth >= MAX_DEPTH) return "[Object]";

    const entries = Object.entries(value as Record<string, unknown>).slice(
      0,
      MAX_KEYS,
    );
    return Object.fromEntries(
      entries.map(([key, entryValue]) => [
        key,
        redactKey(key) ? "[REDACTED]" : sanitize(entryValue, depth + 1),
      ]),
    );
  }

  return String(value);
};

const getStore = (): Store => {
  if (!globalThis.__emailkitSandboxStore) {
    globalThis.__emailkitSandboxStore = { traces: [] };
  }

  return globalThis.__emailkitSandboxStore;
};

const extractString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
};

const extractCorrelation = (details: unknown): SandboxTraceCorrelation => {
  if (!details || typeof details !== "object" || Array.isArray(details))
    return {};

  const record = details as Record<string, unknown>;
  return {
    eventId: extractString(record.eventId, record["event-id"]),
    messageId: extractString(
      record.messageId,
      record["message-id"],
      record.providerId,
      record.id,
    ),
    providerId: extractString(record.providerId, record.id, record.emailId),
    recipient: extractString(record.recipient, record.to, record.email),
    subject: extractString(record.subject),
    status: extractString(record.status),
  };
};

const mergeCorrelation = (
  current: SandboxTraceCorrelation,
  next: SandboxTraceCorrelation,
): SandboxTraceCorrelation => ({
  eventId: current.eventId ?? next.eventId,
  messageId: current.messageId ?? next.messageId,
  providerId: current.providerId ?? next.providerId,
  recipient: current.recipient ?? next.recipient,
  subject: current.subject ?? next.subject,
  status: current.status ?? next.status,
});

const shouldPromoteSummary = (event: SandboxEvent): boolean =>
  event.category !== "webhook" || event.kind === "webhook-request";

const createTrace = ({
  id,
  provider,
  summary,
  correlation,
  event,
}: {
  id: string;
  provider: SandboxProviderId;
  summary: string;
  correlation: SandboxTraceCorrelation;
  event: SandboxEvent;
}): SandboxTrace => ({
  id,
  provider,
  summary,
  startedAt: event.timestamp,
  updatedAt: event.timestamp,
  correlation,
  events: [event],
});

const getTraceLabel = (trace: SandboxTrace): string =>
  trace.correlation.subject ||
  trace.correlation.messageId ||
  trace.correlation.providerId ||
  trace.summary;

const getLatestEvent = (trace: SandboxTrace): SandboxEvent | undefined =>
  trace.events[0];

const sortTraces = (traces: SandboxTrace[]): SandboxTrace[] =>
  [...traces].sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );

const findTraceByCorrelation = (
  traces: SandboxTrace[],
  provider: SandboxProviderId,
  correlation: SandboxTraceCorrelation,
): SandboxTrace | undefined =>
  traces.find((trace) => {
    if (trace.provider !== provider) return false;
    if (
      correlation.eventId &&
      trace.correlation.eventId === correlation.eventId
    )
      return true;
    if (
      correlation.messageId &&
      trace.correlation.messageId === correlation.messageId
    )
      return true;
    if (
      correlation.providerId &&
      trace.correlation.providerId === correlation.providerId
    )
      return true;
    return false;
  });

const upsertTrace = ({
  traceId,
  provider,
  event,
  correlation,
}: {
  traceId?: string;
  provider: SandboxProviderId;
  event: SandboxEvent;
  correlation: SandboxTraceCorrelation;
}): SandboxTrace => {
  const store = getStore();
  const trace =
    (traceId
      ? store.traces.find((candidate) => candidate.id === traceId)
      : undefined) ??
    findTraceByCorrelation(store.traces, provider, correlation);

  if (!trace) {
    const nextTrace = createTrace({
      id: traceId ?? randomUUID(),
      provider,
      summary: event.summary,
      correlation,
      event,
    });
    store.traces = sortTraces([nextTrace, ...store.traces]).slice(
      0,
      MAX_TRACES,
    );
    return nextTrace;
  }

  trace.updatedAt = event.timestamp;
  trace.correlation = mergeCorrelation(trace.correlation, correlation);
  trace.events.unshift(event);
  trace.events = trace.events.slice(0, MAX_EVENTS_PER_TRACE);
  if (shouldPromoteSummary(event)) {
    trace.summary = event.summary;
  }
  store.traces = sortTraces(store.traces).slice(0, MAX_TRACES);
  return trace;
};

export const runSandboxTrace = async <T>(
  provider: SandboxProviderId,
  fn: () => Promise<T>,
): Promise<T> => {
  const traceId = randomUUID();
  return traceStorage.run({ traceId, provider }, fn);
};

export const recordSandboxEvent = ({
  provider,
  category,
  kind,
  summary,
  details,
}: {
  provider: SandboxProviderId;
  category: SandboxEvent["category"];
  kind: string;
  summary: string;
  details?: unknown;
}): SandboxEvent => {
  const event: SandboxEvent = {
    id: randomUUID(),
    provider,
    category,
    kind,
    summary,
    timestamp: new Date().toISOString(),
    details: sanitize(details),
  };

  const correlation = extractCorrelation(event.details);
  const activeTrace = traceStorage.getStore();
  upsertTrace({
    traceId:
      activeTrace?.provider === provider ? activeTrace.traceId : undefined,
    provider,
    event,
    correlation,
  });
  return event;
};

export const clearSandboxEvents = (): void => {
  getStore().traces = [];
};

export const getSandboxTraces = (): SandboxTrace[] => getStore().traces;

export const buildSandboxSnapshot = (
  providers: SandboxSnapshot["providers"],
): SandboxSnapshot => {
  const traces = getSandboxTraces();
  const events = traces.flatMap((trace) => trace.events);

  return {
    providers,
    traces: traces.map((trace) => ({
      ...trace,
      events: [...trace.events],
    })),
    stats: {
      traces: traces.length,
      events: events.length,
      send: events.filter((event) => event.category === "send").length,
      webhook: events.filter((event) => event.category === "webhook").length,
      hook: events.filter((event) => event.category === "hook").length,
    },
  };
};

"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  RiSendPlaneFill,
  RiDeleteBinLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiMailLine,
  RiMailSendLine,
  RiMailCheckLine,
  RiMailOpenLine,
  RiLinkM,
  RiErrorWarningLine,
  RiSpamLine,
  RiCloseCircleLine,
  RiQuestionLine,
  RiSettings3Line,
  RiSearchLine,
  RiCloseLine,
  RiRobotLine,
} from "@remixicon/react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { Toggle } from "@/components/ui/toggle";
import { JsonViewer } from "./json-viewer";
import { RichEditor } from "./rich-editor";
import type {
  SandboxProviderId,
  SandboxProviderCapabilities,
  SandboxSnapshot,
  SandboxTrace,
} from "@/lib/sandbox-types";

// ── Draft state ──

type Draft = {
  fromEmail: string;
  fromName: string;
  toEmail: string;
  ccEmail: string;
  bccEmail: string;
  subject: string;
  text: string;
  html: string;
  replyToEmail: string;
  inReplyToMessageId: string;
  trackOpens: boolean;
  trackClicks: boolean;
  sendAt: string;
  unsubscribeGlobal: boolean;
  tags: string;
  metadata: string;
  headers: string;
  templateId: string;
  templateData: string;
  idempotencyKey: string;
  tenantId: string;
};

type TraceFilters = {
  query: string;
  category: "all" | SandboxTrace["events"][number]["category"];
  kind: string;
  status: string;
  recency: "all" | "15m" | "1h" | "24h" | "7d";
  errorsOnly: boolean;
};

const STORAGE_KEY = "emailkit-sandbox-session";

const defaultDraft = (
  snapshot: SandboxSnapshot,
  provider: SandboxProviderId,
): Draft => {
  const info = snapshot.providers.find((p) => p.id === provider);
  return {
    fromEmail: info?.defaultFromEmail ?? "",
    fromName: "",
    toEmail: info?.defaultToEmail ?? "",
    ccEmail: "",
    bccEmail: "",
    subject: `EmailKit sandbox test via ${info?.label ?? provider}`,
    text: "Provider smoke test from the EmailKit sandbox.",
    html: "<p>Provider smoke test from the <strong>EmailKit sandbox</strong>.</p>",
    replyToEmail: "",
    inReplyToMessageId: "",
    trackOpens: true,
    trackClicks: true,
    sendAt: "",
    unsubscribeGlobal: false,
    tags: "",
    metadata: "",
    headers: "",
    templateId: "",
    templateData: "",
    idempotencyKey: "",
    tenantId: "",
  };
};

// ── Event display helpers ──

const EVENT_ICON_MAP: Record<string, typeof RiMailLine> = {
  inbound: RiMailLine,
  delivered: RiMailCheckLine,
  opened: RiMailOpenLine,
  clicked: RiLinkM,
  bounced: RiErrorWarningLine,
  complained: RiSpamLine,
  rejected: RiCloseCircleLine,
  outbound: RiMailSendLine,
  send: RiSendPlaneFill,
};

// Order matters — more specific kinds must come before broader ones
// (e.g. "clicked" before "outbound", since "outbound-email-clicked" contains both)
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

const eventLabel = (kind: string) =>
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

const getBotDetection = (
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

/** Pull the most useful facts from event.details based on kind */
const getEventFacts = (
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

  // from / to / recipient / subject (common across many events)
  const from = emailAddr(d.from);
  const to = emailAddr(d.to) ?? str(d.recipient);
  const subject = str(d.subject);

  if (kind.includes("send")) {
    if (from) facts.push({ label: "from", value: from });
    if (to) facts.push({ label: "to", value: to });
    if (subject) facts.push({ label: "subject", value: subject });
  } else if (kind.includes("inbound")) {
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
    if (str(d.severity))
      facts.push({ label: "severity", value: str(d.severity)! });
  } else if (kind.includes("complained")) {
    if (to) facts.push({ label: "to", value: to });
    if (str(d.feedbackType))
      facts.push({ label: "type", value: str(d.feedbackType)! });
  } else if (kind.includes("webhook-request")) {
    if (str(d.method)) facts.push({ label: "method", value: str(d.method)! });
  } else if (kind.includes("webhook-response")) {
    if (str(d.status)) facts.push({ label: "status", value: str(d.status)! });
  }

  return facts;
};

const eventIcon = (kind: string) => {
  const Icon =
    Object.entries(EVENT_ICON_MAP).find(([k]) => kind.includes(k))?.[1] ??
    RiQuestionLine;
  return <Icon className="size-3.5" />;
};

const kindColor = (kind: string) =>
  Object.entries(EVENT_COLOR_MAP).find(([k]) => kind.includes(k))?.[1] ??
  "text-muted-foreground";

const DEFAULT_TRACE_FILTERS: TraceFilters = {
  query: "",
  category: "all",
  kind: "all",
  status: "all",
  recency: "all",
  errorsOnly: false,
};

const RECENCY_TO_MS: Record<Exclude<TraceFilters["recency"], "all">, number> = {
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

const ERROR_KIND_PATTERN =
  /(bounce|bounced|reject|rejected|complain|complained|error|fail|failed)/i;

const matchesTraceQuery = (trace: SandboxTrace, query: string) => {
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

const hasTraceError = (trace: SandboxTrace) =>
  trace.events.some((e) => ERROR_KIND_PATTERN.test(e.kind));

const getRecencyCutoff = (recency: TraceFilters["recency"]) =>
  recency === "all" ? null : Date.now() - RECENCY_TO_MS[recency];

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

const kindDotColor = (kind: string) =>
  Object.entries(KIND_DOT_COLOR_MAP).find(([k]) => kind.includes(k))?.[1] ??
  "bg-muted-foreground/50";

// ── Main component ──

export function SandboxClient({
  initialSnapshot,
}: {
  initialSnapshot: SandboxSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedProvider, setSelectedProvider] =
    useState<SandboxProviderId>("mailgun");
  const [drafts, setDrafts] = useState<Record<SandboxProviderId, Draft>>(
    () => ({
      mailgun: defaultDraft(initialSnapshot, "mailgun"),
      resend: defaultDraft(initialSnapshot, "resend"),
      aiinbx: defaultDraft(initialSnapshot, "aiinbx"),
    }),
  );
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(
    initialSnapshot.traces[0]?.id ?? null,
  );
  const [isSending, setIsSending] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [composeOpen, setComposeOpen] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [composeMode, setComposeMode] = useState<"visual" | "html" | "text">(
    "visual",
  );
  const [traceFilters, setTraceFilters] = useState<TraceFilters>(
    DEFAULT_TRACE_FILTERS,
  );

  // Restore session
  useEffect(() => {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        selectedProvider?: SandboxProviderId;
        drafts?: Partial<Record<SandboxProviderId, Draft>>;
      };
      if (parsed.selectedProvider && parsed.selectedProvider in drafts)
        setSelectedProvider(parsed.selectedProvider);
      if (parsed.drafts)
        setDrafts((c) => ({
          mailgun: { ...c.mailgun, ...parsed.drafts?.mailgun },
          resend: { ...c.resend, ...parsed.drafts?.resend },
          aiinbx: { ...c.aiinbx, ...parsed.drafts?.aiinbx },
        }));
    } catch {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  // Persist session
  useEffect(() => {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ selectedProvider, drafts }),
    );
  }, [drafts, selectedProvider]);

  // Poll for events
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const res = await fetch("/api/sandbox/state", { cache: "no-store" });
      if (res.ok && !cancelled)
        setSnapshot((await res.json()) as SandboxSnapshot);
    };
    load();
    const interval = window.setInterval(load, 2500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const currentProvider = useMemo(
    () => snapshot.providers.find((p) => p.id === selectedProvider)!,
    [selectedProvider, snapshot.providers],
  );

  const selectedTrace = useMemo(
    () => snapshot.traces.find((t) => t.id === selectedTraceId) ?? null,
    [selectedTraceId, snapshot.traces],
  );

  const deferredTraceQuery = useDeferredValue(traceFilters.query);

  const providerTraces = useMemo(
    () => snapshot.traces.filter((t) => t.provider === selectedProvider),
    [selectedProvider, snapshot.traces],
  );

  const traceFilterOptions = useMemo(() => {
    const eventKinds = new Set<string>();
    const statuses = new Set<string>();
    providerTraces.forEach((t) => {
      if (t.correlation.status) statuses.add(t.correlation.status);
      t.events.forEach((e) => eventKinds.add(e.kind));
    });
    return {
      eventKinds: Array.from(eventKinds).sort(),
      statuses: Array.from(statuses).sort(),
    };
  }, [providerTraces]);

  const filteredTraces = useMemo(() => {
    const query = deferredTraceQuery.trim().toLowerCase();
    const recencyCutoff = getRecencyCutoff(traceFilters.recency);
    return providerTraces.filter((trace) => {
      if (
        traceFilters.category !== "all" &&
        !trace.events.some((e) => e.category === traceFilters.category)
      )
        return false;
      if (
        traceFilters.kind !== "all" &&
        !trace.events.some((e) => e.kind === traceFilters.kind)
      )
        return false;
      if (
        traceFilters.status !== "all" &&
        trace.correlation.status !== traceFilters.status
      )
        return false;
      if (traceFilters.errorsOnly && !hasTraceError(trace)) return false;
      if (
        recencyCutoff !== null &&
        new Date(trace.updatedAt).getTime() < recencyCutoff
      )
        return false;
      return matchesTraceQuery(trace, query);
    });
  }, [deferredTraceQuery, providerTraces, traceFilters]);

  // Auto-select first visible trace
  useEffect(() => {
    if (!filteredTraces.length) return setSelectedTraceId(null);
    setSelectedTraceId((c) =>
      c && filteredTraces.some((t) => t.id === c)
        ? c
        : (filteredTraces[0]?.id ?? null),
    );
  }, [filteredTraces]);

  const draft = drafts[selectedProvider];
  const caps = currentProvider.capabilities;

  const setTraceFilter = <K extends keyof TraceFilters>(
    key: K,
    value: TraceFilters[K],
  ) => setTraceFilters((c) => ({ ...c, [key]: value }));

  const hasActiveTraceFilters = useMemo(
    () =>
      traceFilters.query.trim().length > 0 ||
      traceFilters.category !== "all" ||
      traceFilters.kind !== "all" ||
      traceFilters.status !== "all" ||
      traceFilters.recency !== "all" ||
      traceFilters.errorsOnly,
    [traceFilters],
  );

  const updateDraft = (field: keyof Draft, value: Draft[keyof Draft]) =>
    setDrafts((c) => ({
      ...c,
      [selectedProvider]: { ...c[selectedProvider], [field]: value },
    }));

  const parseKV = (raw: string): Record<string, string> | undefined => {
    if (!raw.trim()) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  };

  const send = async () => {
    setIsSending(true);
    setFeedback("");
    try {
      const body: Record<string, unknown> = {
        provider: selectedProvider,
        fromEmail: draft.fromEmail,
        fromName: draft.fromName || undefined,
        toEmail: draft.toEmail,
        ccEmail: draft.ccEmail || undefined,
        bccEmail: draft.bccEmail || undefined,
        subject: draft.subject,
        text: draft.text || undefined,
        html: draft.html || undefined,
        replyToEmail: draft.replyToEmail || undefined,
        inReplyToMessageId: draft.inReplyToMessageId || undefined,
      };
      if (caps.trackOpens || caps.trackClicks) {
        body.trackOpens = draft.trackOpens;
        body.trackClicks = draft.trackClicks;
      }
      if (caps.scheduling && draft.sendAt) body.sendAt = draft.sendAt;
      if (caps.unsubscribe && draft.unsubscribeGlobal)
        body.unsubscribeGlobal = true;
      if (draft.tags) {
        const tags = draft.tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        if (tags.length) body.tags = tags;
      }
      if (draft.metadata) body.metadata = parseKV(draft.metadata);
      if (draft.headers) body.headers = parseKV(draft.headers);
      if (caps.templates && draft.templateId) {
        body.templateId = draft.templateId;
        if (draft.templateData) {
          try {
            body.templateData = JSON.parse(draft.templateData);
          } catch {}
        }
      }
      if (caps.sendIdempotency && draft.idempotencyKey)
        body.idempotencyKey = draft.idempotencyKey;
      if (caps.tenantRouting && draft.tenantId) body.tenantId = draft.tenantId;

      const res = await fetch("/api/sandbox/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok)
        throw new Error(payload.error || "Send failed");
      setSnapshot(payload.snapshot as SandboxSnapshot);
      setFeedback(`Sent via ${currentProvider.label}`);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : "Send failed");
    } finally {
      setIsSending(false);
    }
  };

  const clearEvents = async () => {
    const res = await fetch("/api/sandbox/state", { method: "DELETE" });
    if (!res.ok) return;
    setSnapshot((await res.json()) as SandboxSnapshot);
    setFeedback("");
  };

  return (
    <div className="flex h-screen flex-col">
      {/* ── Toolbar ── */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-3">
        <span className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
          EmailKit Sandbox
        </span>

        <ProviderTabs
          providers={snapshot.providers}
          selected={selectedProvider}
          onSelect={setSelectedProvider}
        />

        <div className="flex-1" />

        <div className="flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
          <span>{snapshot.stats.traces} traces</span>
          <span className="text-border">·</span>
          <span>{snapshot.stats.events} events</span>
          <span className="text-border">·</span>
          <span>{snapshot.stats.send} sent</span>
        </div>

        <Button variant="ghost" size="xs" onClick={clearEvents}>
          <RiDeleteBinLine className="size-3" />
          Clear
        </Button>
      </header>

      {/* ── Main area ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── Left: Compose ── */}
        <aside className="flex w-[380px] shrink-0 flex-col border-r">
          <button
            onClick={() => setComposeOpen(!composeOpen)}
            className="flex h-9 items-center gap-1.5 border-b px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            {composeOpen ? (
              <RiArrowDownSLine className="size-3.5" />
            ) : (
              <RiArrowRightSLine className="size-3.5" />
            )}
            Compose
            {!currentProvider.ready && (
              <span className="ml-auto rounded bg-destructive/20 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
                missing env
              </span>
            )}
          </button>

          {composeOpen && (
            <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3 scrollbar-thin">
              <div className="grid grid-cols-2 gap-2">
                <FormField label="From">
                  <Input
                    value={draft.fromEmail}
                    onChange={(e) => updateDraft("fromEmail", e.target.value)}
                    placeholder="sender@example.com"
                    className="h-7 text-xs"
                  />
                </FormField>
                <FormField label="Name">
                  <Input
                    value={draft.fromName}
                    onChange={(e) => updateDraft("fromName", e.target.value)}
                    placeholder="(optional)"
                    className="h-7 text-xs"
                  />
                </FormField>
              </div>
              <FormField label="To">
                <Input
                  value={draft.toEmail}
                  onChange={(e) => updateDraft("toEmail", e.target.value)}
                  placeholder="recipient@example.com"
                  className="h-7 text-xs"
                />
              </FormField>
              <div className="grid grid-cols-2 gap-2">
                <FormField label="CC">
                  <Input
                    value={draft.ccEmail}
                    onChange={(e) => updateDraft("ccEmail", e.target.value)}
                    placeholder="(optional)"
                    className="h-7 text-xs"
                  />
                </FormField>
                <FormField label="BCC">
                  <Input
                    value={draft.bccEmail}
                    onChange={(e) => updateDraft("bccEmail", e.target.value)}
                    placeholder="(optional)"
                    className="h-7 text-xs"
                  />
                </FormField>
              </div>
              <FormField label="Subject">
                <Input
                  value={draft.subject}
                  onChange={(e) => updateDraft("subject", e.target.value)}
                  className="h-7 text-xs"
                />
              </FormField>

              {/* Body mode switcher */}
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Body
                  </Label>
                  <div className="flex items-center rounded-md bg-secondary p-0.5">
                    {(["visual", "html", "text"] as const).map((mode) => (
                      <button
                        key={mode}
                        onClick={() => setComposeMode(mode)}
                        className={cn(
                          "rounded-[5px] px-2 py-0.5 text-[10px] font-medium capitalize transition-colors",
                          composeMode === mode
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                </div>

                {composeMode === "visual" && (
                  <RichEditor
                    value={draft.html}
                    onChange={(v) => updateDraft("html", v)}
                  />
                )}
                {composeMode === "html" && (
                  <Textarea
                    value={draft.html}
                    onChange={(e) => updateDraft("html", e.target.value)}
                    rows={6}
                    placeholder="<p>Your HTML here</p>"
                    className="font-mono text-xs"
                  />
                )}
                {composeMode === "text" && (
                  <Textarea
                    value={draft.text}
                    onChange={(e) => updateDraft("text", e.target.value)}
                    rows={6}
                    placeholder="Plain text fallback"
                    className="text-xs"
                  />
                )}
              </div>

              {/* ── Options ── */}
              <button
                onClick={() => setOptionsOpen(!optionsOpen)}
                className="flex items-center gap-1.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
              >
                <RiSettings3Line className="size-3" />
                Options
                {optionsOpen ? (
                  <RiArrowDownSLine className="size-3" />
                ) : (
                  <RiArrowRightSLine className="size-3" />
                )}
              </button>

              {optionsOpen && (
                <div className="flex flex-col gap-3 rounded-lg border p-3">
                  <FormField label="Reply-To">
                    <Input
                      value={draft.replyToEmail}
                      onChange={(e) =>
                        updateDraft("replyToEmail", e.target.value)
                      }
                      placeholder="reply@example.com"
                      className="h-7 text-xs"
                    />
                  </FormField>
                  <FormField label="In-Reply-To (Message-ID)">
                    <Input
                      value={draft.inReplyToMessageId}
                      onChange={(e) =>
                        updateDraft("inReplyToMessageId", e.target.value)
                      }
                      placeholder="<msg-id@provider>"
                      className="h-7 text-xs"
                    />
                  </FormField>

                  <CapabilitySection
                    caps={caps}
                    features={["trackOpens", "trackClicks"]}
                  >
                    <div className="flex items-center gap-4">
                      <CheckboxField
                        label="Track opens"
                        checked={draft.trackOpens}
                        onCheckedChange={(v) => updateDraft("trackOpens", !!v)}
                        disabled={!caps.trackOpens}
                      />
                      <CheckboxField
                        label="Track clicks"
                        checked={draft.trackClicks}
                        onCheckedChange={(v) => updateDraft("trackClicks", !!v)}
                        disabled={!caps.trackClicks}
                      />
                    </div>
                  </CapabilitySection>

                  <CapabilitySection caps={caps} features={["scheduling"]}>
                    <FormField label="Schedule (ISO)">
                      <Input
                        value={draft.sendAt}
                        onChange={(e) => updateDraft("sendAt", e.target.value)}
                        placeholder="2026-04-03T10:00:00Z"
                        className="h-7 text-xs"
                      />
                    </FormField>
                  </CapabilitySection>

                  <CapabilitySection caps={caps} features={["unsubscribe"]}>
                    <CheckboxField
                      label="Global unsubscribe header"
                      checked={draft.unsubscribeGlobal}
                      onCheckedChange={(v) =>
                        updateDraft("unsubscribeGlobal", !!v)
                      }
                    />
                  </CapabilitySection>

                  <CapabilitySection caps={caps} features={["templates"]}>
                    <FormField label="Template ID">
                      <Input
                        value={draft.templateId}
                        onChange={(e) =>
                          updateDraft("templateId", e.target.value)
                        }
                        className="h-7 text-xs"
                      />
                    </FormField>
                    <FormField label="Template data (JSON)">
                      <Textarea
                        value={draft.templateData}
                        onChange={(e) =>
                          updateDraft("templateData", e.target.value)
                        }
                        rows={2}
                        className="font-mono text-xs"
                      />
                    </FormField>
                  </CapabilitySection>

                  <CapabilitySection caps={caps} features={["sendIdempotency"]}>
                    <FormField label="Idempotency key">
                      <Input
                        value={draft.idempotencyKey}
                        onChange={(e) =>
                          updateDraft("idempotencyKey", e.target.value)
                        }
                        className="h-7 text-xs"
                      />
                    </FormField>
                  </CapabilitySection>

                  <CapabilitySection caps={caps} features={["tenantRouting"]}>
                    <FormField label="Tenant ID">
                      <Input
                        value={draft.tenantId}
                        onChange={(e) =>
                          updateDraft("tenantId", e.target.value)
                        }
                        className="h-7 text-xs"
                      />
                    </FormField>
                  </CapabilitySection>

                  <Separator />

                  <FormField label="Tags (comma-separated)">
                    <Input
                      value={draft.tags}
                      onChange={(e) => updateDraft("tags", e.target.value)}
                      placeholder="test, sandbox"
                      className="h-7 text-xs"
                    />
                  </FormField>
                  <FormField label="Metadata (JSON)">
                    <Textarea
                      value={draft.metadata}
                      onChange={(e) => updateDraft("metadata", e.target.value)}
                      rows={2}
                      placeholder='{"key": "value"}'
                      className="font-mono text-xs"
                    />
                  </FormField>
                  <FormField label="Custom headers (JSON)">
                    <Textarea
                      value={draft.headers}
                      onChange={(e) => updateDraft("headers", e.target.value)}
                      rows={2}
                      placeholder='{"X-Custom": "value"}'
                      className="font-mono text-xs"
                    />
                  </FormField>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={send}
                  disabled={isSending || !currentProvider.ready}
                >
                  <RiSendPlaneFill className="size-3" />
                  {isSending ? "Sending…" : "Send"}
                </Button>
                {feedback && (
                  <span
                    className={cn(
                      "font-mono text-xs",
                      feedback.startsWith("Sent")
                        ? "text-success"
                        : "text-destructive",
                    )}
                  >
                    {feedback}
                  </span>
                )}
              </div>
            </div>
          )}

          {/* ── Provider info ── */}
          <ProviderStatus provider={currentProvider} />
        </aside>

        {/* ── Center: Trace list ── */}
        <div className="flex flex-1 flex-col min-w-0">
          {/* Search + filters */}
          <div className="flex flex-col border-b">
            <div className="flex h-9 items-center gap-2 px-3">
              <RiSearchLine className="size-3 shrink-0 text-muted-foreground/50" />
              <input
                value={traceFilters.query}
                onChange={(e) => setTraceFilter("query", e.target.value)}
                placeholder="Search traces…"
                className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
              />
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {filteredTraces.length}
                {hasActiveTraceFilters && (
                  <span className="text-muted-foreground/40">/{providerTraces.length}</span>
                )}
              </span>
              {hasActiveTraceFilters && (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setTraceFilters(DEFAULT_TRACE_FILTERS)}
                >
                  <RiCloseLine className="size-3.5" />
                </Button>
              )}
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto px-3 pb-2 scrollbar-thin">
              <FilterSelect
                value={traceFilters.category}
                onValueChange={(v) => setTraceFilter("category", v as TraceFilters["category"])}
                options={[
                  { value: "all", label: "Category" },
                  { value: "send", label: "Send" },
                  { value: "hook", label: "Hook" },
                  { value: "webhook", label: "Webhook" },
                  { value: "system", label: "System" },
                ]}
              />
              {traceFilterOptions.eventKinds.length > 0 && (
                <FilterSelect
                  value={traceFilters.kind}
                  onValueChange={(v) => setTraceFilter("kind", v)}
                  options={[
                    { value: "all", label: "Kind" },
                    ...traceFilterOptions.eventKinds.map((k) => ({ value: k, label: k })),
                  ]}
                />
              )}
              {traceFilterOptions.statuses.length > 0 && (
                <FilterSelect
                  value={traceFilters.status}
                  onValueChange={(v) => setTraceFilter("status", v)}
                  options={[
                    { value: "all", label: "Status" },
                    ...traceFilterOptions.statuses.map((s) => ({ value: s, label: s })),
                  ]}
                />
              )}
              <FilterSelect
                value={traceFilters.recency}
                onValueChange={(v) => setTraceFilter("recency", v as TraceFilters["recency"])}
                options={[
                  { value: "all", label: "Time" },
                  { value: "15m", label: "15m" },
                  { value: "1h", label: "1h" },
                  { value: "24h", label: "24h" },
                  { value: "7d", label: "7d" },
                ]}
              />

              <Toggle
                size="sm"
                pressed={traceFilters.errorsOnly}
                onPressedChange={(v) => setTraceFilter("errorsOnly", v)}
                className={cn(
                  "h-5 rounded-full px-2 text-[10px]",
                  traceFilters.errorsOnly && "bg-destructive/10 text-destructive hover:bg-destructive/15 hover:text-destructive",
                )}
              >
                Errors
              </Toggle>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto scrollbar-thin">
            {providerTraces.length === 0 ? (
              <div className="flex h-full items-center justify-center p-6">
                <p className="max-w-[240px] text-center text-xs leading-relaxed text-muted-foreground">
                  No traces yet. Send a test email or point a provider webhook
                  at the sandbox routes.
                </p>
              </div>
            ) : filteredTraces.length === 0 ? (
              <div className="flex h-full items-center justify-center p-6">
                <p className="max-w-[240px] text-center text-xs leading-relaxed text-muted-foreground">
                  No traces match filters.
                </p>
              </div>
            ) : (
              <div className="flex flex-col">
                {filteredTraces.map((trace) => (
                  <TraceRow
                    key={trace.id}
                    trace={trace}
                    selected={selectedTraceId === trace.id}
                    onSelect={() => setSelectedTraceId(trace.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* ── Right: Inspector ── */}
        <div className="flex w-[480px] shrink-0 flex-col border-l">
          <div className="flex h-9 items-center border-b px-3">
            <span className="text-xs font-medium text-muted-foreground">
              Inspector
            </span>
          </div>

          <div className="flex-1 overflow-auto scrollbar-thin">
            {selectedTrace ? (
              <TraceInspector trace={selectedTrace} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-xs text-muted-foreground">
                  Select a trace to inspect
                </p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ──

function ProviderTabs({
  providers,
  selected,
  onSelect,
}: {
  providers: SandboxSnapshot["providers"];
  selected: SandboxProviderId;
  onSelect: (id: SandboxProviderId) => void;
}) {
  return (
    <div className="ml-2 flex items-center rounded-md bg-secondary p-0.5">
      {providers.map((p) => (
        <button
          key={p.id}
          onClick={() => onSelect(p.id)}
          className={cn(
            "flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
            selected === p.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              p.ready ? "bg-success" : "bg-destructive",
            )}
          />
          {p.label}
        </button>
      ))}
    </div>
  );
}

function FilterSelect({
  value,
  onValueChange,
  options,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const isActive = value !== options[0]?.value;
  return (
    <select
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      className={cn(
        "shrink-0 cursor-pointer appearance-none rounded-full border-none bg-transparent px-2 py-0.5 text-[10px] font-medium outline-none transition-colors",
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

function ProviderStatus({
  provider,
}: {
  provider: SandboxSnapshot["providers"][number];
}) {
  return (
    <div className="border-t px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            provider.ready ? "bg-success" : "bg-destructive",
          )}
        />
        <span className="text-xs font-medium">{provider.label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {provider.ready ? "ready" : "not configured"}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {provider.requiredEnv.map((key) => (
          <span
            key={key}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              provider.missingRequiredEnv.includes(key)
                ? "bg-destructive/15 text-destructive"
                : "bg-success/15 text-success",
            )}
          >
            {key}
          </span>
        ))}
        {provider.missingOptionalEnv.map((key) => (
          <span
            key={key}
            className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            {key}
          </span>
        ))}
      </div>
      <code className="mt-1.5 block truncate font-mono text-[10px] text-muted-foreground">
        {typeof window === "undefined"
          ? provider.webhookPath
          : `${window.location.origin}${provider.webhookPath}`}
      </code>
    </div>
  );
}

function TraceRow({
  trace,
  selected,
  onSelect,
}: {
  trace: SandboxTrace;
  selected: boolean;
  onSelect: () => void;
}) {
  const leadEvent =
    trace.events.find(
      (e) => e.category === "hook" || e.category === "send",
    ) ?? trace.events[0];
  const leadKind = leadEvent?.kind ?? "";
  const timeline = trace.events.slice(0, 6);
  const hasBot = trace.events.some(
    (e) => getBotDetection(e.details)?.isBot,
  );
  const { recipient, subject, status } = trace.correlation;

  // Extract from address from lead event details
  const leadDetails = leadEvent?.details as Record<string, unknown> | undefined;
  const fromRaw = leadDetails?.from;
  const from =
    typeof fromRaw === "string"
      ? fromRaw
      : fromRaw && typeof fromRaw === "object" && "email" in fromRaw
        ? String((fromRaw as { email: string }).email)
        : null;

  // Extract clicked URL from click events
  const clickEvent = trace.events.find((e) => e.kind.includes("clicked"));
  const clickUrl =
    clickEvent?.details &&
    typeof clickEvent.details === "object" &&
    "url" in clickEvent.details &&
    typeof (clickEvent.details as Record<string, unknown>).url === "string"
      ? ((clickEvent.details as Record<string, unknown>).url as string)
      : null;

  return (
    <button
      onClick={onSelect}
      className={cn(
        "flex items-start gap-2.5 border-b px-3 py-2.5 text-left transition-colors",
        selected ? "bg-secondary" : "hover:bg-secondary/50",
      )}
    >
      <div className="min-w-0 flex-1">
        {/* Event type + From → To */}
        <div className="flex items-center gap-1.5 text-xs">
          <span className={cn("inline-flex shrink-0 items-center gap-0.5 font-medium", kindColor(leadKind))}>
            {eventIcon(leadKind)}
            <span>{eventLabel(leadKind)}</span>
          </span>
          {(from || recipient) && (
            <span className="flex min-w-0 items-center gap-1 truncate font-mono text-muted-foreground">
              {from && <span className="truncate">{from}</span>}
              {from && recipient && <span className="shrink-0">→</span>}
              {recipient && <span className="truncate">{recipient}</span>}
            </span>
          )}
        </div>
        {/* Subject */}
        {subject && (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {subject}
          </p>
        )}
        {/* Clicked URL */}
        {clickUrl && (
          <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] text-blue-400">
            <RiLinkM className="size-2.5 shrink-0" />
            <span className="truncate">{clickUrl}</span>
          </p>
        )}
        {/* If no from/to/subject, fall back to summary */}
        {!from && !recipient && !subject && (
          <span className="block truncate text-xs font-medium">
            {trace.summary}
          </span>
        )}
        {/* Meta row */}
        <div className="mt-1 flex items-center gap-1.5">
          {status && (
            <span
              className={cn(
                "rounded px-1 py-px font-mono text-[10px]",
                status === "delivered"
                  ? "bg-emerald-500/15 text-emerald-500"
                  : status === "bounced" || status === "rejected"
                    ? "bg-destructive/15 text-destructive"
                    : status === "complained"
                      ? "bg-orange-500/15 text-orange-500"
                      : "bg-secondary text-muted-foreground",
              )}
            >
              {status}
            </span>
          )}
          {hasBot && (
            <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-orange-500/15 px-1 py-px text-[10px] font-medium text-orange-500">
              <RiRobotLine className="size-2.5" />
              bot
            </span>
          )}
          <div className="flex items-center gap-0.5">
            {timeline.reverse().map((ev) => (
              <span
                key={ev.id}
                className={cn("size-1.5 rounded-full", kindDotColor(ev.kind))}
                title={ev.kind}
              />
            ))}
          </div>
          <span className="tabular-nums text-[10px] text-muted-foreground">
            {trace.events.length} event{trace.events.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>
      <time className="mt-0.5 shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
        {new Date(trace.updatedAt).toLocaleTimeString()}
      </time>
    </button>
  );
}

function TraceInspector({ trace }: { trace: SandboxTrace }) {
  const { messageId, providerId, recipient, subject, status } =
    trace.correlation;

  // Extract from address from lead event
  const leadEvent =
    trace.events.find(
      (e) => e.category === "hook" || e.category === "send",
    ) ?? trace.events[0];
  const leadDetails = leadEvent?.details as Record<string, unknown> | undefined;
  const fromRaw = leadDetails?.from;
  const from =
    typeof fromRaw === "string"
      ? fromRaw
      : fromRaw && typeof fromRaw === "object" && "email" in fromRaw
        ? String((fromRaw as { email: string }).email)
        : null;

  return (
    <div className="flex flex-col">
      {/* Trace header */}
      <div className="border-b px-3 py-2.5">
        {subject ? (
          <p className="text-sm font-medium">{subject}</p>
        ) : (
          <p className="text-sm font-medium text-muted-foreground">
            {trace.summary}
          </p>
        )}
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {from && <span className="font-mono">{from}</span>}
          {from && recipient && <span className="text-muted-foreground/40">→</span>}
          {recipient && <span className="font-mono">{recipient}</span>}
          {(from || recipient) && status && (
            <span className="text-muted-foreground/30">·</span>
          )}
          {status && (
            <span
              className={cn(
                "font-mono",
                status === "delivered"
                  ? "text-emerald-500"
                  : status === "bounced" || status === "rejected"
                    ? "text-destructive"
                    : status === "complained"
                      ? "text-orange-500"
                      : "",
              )}
            >
              {status}
            </span>
          )}
        </div>
      </div>

      {/* Events */}
      <div className="flex flex-col divide-y">
        {trace.events.map((event) => (
          <TraceEventNode key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
}

function TraceEventNode({
  event,
}: {
  event: SandboxTrace["events"][number];
}) {
  const [open, setOpen] = useState(
    event.category === "hook" || event.category === "send",
  );
  const bot = getBotDetection(event.details);
  const facts = getEventFacts(event.kind, event.details);
  const label = eventLabel(event.kind);

  return (
    <div
      className="cursor-pointer px-3 py-2"
      onClick={() => setOpen(!open)}
    >
      {/* Header row */}
      <div className="flex w-full items-center gap-1.5">
        <span className={cn("shrink-0", kindColor(event.kind))}>
          {eventIcon(event.kind)}
        </span>
        <span className={cn("text-xs font-medium", kindColor(event.kind))}>
          {label}
        </span>
        {bot?.isBot && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-orange-500/15 px-1 py-px text-[10px] font-medium text-orange-500"
            title={`Bot: ${bot.reason}`}
          >
            <RiRobotLine className="size-2.5" />
            bot
          </span>
        )}
        {bot && !bot.isBot && (
          <span className="rounded bg-emerald-500/15 px-1 py-px font-mono text-[10px] text-emerald-500">
            {bot.reason}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
          <span className="text-muted-foreground/40">
            {open ? (
              <RiArrowDownSLine className="size-3" />
            ) : (
              <RiArrowRightSLine className="size-3" />
            )}
          </span>
        </span>
      </div>

      {/* Key facts */}
      {facts.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-5">
          {facts.map((f) => (
            <span key={f.label} className="text-[10px] text-muted-foreground">
              <span className="text-muted-foreground/50">{f.label}</span>{" "}
              <span className="font-mono">{f.value}</span>
            </span>
          ))}
        </div>
      )}

      {/* Raw details */}
      {open && (
        <div
          className="mt-2 rounded-lg border bg-background/50 p-2.5"
          onClick={(e) => e.stopPropagation()}
        >
          <JsonViewer data={event.details} />
        </div>
      )}
    </div>
  );
}

// ── Form primitives ──

function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Label
      className={cn(
        "gap-1.5 text-[10px] uppercase tracking-wider",
        disabled
          ? "cursor-not-allowed text-muted-foreground/40"
          : "text-muted-foreground",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="size-3.5"
      />
      {label}
    </Label>
  );
}

function CapabilitySection({
  caps,
  features,
  children,
}: {
  caps: SandboxProviderCapabilities;
  features: (keyof SandboxProviderCapabilities)[];
  children: React.ReactNode;
}) {
  if (!features.some((f) => caps[f])) return null;
  return <>{children}</>;
}

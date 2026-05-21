"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import { RiDeleteBinLine } from "@remixicon/react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { ProviderTabs } from "./components/provider-tabs";
import { ProviderStatus } from "./components/provider-status";
import { ComposePanel } from "./components/compose-panel";
import { DomainsPanel } from "./components/domains-panel";
import { TraceList } from "./components/trace-list";
import { TraceInspector } from "./components/trace-inspector";
import { defaultDraft, type Draft } from "@/lib/draft";
import type { SandboxProviderId, SandboxSnapshot } from "@/lib/sandbox-types";

const STORAGE_KEY = "emailkit-sandbox-session";

export function SandboxClient({
  initialSnapshot,
  selectedProvider,
}: {
  initialSnapshot: SandboxSnapshot;
  selectedProvider: SandboxProviderId;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [drafts, setDrafts] = useState<Record<SandboxProviderId, Draft>>(() => ({
    mailgun: defaultDraft(initialSnapshot, "mailgun"),
    resend: defaultDraft(initialSnapshot, "resend"),
    aiinbx: defaultDraft(initialSnapshot, "aiinbx"),
  }));
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(
    initialSnapshot.traces[0]?.id ?? null,
  );
  const [isSending, setIsSending] = useState(false);
  const [feedback, setFeedback] = useState("");

  // ── Session persistence (drafts only) ──

  useEffect(() => {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as {
        drafts?: Partial<Record<SandboxProviderId, Draft>>;
      };
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

  useEffect(() => {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ drafts }));
  }, [drafts]);

  // ── SSE streaming ──

  useEffect(() => {
    let cancelled = false;
    let fallbackTimeout: number | null = null;

    const loadSnapshot = async () => {
      try {
        const res = await fetch("/api/sandbox/state", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const next = (await res.json()) as SandboxSnapshot;
        startTransition(() => { if (!cancelled) setSnapshot(next); });
      } catch {}
    };

    if (typeof window.EventSource === "undefined") {
      void loadSnapshot();
      const interval = window.setInterval(() => void loadSnapshot(), 15000);
      return () => { cancelled = true; window.clearInterval(interval); };
    }

    const stream = new window.EventSource("/api/sandbox/stream");
    const handleSnapshot = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as SandboxSnapshot;
        startTransition(() => { if (!cancelled) setSnapshot(next); });
      } catch {}
    };
    const handleError = () => {
      if (fallbackTimeout !== null) window.clearTimeout(fallbackTimeout);
      fallbackTimeout = window.setTimeout(() => void loadSnapshot(), 1000);
    };

    stream.addEventListener("snapshot", handleSnapshot as EventListenerOrEventListenerObject);
    stream.onerror = handleError;

    return () => {
      cancelled = true;
      if (fallbackTimeout !== null) window.clearTimeout(fallbackTimeout);
      stream.removeEventListener("snapshot", handleSnapshot as EventListenerOrEventListenerObject);
      stream.close();
    };
  }, []);

  // ── Derived state ──

  const currentProvider = useMemo(
    () => snapshot.providers.find((p) => p.id === selectedProvider)!,
    [selectedProvider, snapshot.providers],
  );

  const selectedTrace = useMemo(
    () => snapshot.traces.find((t) => t.id === selectedTraceId) ?? null,
    [selectedTraceId, snapshot.traces],
  );

  const draft = drafts[selectedProvider];
  const caps = currentProvider.capabilities;

  const updateDraft = (field: keyof Draft, value: Draft[keyof Draft]) =>
    setDrafts((c) => ({
      ...c,
      [selectedProvider]: { ...c[selectedProvider], [field]: value },
    }));

  // ── Actions ──

  const parseKV = (raw: string): Record<string, string> | undefined => {
    if (!raw.trim()) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
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
      if (caps.unsubscribe && draft.unsubscribeGlobal) body.unsubscribeGlobal = true;
      if (draft.tags) {
        const tags = draft.tags.split(",").map((t) => t.trim()).filter(Boolean);
        if (tags.length) body.tags = tags;
      }
      if (draft.metadata) body.metadata = parseKV(draft.metadata);
      if (draft.headers) body.headers = parseKV(draft.headers);
      if (caps.templates && draft.templateId) {
        body.templateId = draft.templateId;
        if (draft.templateData) {
          try { body.templateData = JSON.parse(draft.templateData); } catch {}
        }
      }
      if (caps.sendIdempotency && draft.idempotencyKey) body.idempotencyKey = draft.idempotencyKey;
      if (caps.tenantRouting && draft.tenantId) body.tenantId = draft.tenantId;

      const res = await fetch("/api/sandbox/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = await res.json();
      if (!res.ok || !payload.ok) throw new Error(payload.error || "Send failed");
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

  // ── Render ──

  return (
    <div className="flex h-screen flex-col">
      {/* Toolbar */}
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-3">
        <span className="text-xs font-semibold tracking-wide uppercase text-muted-foreground">
          EmailKit Sandbox
        </span>

        <ProviderTabs
          providers={snapshot.providers}
          selected={selectedProvider}
        />

        <div className="flex-1" />

        <div className="flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
          <span>{snapshot.stats.traces} traces</span>
          <span className="text-border">&middot;</span>
          <span>{snapshot.stats.events} events</span>
          <span className="text-border">&middot;</span>
          <span>{snapshot.stats.send} sent</span>
        </div>

        <Button variant="ghost" size="xs" onClick={clearEvents}>
          <RiDeleteBinLine className="size-3" />
          Clear
        </Button>
      </header>

      {/* Main area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Compose + Domains */}
        <aside className="flex w-[380px] shrink-0 flex-col border-r">
          <ComposePanel
            draft={draft}
            caps={caps}
            provider={currentProvider}
            isSending={isSending}
            feedback={feedback}
            onUpdateDraft={updateDraft}
            onSend={send}
          />

          <DomainsPanel
            provider={currentProvider}
            selectedProvider={selectedProvider}
          />

          <ProviderStatus provider={currentProvider} />
        </aside>

        {/* Center: Trace list */}
        <TraceList
          traces={snapshot.traces}
          selectedProvider={selectedProvider}
          selectedTraceId={selectedTraceId}
          onSelectTrace={setSelectedTraceId}
        />

        {/* Right: Inspector */}
        <div className="flex w-[480px] shrink-0 flex-col border-l">
          <div className="flex h-9 items-center border-b px-3">
            <span className="text-xs font-medium text-muted-foreground">Inspector</span>
          </div>
          <div className="flex-1 overflow-auto scrollbar-thin">
            {selectedTrace ? (
              <TraceInspector trace={selectedTrace} />
            ) : (
              <div className="flex h-full items-center justify-center">
                <p className="text-xs text-muted-foreground">Select a trace to inspect</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

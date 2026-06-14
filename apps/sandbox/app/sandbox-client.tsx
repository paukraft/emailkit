"use client"

import { Trash2 } from "lucide-react"
import { startTransition, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { ComposePanel } from "./components/compose-panel"
import { DomainsPanel } from "./components/domains-panel"
import { MailboxesPanel } from "./components/mailboxes-panel"
import { ProviderStatus } from "./components/provider-status"
import { WebhooksPanel } from "./components/webhooks-panel"
import { ProviderTabs } from "./components/provider-tabs"
import { SidebarSection } from "./components/sidebar-section"
import { SyncPanel } from "./components/sync-panel"
import { TraceInspector } from "./components/trace-inspector"
import { TraceList } from "./components/trace-list"
import type { SandboxSnapshot } from "./sandbox/types"

export function SandboxClient({ initialSnapshot }: { initialSnapshot: SandboxSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot)
  const firstReady = initialSnapshot.drivers.find((driver) => driver.ready)?.id ?? initialSnapshot.drivers[0]?.id ?? ""
  const [selectedDriverId, setSelectedDriverId] = useState(firstReady)
  const [selectedTraceId, setSelectedTraceId] = useState<string | null>(snapshot.traces[0]?.id ?? null)

  useEffect(() => {
    const stream = new EventSource("/api/sandbox/stream")
    const onSnapshot = (event: MessageEvent<string>) => {
      try {
        const next = JSON.parse(event.data) as SandboxSnapshot
        startTransition(() => setSnapshot(next))
      } catch {}
    }
    stream.addEventListener("snapshot", onSnapshot as EventListener)
    return () => {
      stream.removeEventListener("snapshot", onSnapshot as EventListener)
      stream.close()
    }
  }, [])

  const driver = useMemo(
    () => snapshot.drivers.find((item) => item.id === selectedDriverId) ?? snapshot.drivers[0],
    [selectedDriverId, snapshot.drivers],
  )

  const selectedTrace = useMemo(
    () => snapshot.traces.find((trace) => trace.id === selectedTraceId) ?? null,
    [selectedTraceId, snapshot.traces],
  )

  const clear = async () => {
    const response = await fetch("/api/sandbox/state", { method: "DELETE" })
    if (!response.ok) return
    setSnapshot((await response.json()) as SandboxSnapshot)
    toast.success("Cleared traces")
  }

  if (!driver) {
    return <div className="p-6 text-sm text-muted-foreground">No sandbox drivers configured.</div>
  }

  return (
    <div className="flex h-screen flex-col">
      <header className="flex h-11 shrink-0 items-center gap-3 border-b px-3">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">EmailKit Sandbox</span>
        <ProviderTabs drivers={snapshot.drivers} selected={driver.id} onSelect={setSelectedDriverId} />
        <div className="flex-1" />
        <div className="flex items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground">
          <span>{snapshot.stats.traces} traces</span>
          <span className="text-border">·</span>
          <span>{snapshot.stats.events} events</span>
          <span className="text-border">·</span>
          <span>{snapshot.stats.sends} sent</span>
        </div>
        <Button variant="ghost" size="xs" onClick={clear}>
          <Trash2 className="size-3" />
          Clear
        </Button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <aside className="flex w-[380px] shrink-0 flex-col border-r">
          <div className="flex-1 overflow-y-auto">
            <SidebarSection title="Compose" defaultOpen>
              <ComposePanel driver={driver} onSnapshot={setSnapshot} />
            </SidebarSection>
            <DomainsPanel key={`domains-${driver.id}`} driver={driver} />
            <MailboxesPanel key={`mailboxes-${driver.id}`} driver={driver} />
            <WebhooksPanel key={`webhooks-${driver.id}`} driver={driver} />
            <SyncPanel key={`sync-${driver.id}`} driver={driver} />
          </div>
          <ProviderStatus driver={driver} />
        </aside>

        <TraceList
          traces={snapshot.traces}
          selectedDriver={driver.id}
          selectedTraceId={selectedTraceId}
          onSelectTrace={setSelectedTraceId}
        />

        <div className="flex w-[480px] shrink-0 flex-col border-l">
          {selectedTrace ? (
            <TraceInspector trace={selectedTrace} />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
              <div className="trace-empty flex items-center gap-1">
                <span className="size-1.5 rounded-full bg-muted-foreground/30" />
                <span className="h-px w-6 bg-border" />
                <span className="size-1.5 rounded-full bg-muted-foreground/30" />
                <span className="h-px w-6 bg-border" />
                <span className="size-1.5 rounded-full bg-muted-foreground/30" />
              </div>
              <p className="trace-empty-label text-xs text-muted-foreground">Select a trace to inspect</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

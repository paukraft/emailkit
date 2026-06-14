"use client"

import type { Domain, Mailbox } from "emailkit"
import { CheckCircle2, History, Play, RotateCw, TriangleAlert } from "lucide-react"
import { useEffect, useState } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import { SidebarSection } from "./sidebar-section"
import { TimeAgo } from "./time-ago"
import type { SandboxDriverInfo, SandboxSyncResult, SyncTarget } from "../sandbox/types"

type Scope = "account" | "mailbox" | "domain"

const availableScopes = (driver: SandboxDriverInfo): Scope[] => {
  const sync = driver.capabilities.sync
  if (!sync) return []
  const scopes: Scope[] = []
  if (sync.account) scopes.push("account")
  if (sync.mailbox) scopes.push("mailbox")
  if (sync.domain) scopes.push("domain")
  return scopes
}

const pad = (value: number) => String(value).padStart(2, "0")

const toLocalInput = (date: Date) =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`

export function SyncPanel({ driver }: { driver: SandboxDriverInfo }) {
  const scopes = availableScopes(driver)
  if (scopes.length === 0) return null
  return <SyncPanelInner driver={driver} scopes={scopes} />
}

function SyncPanelInner({
  driver,
  scopes,
}: {
  driver: SandboxDriverInfo
  scopes: Scope[]
}) {
  const [open, setOpen] = useState(false)
  const [result, setResult] = useState<SandboxSyncResult | null>(null)

  return (
    <SidebarSection
      title="Sync"
      icon={<History className="size-3" />}
      defaultOpen={false}
      trailing={
        <Button
          variant="outline"
          size="xs"
          onClick={() => setOpen(true)}
          disabled={!driver.ready}
        >
          <Play className="size-3" />
          Run
        </Button>
      }
    >
      <div className="flex flex-col gap-2 px-3 py-2.5">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Replay missed provider events through the same hooks as live webhooks.
          Replayed events appear as traces.
        </p>
        {result && <ResultCard result={result} onResume={() => setOpen(true)} />}
      </div>

      <RunDialog
        key={open ? "open" : "closed"}
        open={open}
        onOpenChange={setOpen}
        driver={driver}
        scopes={scopes}
        resumeFrom={result && !result.ok ? result.lastEventTimestamp : undefined}
        onResult={setResult}
      />
    </SidebarSection>
  )
}

function ResultCard({
  result,
  onResume,
}: {
  result: SandboxSyncResult
  onResume: () => void
}) {
  return (
    <div
      className={cn(
        "rounded-lg border px-2.5 py-2 text-[11px]",
        result.ok ? "bg-success/5" : "bg-destructive/5"
      )}
    >
      <div className="flex items-center gap-1.5 font-medium">
        {result.ok ? (
          <CheckCircle2 className="size-3.5 text-success" />
        ) : (
          <TriangleAlert className="size-3.5 text-destructive" />
        )}
        <span className="capitalize">{result.scope}</span>
        <span className="text-muted-foreground">
          · {result.dispatched} dispatched
        </span>
      </div>
      {result.ok && result.syncedFrom && (
        <p className="mt-1 text-muted-foreground">
          Synced from <TimeAgo date={result.syncedFrom} />
        </p>
      )}
      {!result.ok && (
        <div className="mt-1 flex flex-col gap-1.5">
          <p className="break-words text-destructive">{result.error}</p>
          {result.lastEventTimestamp && (
            <Button variant="outline" size="xs" className="self-start" onClick={onResume}>
              <RotateCw className="size-3" />
              Resume
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

function RunDialog({
  open,
  onOpenChange,
  driver,
  scopes,
  resumeFrom,
  onResult,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  driver: SandboxDriverInfo
  scopes: Scope[]
  resumeFrom?: string
  onResult: (result: SandboxSyncResult) => void
}) {
  const [scope, setScope] = useState<Scope>(scopes[0])
  const [since, setSince] = useState(() =>
    toLocalInput(
      resumeFrom ? new Date(resumeFrom) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    )
  )
  const [until, setUntil] = useState("")
  const [context, setContext] = useState("")
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [mailboxEmail, setMailboxEmail] = useState("")
  const [domains, setDomains] = useState<Domain[]>([])
  const [domain, setDomain] = useState("")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open || scope !== "mailbox") return
    fetch(`/api/sandbox/mailboxes?emailDriver=${driver.id}`)
      .then((response) => response.json())
      .then((data) => {
        if (data?.ok) setMailboxes(data.mailboxes as Mailbox[])
      })
      .catch(() => {})
  }, [open, scope, driver.id])

  useEffect(() => {
    if (!open || scope !== "domain") return
    fetch(`/api/sandbox/domains?emailDriver=${driver.id}`)
      .then((response) => response.json())
      .then((data) => {
        if (data?.ok) setDomains(data.domains as Domain[])
      })
      .catch(() => {})
  }, [open, scope, driver.id])

  const submit = async () => {
    setSubmitting(true)
    try {
      if (!since) throw new Error("Pick a start time.")
      const target: SyncTarget =
        scope === "account"
          ? { scope }
          : scope === "mailbox"
            ? { scope, mailboxEmail }
            : { scope, domain: domain.trim() }
      if (scope === "mailbox" && !mailboxEmail) throw new Error("Pick a mailbox.")
      if (scope === "domain" && !domain.trim()) throw new Error("Enter a domain.")

      let parsedContext: unknown
      if (context.trim()) {
        try {
          parsedContext = JSON.parse(context)
        } catch {
          parsedContext = context.trim()
        }
      }

      const response = await fetch("/api/sandbox/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          ...target,
          since: new Date(since).toISOString(),
          until: until ? new Date(until).toISOString() : undefined,
          context: parsedContext,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Sync failed")
      const result = data.result as SandboxSyncResult
      onResult(result)
      onOpenChange(false)
      if (result.ok) {
        toast.success(
          `Replayed ${result.dispatched} event${result.dispatched === 1 ? "" : "s"}`
        )
      } else {
        toast.error(`Sync failed after ${result.dispatched} dispatched`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Sync failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Run sync</DialogTitle>
          <DialogDescription>
            Replay missed events from {driver.label} since a point in time.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          {scopes.length > 1 && (
            <label className="grid gap-1">
              <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                Scope
              </span>
              <Select
                value={scope}
                onValueChange={(value) => value && setScope(value as Scope)}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((option) => (
                    <SelectItem key={option} value={option}>
                      <span className="capitalize">{option}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {scope === "mailbox" && (
            <label className="grid gap-1">
              <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                Mailbox
              </span>
              <Select
                value={mailboxEmail}
                onValueChange={(value) => setMailboxEmail(value ?? "")}
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue
                    placeholder={
                      mailboxes.length ? "Pick a mailbox" : "No connected mailboxes"
                    }
                  />
                </SelectTrigger>
                <SelectContent
                  alignItemWithTrigger={false}
                  className="w-auto min-w-(--anchor-width) max-w-[min(24rem,var(--available-width))]"
                >
                  {mailboxes.map((mailbox) => (
                    <SelectItem key={mailbox.id || mailbox.email} value={mailbox.email}>
                      <span className="font-mono text-xs">{mailbox.email}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {scope === "domain" &&
            (domains.length > 0 ? (
              <label className="grid gap-1">
                <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                  Domain
                </span>
                <Select value={domain} onValueChange={(value) => setDomain(value ?? "")}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Pick a domain" />
                  </SelectTrigger>
                  <SelectContent
                    alignItemWithTrigger={false}
                    className="w-auto min-w-(--anchor-width) max-w-[min(24rem,var(--available-width))]"
                  >
                    {domains.map((item) => (
                      <SelectItem key={item.id || item.domain} value={item.domain}>
                        <span className="font-mono text-xs">{item.domain}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
            ) : (
              <label className="grid gap-1">
                <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
                  Domain
                </span>
                <Input
                  value={domain}
                  onChange={(event) => setDomain(event.target.value)}
                  placeholder="example.com"
                  className="h-8 text-xs"
                />
              </label>
            ))}

          <label className="grid gap-1">
            <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
              Since
            </span>
            <Input
              type="datetime-local"
              value={since}
              onChange={(event) => setSince(event.target.value)}
              className="h-8 text-xs"
            />
          </label>

          <label className="grid gap-1">
            <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
              Until <span className="normal-case opacity-60">(optional)</span>
            </span>
            <Input
              type="datetime-local"
              value={until}
              onChange={(event) => setUntil(event.target.value)}
              className="h-8 text-xs"
            />
          </label>

          <label className="grid gap-1">
            <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
              Context <span className="normal-case opacity-60">(optional)</span>
            </span>
            <Input
              value={context}
              onChange={(event) => setContext(event.target.value)}
              placeholder='e.g. {"replay":true}'
              className="h-8 font-mono text-xs"
            />
          </label>
        </div>

        <DialogFooter>
          <Button onClick={submit} disabled={submitting} size="sm">
            {submitting ? "Syncing…" : "Run sync"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

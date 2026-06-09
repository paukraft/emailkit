"use client"

import type { Mailbox } from "emailkit"
import { Plus, RefreshCcw, RotateCw, Trash2, Webhook } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

const useNow = (intervalMs = 30000) => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { SidebarSection } from "./sidebar-section"
import { TimeAgo } from "./time-ago"
import type {
  SandboxDriverInfo,
  SandboxWebhookView,
  WebhookSetupTarget,
} from "../sandbox/types"

const STATUS_STYLE: Record<string, string> = {
  active: "bg-success/15 text-success",
  pending: "bg-orange-500/15 text-orange-500",
  disabled: "bg-destructive/15 text-destructive",
  deleted: "bg-destructive/15 text-destructive",
  expired: "bg-destructive/15 text-destructive",
  unknown: "bg-secondary text-muted-foreground",
}

const EVENT_OPTIONS = [
  "inbound",
  "outbound",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "rejected",
] as const

type Scope = "account" | "mailbox" | "domain"

const availableScopes = (driver: SandboxDriverInfo): Scope[] => {
  const w = driver.capabilities.webhooks
  if (!w) return []
  const scopes: Scope[] = []
  if (w.account) scopes.push("account")
  if (w.mailbox) scopes.push("mailbox")
  if (w.domain) scopes.push("domain")
  return scopes
}

export function WebhooksPanel({ driver }: { driver: SandboxDriverInfo }) {
  const scopes = availableScopes(driver)
  if (scopes.length === 0) return null
  return <WebhooksPanelInner driver={driver} scopes={scopes} />
}

function WebhooksPanelInner({
  driver,
  scopes,
}: {
  driver: SandboxDriverInfo
  scopes: Scope[]
}) {
  const now = useNow()
  const [webhooks, setWebhooks] = useState<SandboxWebhookView[]>([])
  const [loading, setLoading] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [setupOpen, setSetupOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<SandboxWebhookView | null>(
    null
  )
  const [busyRowId, setBusyRowId] = useState<string | null>(null)
  const [renewing, setRenewing] = useState(false)

  const load = useCallback(async () => {
    if (!driver.ready) return
    setLoading(true)
    try {
      const response = await fetch(
        `/api/sandbox/webhooks?emailDriver=${driver.id}`
      )
      const data = await response.json()
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Failed to load webhooks")
      setWebhooks(data.webhooks as SandboxWebhookView[])
      setHasLoaded(true)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to load webhooks"
      )
    } finally {
      setLoading(false)
    }
  }, [driver.id, driver.ready])

  const refresh = async (webhook: SandboxWebhookView) => {
    setBusyRowId(webhook.rowId)
    try {
      const response = await fetch("/api/sandbox/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "refresh",
          rowId: webhook.rowId,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Refresh failed")
      setWebhooks(data.webhooks as SandboxWebhookView[])
      toast.success("Webhook renewed")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Refresh failed")
    } finally {
      setBusyRowId(null)
    }
  }

  const remove = async (webhook: SandboxWebhookView) => {
    setBusyRowId(webhook.rowId)
    try {
      const response = await fetch("/api/sandbox/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "delete",
          rowId: webhook.rowId,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Delete failed")
      setWebhooks(data.webhooks as SandboxWebhookView[])
      setDeleteTarget(null)
      toast.success("Webhook deleted")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Delete failed")
    } finally {
      setBusyRowId(null)
    }
  }

  const renewExpiring = async () => {
    setRenewing(true)
    try {
      const response = await fetch("/api/sandbox/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "renew-expiring",
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Renew failed")
      setWebhooks(data.webhooks as SandboxWebhookView[])
      const results = (data.results as { ok: boolean }[]) ?? []
      const ok = results.filter((r) => r.ok).length
      const failed = results.length - ok
      toast.success(`Renewed ${ok}${failed ? `, ${failed} failed` : ""}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Renew failed")
    } finally {
      setRenewing(false)
    }
  }

  const expiringCount = useMemo(
    () =>
      webhooks.filter((webhook) => {
        if (!webhook.expiresAt && !webhook.renewAfter) return false
        const due = new Date(webhook.renewAfter ?? webhook.expiresAt ?? 0)
        return due.getTime() <= now
      }).length,
    [webhooks, now]
  )

  return (
    <SidebarSection
      title="Webhooks"
      icon={<Webhook className="size-3" />}
      count={webhooks.length}
      defaultOpen={false}
      onOpen={() => {
        if (!hasLoaded && !loading) load()
      }}
      trailing={
        <>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={load}
            disabled={loading || !driver.ready}
            title="Refresh"
          >
            <RefreshCcw className={cn("size-3", loading && "animate-spin")} />
          </Button>
          {expiringCount > 0 && (
            <Button
              variant="outline"
              size="xs"
              onClick={renewExpiring}
              disabled={renewing || !driver.ready}
              title="Renew expiring webhooks"
            >
              <RotateCw className={cn("size-3", renewing && "animate-spin")} />
              Renew {expiringCount}
            </Button>
          )}
          <Button
            variant="outline"
            size="xs"
            onClick={() => setSetupOpen(true)}
            disabled={!driver.ready}
          >
            <Plus className="size-3" />
            Setup
          </Button>
        </>
      }
    >
      <WebhookList
        loading={loading}
        hasLoaded={hasLoaded}
        webhooks={webhooks}
        busyRowId={busyRowId}
        now={now}
        onRefresh={refresh}
        onDelete={(webhook) => setDeleteTarget(webhook)}
      />

      <SetupDialog
        key={setupOpen ? "open" : "closed"}
        open={setupOpen}
        onOpenChange={setSetupOpen}
        driver={driver}
        scopes={scopes}
        onCreated={(next) => setWebhooks(next)}
      />

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete webhook</DialogTitle>
            <DialogDescription>
              Delete{" "}
              <span className="font-mono font-medium text-foreground">
                {deleteTarget?.scope}
              </span>{" "}
              webhook{" "}
              <span className="font-mono text-foreground">
                {deleteTarget?.providerId ?? deleteTarget?.rowId}
              </span>
              ?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              size="sm"
              disabled={busyRowId === deleteTarget?.rowId}
              onClick={() => deleteTarget && remove(deleteTarget)}
            >
              <Trash2 className="size-3" />
              {busyRowId === deleteTarget?.rowId ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarSection>
  )
}

function WebhookList({
  loading,
  hasLoaded,
  webhooks,
  busyRowId,
  now,
  onRefresh,
  onDelete,
}: {
  loading: boolean
  hasLoaded: boolean
  webhooks: SandboxWebhookView[]
  busyRowId: string | null
  now: number
  onRefresh: (webhook: SandboxWebhookView) => void
  onDelete: (webhook: SandboxWebhookView) => void
}) {
  if (loading && webhooks.length === 0) {
    return (
      <p className="px-3 py-3 text-center text-[10px] text-muted-foreground">
        Loading…
      </p>
    )
  }
  if (hasLoaded && webhooks.length === 0) {
    return (
      <p className="px-3 py-3 text-center text-[10px] text-muted-foreground">
        No webhooks. Click Setup to register one.
      </p>
    )
  }
  if (!hasLoaded && webhooks.length === 0) return null

  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-7 px-3 text-[10px] tracking-wider text-muted-foreground uppercase">
            Scope
          </TableHead>
          <TableHead className="h-7 px-3 text-[10px] tracking-wider text-muted-foreground uppercase">
            Target
          </TableHead>
          <TableHead className="h-7 px-3 text-[10px] tracking-wider text-muted-foreground uppercase">
            Expires
          </TableHead>
          <TableHead className="h-7 w-16 px-1" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {webhooks.map((webhook) => {
          const target =
            webhook.scope === "mailbox"
              ? webhook.mailboxEmail
              : webhook.scope === "domain"
                ? webhook.domain
                : "—"
          const expiry = expiryState(webhook, now)
          return (
            <TableRow key={webhook.rowId} className="hover:bg-muted/30">
              <TableCell className="px-3 py-1.5">
                <span className="font-mono text-xs capitalize">
                  {webhook.scope}
                </span>
                <span
                  className={cn(
                    "ml-1.5 rounded px-1 py-0.5 text-[10px] font-medium",
                    STATUS_STYLE[webhook.status] ?? STATUS_STYLE.unknown
                  )}
                >
                  {webhook.status}
                </span>
              </TableCell>
              <TableCell className="px-3 py-1.5">
                <span
                  className="block truncate font-mono text-[11px]"
                  title={target ?? ""}
                >
                  {target}
                </span>
                {webhook.events && webhook.events.length > 0 && (
                  <span className="block truncate text-[10px] text-muted-foreground">
                    {webhook.events.join(", ")}
                  </span>
                )}
              </TableCell>
              <TableCell className="px-3 py-1.5">
                <span
                  className={cn(
                    "font-mono text-[10px]",
                    expiry.tone === "danger" && "text-destructive",
                    expiry.tone === "warn" && "text-orange-500",
                    expiry.tone === "ok" && "text-muted-foreground"
                  )}
                >
                  {expiry.kind === "none" && "—"}
                  {expiry.kind === "expired" && "expired"}
                  {expiry.kind === "future" && <TimeAgo date={expiry.date} />}
                </span>
              </TableCell>
              <TableCell className="px-1 py-1.5">
                <div className="flex items-center justify-end gap-0.5">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Renew"
                    disabled={
                      busyRowId === webhook.rowId || !webhook.providerId
                    }
                    onClick={() => onRefresh(webhook)}
                  >
                    <RotateCw
                      className={cn(
                        "size-3.5",
                        busyRowId === webhook.rowId && "animate-spin"
                      )}
                    />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    title="Delete"
                    disabled={busyRowId === webhook.rowId}
                    onClick={() => onDelete(webhook)}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}

type ExpiryState =
  | { kind: "none"; tone: "none" }
  | { kind: "expired"; tone: "danger" }
  | { kind: "future"; tone: "warn" | "ok"; date: Date }

function expiryState(webhook: SandboxWebhookView, now: number): ExpiryState {
  if (!webhook.expiresAt) return { kind: "none", tone: "none" }
  const date = new Date(webhook.expiresAt)
  const deltaMs = date.getTime() - now
  if (deltaMs <= 0) return { kind: "expired", tone: "danger" }
  const day = 24 * 60 * 60 * 1000
  return { kind: "future", tone: deltaMs < day ? "warn" : "ok", date }
}

function SetupDialog({
  open,
  onOpenChange,
  driver,
  scopes,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  driver: SandboxDriverInfo
  scopes: Scope[]
  onCreated: (webhooks: SandboxWebhookView[]) => void
}) {
  const [scope, setScope] = useState<Scope>(scopes[0])
  const [url, setUrl] = useState("")
  const [eventSelection, setEventSelection] = useState<
    "all" | Record<string, boolean>
  >("all")
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [mailboxEmail, setMailboxEmail] = useState("")
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

  const toggleEvent = (event: string, on: boolean) =>
    setEventSelection((current) => {
      const next = current === "all" ? {} : { ...current }
      if (on) next[event] = true
      else delete next[event]
      return next
    })

  const submit = async () => {
    setSubmitting(true)
    try {
      const target: WebhookSetupTarget =
        scope === "account"
          ? { scope }
          : scope === "mailbox"
            ? { scope, mailboxEmail }
            : { scope, domain }
      if (scope === "mailbox" && !mailboxEmail)
        throw new Error("Pick a mailbox.")
      if (scope === "domain" && !domain.trim())
        throw new Error("Enter a domain.")

      const events =
        eventSelection === "all"
          ? "all"
          : Object.keys(eventSelection).filter((event) => eventSelection[event])

      const response = await fetch("/api/sandbox/webhooks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "setup",
          ...target,
          url: url || undefined,
          events: Array.isArray(events) && events.length === 0 ? "all" : events,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Setup failed")
      onCreated(data.webhooks as SandboxWebhookView[])
      onOpenChange(false)
      toast.success("Webhook created")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Setup failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Setup webhook</DialogTitle>
          <DialogDescription>
            Register a webhook with {driver.label}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
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
                      mailboxes.length
                        ? "Pick a mailbox"
                        : "No connected mailboxes"
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {mailboxes.map((mailbox) => (
                    <SelectItem
                      key={mailbox.id || mailbox.email}
                      value={mailbox.email}
                    >
                      <span className="font-mono text-xs">{mailbox.email}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}

          {scope === "domain" && (
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
          )}

          <label className="grid gap-1">
            <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
              URL
            </span>
            <Input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={`auto: ${driver.publicWebhookUrl}`}
              className="h-8 text-xs"
            />
          </label>

          <fieldset className="grid gap-1.5">
            <span className="text-[10px] tracking-wider text-muted-foreground uppercase">
              Events
            </span>
            <label className="flex items-center gap-1.5 text-xs">
              <Checkbox
                checked={eventSelection === "all"}
                onCheckedChange={(value) =>
                  setEventSelection(value ? "all" : {})
                }
              />
              All events
            </label>
            {eventSelection !== "all" && (
              <div className="grid grid-cols-2 gap-1">
                {EVENT_OPTIONS.map((event) => (
                  <label
                    key={event}
                    className="flex items-center gap-1.5 text-[11px]"
                  >
                    <Checkbox
                      checked={Boolean(
                        (eventSelection as Record<string, boolean>)[event]
                      )}
                      onCheckedChange={(value) =>
                        toggleEvent(event, Boolean(value))
                      }
                    />
                    {event}
                  </label>
                ))}
              </div>
            )}
          </fieldset>
        </div>

        <DialogFooter>
          <Button onClick={submit} disabled={submitting} size="sm">
            {submitting ? "Creating…" : "Create webhook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

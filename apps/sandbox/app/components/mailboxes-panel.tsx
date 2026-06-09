"use client"

import type { Mailbox, MailboxConnectionResult } from "emailkit"
import {
  Copy,
  ExternalLink,
  Inbox,
  Link2,
  Plus,
  RefreshCcw,
  Trash2,
} from "lucide-react"
import { useCallback, useState } from "react"
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { SidebarSection } from "./sidebar-section"
import type { SandboxDriverInfo } from "../sandbox/types"

const STATUS_STYLE: Record<string, string> = {
  connected: "bg-success/15 text-success",
  pending: "bg-orange-500/15 text-orange-500",
  disabled: "bg-destructive/15 text-destructive",
  unknown: "bg-secondary text-muted-foreground",
}

export function MailboxesPanel({ driver }: { driver: SandboxDriverInfo }) {
  const caps = driver.capabilities
  const supported = Boolean(
    caps.mailboxList || caps.mailboxConnect || caps.mailboxCreate
  )
  if (!supported) return null
  return <MailboxesPanelInner driver={driver} />
}

function MailboxesPanelInner({ driver }: { driver: SandboxDriverInfo }) {
  const caps = driver.capabilities
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([])
  const [loading, setLoading] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [connectOpen, setConnectOpen] = useState(false)
  const [connectEmail, setConnectEmail] = useState("")
  const [connectCallback, setConnectCallback] = useState("")
  const [connecting, setConnecting] = useState(false)
  const [authUrl, setAuthUrl] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createEmail, setCreateEmail] = useState("")
  const [createName, setCreateName] = useState("")
  const [creating, setCreating] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Mailbox | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!driver.ready) return
    setLoading(true)
    try {
      const response = await fetch(
        `/api/sandbox/mailboxes?emailDriver=${driver.id}`
      )
      const data = await response.json()
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Failed to load mailboxes")
      setMailboxes(data.mailboxes as Mailbox[])
      setHasLoaded(true)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Failed to load mailboxes"
      )
    } finally {
      setLoading(false)
    }
  }, [driver.id, driver.ready])

  const connect = async () => {
    setConnecting(true)
    try {
      const response = await fetch("/api/sandbox/mailboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "connect",
          email: connectEmail || undefined,
          callbackUrl: connectCallback || undefined,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Connect failed")
      const result = data.result as MailboxConnectionResult
      if (result.redirectUrl) {
        setAuthUrl(result.redirectUrl)
      }
      if (result.mailbox) {
        setMailboxes((current) => upsertMailbox(current, result.mailbox!))
        toast.success("Mailbox connected")
        setConnectOpen(false)
      }
      if (!result.redirectUrl && !result.mailbox) {
        setConnectOpen(false)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Connect failed")
    } finally {
      setConnecting(false)
    }
  }

  const create = async () => {
    if (!createEmail.trim()) return
    setCreating(true)
    try {
      const response = await fetch("/api/sandbox/mailboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "create",
          email: createEmail.trim(),
          displayName: createName || undefined,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Create failed")
      setMailboxes((current) => upsertMailbox(current, data.mailbox as Mailbox))
      setCreateOpen(false)
      setCreateEmail("")
      setCreateName("")
      toast.success("Mailbox created")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Create failed")
    } finally {
      setCreating(false)
    }
  }

  const remove = async (mailbox: Mailbox) => {
    setDeletingId(mailbox.id)
    try {
      const response = await fetch("/api/sandbox/mailboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "delete",
          idOrEmail: mailbox.id || mailbox.email,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok)
        throw new Error(data.error || "Delete failed")
      setMailboxes((current) =>
        current.filter((item) => item.id !== mailbox.id)
      )
      setDeleteTarget(null)
      toast.success("Mailbox deleted")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Delete failed")
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <SidebarSection
      title="Mailboxes"
      icon={<Inbox className="size-3" />}
      count={mailboxes.length}
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
          {caps.mailboxConnect && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => setConnectOpen(true)}
              disabled={!driver.ready}
            >
              <Link2 className="size-3" />
              Connect
            </Button>
          )}
          {caps.mailboxCreate && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => setCreateOpen(true)}
              disabled={!driver.ready}
            >
              <Plus className="size-3" />
              Create
            </Button>
          )}
        </>
      }
    >
      <MailboxList
        loading={loading}
        hasLoaded={hasLoaded}
        mailboxes={mailboxes}
        onDelete={(mailbox) => setDeleteTarget(mailbox)}
      />

      <Dialog
        open={connectOpen}
        onOpenChange={(open) => {
          setConnectOpen(open)
          if (!open) setAuthUrl(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Connect mailbox</DialogTitle>
            <DialogDescription>
              {authUrl
                ? "Share this link with the mailbox owner to authorize."
                : "Start the OAuth flow for this provider."}
            </DialogDescription>
          </DialogHeader>
          {authUrl ? (
            <div className="grid gap-2">
              <div className="rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[10px] break-all">
                {authUrl}
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  onClick={async () => {
                    await navigator.clipboard.writeText(authUrl)
                    toast.success("Link copied")
                  }}
                >
                  <Copy className="size-3" />
                  Copy link
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  onClick={() =>
                    window.open(authUrl, "_blank", "noopener,noreferrer")
                  }
                >
                  <ExternalLink className="size-3" />
                  Open
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="grid gap-2">
                <Input
                  value={connectEmail}
                  onChange={(event) => setConnectEmail(event.target.value)}
                  placeholder="user@example.com (optional)"
                  className="text-xs"
                />
                <Input
                  value={connectCallback}
                  onChange={(event) => setConnectCallback(event.target.value)}
                  placeholder="callback URL (optional)"
                  className="text-xs"
                />
              </div>
              <DialogFooter>
                <Button onClick={connect} disabled={connecting} size="sm">
                  <ExternalLink className="size-3" />
                  {connecting ? "Starting…" : "Start auth"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Create mailbox</DialogTitle>
            <DialogDescription>
              Provision a mailbox managed by this provider.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Input
              value={createEmail}
              onChange={(event) => setCreateEmail(event.target.value)}
              placeholder="mailbox@example.com"
              className="text-xs"
              autoFocus
            />
            <Input
              value={createName}
              onChange={(event) => setCreateName(event.target.value)}
              placeholder="Display name (optional)"
              className="text-xs"
            />
          </div>
          <DialogFooter>
            <Button
              onClick={create}
              disabled={creating || !createEmail.trim()}
              size="sm"
            >
              {creating ? "Creating…" : "Create mailbox"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete mailbox</DialogTitle>
            <DialogDescription>
              Delete{" "}
              <span className="font-mono font-medium text-foreground">
                {deleteTarget?.email}
              </span>
              ?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              size="sm"
              disabled={deletingId === deleteTarget?.id}
              onClick={() => deleteTarget && remove(deleteTarget)}
            >
              <Trash2 className="size-3" />
              {deletingId === deleteTarget?.id ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SidebarSection>
  )
}

function MailboxList({
  loading,
  hasLoaded,
  mailboxes,
  onDelete,
}: {
  loading: boolean
  hasLoaded: boolean
  mailboxes: Mailbox[]
  onDelete: (mailbox: Mailbox) => void
}) {
  if (loading && mailboxes.length === 0) {
    return (
      <p className="px-3 py-3 text-center text-[10px] text-muted-foreground">
        Loading…
      </p>
    )
  }

  if (hasLoaded && mailboxes.length === 0) {
    return (
      <p className="px-3 py-3 text-center text-[10px] text-muted-foreground">
        No mailboxes connected.
      </p>
    )
  }

  if (!hasLoaded && mailboxes.length === 0) {
    return null
  }

  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-7 px-3 text-[10px] tracking-wider text-muted-foreground uppercase">
            Email
          </TableHead>
          <TableHead className="h-7 px-3 text-[10px] tracking-wider text-muted-foreground uppercase">
            Status
          </TableHead>
          <TableHead className="h-7 w-10 px-1" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {mailboxes.map((mailbox) => (
          <TableRow
            key={mailbox.id || mailbox.email}
            className="hover:bg-muted/30"
          >
            <TableCell className="px-3 py-1.5">
              <span className="font-mono text-xs">{mailbox.email}</span>
              {mailbox.displayName && (
                <span className="ml-1.5 text-[10px] text-muted-foreground">
                  {mailbox.displayName}
                </span>
              )}
            </TableCell>
            <TableCell className="px-3 py-1.5">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 text-[10px] font-medium",
                  STATUS_STYLE[mailbox.status ?? "unknown"] ??
                    STATUS_STYLE.unknown
                )}
              >
                {mailbox.status ?? "unknown"}
              </span>
            </TableCell>
            <TableCell className="px-1 py-1.5">
              <Button
                variant="ghost"
                size="icon-xs"
                title="Delete"
                onClick={() => onDelete(mailbox)}
              >
                <Trash2 className="size-3.5 text-destructive" />
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function upsertMailbox(list: Mailbox[], next: Mailbox) {
  const key = next.id || next.email
  return [next, ...list.filter((item) => (item.id || item.email) !== key)]
}

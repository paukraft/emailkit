"use client"

import type { Domain, DomainDNSRecord, DomainVerification } from "emailkit"
import {
  Check,
  Copy,
  FileText,
  Globe2,
  Plus,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  TriangleAlert,
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { SidebarSection } from "./sidebar-section"
import { TimeAgo } from "./time-ago"
import type { SandboxDriverInfo } from "../sandbox/types"

const STATUS_STYLE: Record<string, string> = {
  verified: "bg-success/15 text-success",
  pending: "bg-orange-500/15 text-orange-500",
  unverified: "bg-secondary text-muted-foreground",
  disabled: "bg-destructive/15 text-destructive",
  unknown: "bg-secondary text-muted-foreground",
}

const hasRecords = (domain: Domain | null | undefined) =>
  (domain?.verification?.records?.length ?? 0) > 0

const mergeDomain = (current: Domain | undefined, incoming: Domain): Domain => {
  if (!current || hasRecords(incoming) || !hasRecords(current)) return incoming
  return {
    ...incoming,
    verification: incoming.verification
      ? { ...current.verification, ...incoming.verification, records: current.verification!.records }
      : current.verification,
  }
}

const upsert = (list: Domain[], next: Domain) => [
  mergeDomain(list.find((item) => item.id === next.id), next),
  ...list.filter((item) => item.id !== next.id),
]

export function DomainsPanel({ driver }: { driver: SandboxDriverInfo }) {
  if (!driver.capabilities.domains) return null
  return <DomainsPanelInner driver={driver} />
}

function DomainsPanelInner({ driver }: { driver: SandboxDriverInfo }) {
  const [domains, setDomains] = useState<Domain[]>([])
  const [loading, setLoading] = useState(false)
  const [hasLoaded, setHasLoaded] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState("")
  const [adding, setAdding] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Domain | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [dnsTarget, setDnsTarget] = useState<Domain | null>(null)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const [fetchingDns, setFetchingDns] = useState(false)

  const load = useCallback(async () => {
    if (!driver.ready) return
    setLoading(true)
    try {
      const response = await fetch(`/api/sandbox/domains?emailDriver=${driver.id}`)
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Failed to load domains")
      setDomains((current) => {
        const incoming = data.domains as Domain[]
        const byId = new Map(current.map((domain) => [domain.id, domain]))
        return incoming.map((domain) => mergeDomain(byId.get(domain.id), domain))
      })
      setHasLoaded(true)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load domains")
    } finally {
      setLoading(false)
    }
  }, [driver.id, driver.ready])

  const addDomain = async () => {
    if (!newName.trim()) return
    setAdding(true)
    try {
      const response = await fetch("/api/sandbox/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "create",
          domain: newName.trim(),
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Failed to add domain")
      setDomains((current) => upsert(current, data.domain as Domain))
      setNewName("")
      setCreateOpen(false)
      toast.success("Domain added")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add domain")
    } finally {
      setAdding(false)
    }
  }

  const verifyDomain = async (domain: Domain) => {
    setVerifyingId(domain.id)
    try {
      const response = await fetch("/api/sandbox/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "verify",
          domain: domain.domain,
          domainId: domain.id,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Verification failed")
      const verification = data.verification as DomainVerification
      const next: Domain = { ...domain, verification, status: verification.status }
      setDomains((current) => current.map((item) => (item.id === domain.id ? next : item)))
      setDnsTarget((current) => (current?.id === domain.id ? next : current))
      toast.success("Re-verified")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Verification failed")
    } finally {
      setVerifyingId(null)
    }
  }

  const deleteDomain = async (domain: Domain) => {
    setDeletingId(domain.id)
    try {
      const response = await fetch("/api/sandbox/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "delete",
          domain: domain.domain,
          domainId: domain.id,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Delete failed")
      setDomains((current) => current.filter((item) => item.id !== domain.id))
      setDeleteTarget(null)
      toast.success("Domain deleted")
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Delete failed")
    } finally {
      setDeletingId(null)
    }
  }

  const openDns = async (domain: Domain) => {
    setDnsTarget(domain)
    setFetchingDns(true)
    try {
      const response = await fetch("/api/sandbox/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          emailDriver: driver.id,
          action: "get",
          domain: domain.domain,
          domainId: domain.id,
        }),
      })
      const data = await response.json()
      if (!response.ok || !data.ok) throw new Error(data.error || "Failed to fetch domain")
      const fresh = mergeDomain(domain, data.domain as Domain)
      setDnsTarget(fresh)
      setDomains((current) => current.map((item) => (item.id === fresh.id ? mergeDomain(item, fresh) : item)))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to fetch domain")
    } finally {
      setFetchingDns(false)
    }
  }

  return (
    <SidebarSection
      title="Domains"
      icon={<Globe2 className="size-3" />}
      count={domains.length}
      defaultOpen={false}
      onOpen={() => {
        if (!hasLoaded && !loading) load()
      }}
      trailing={
        <>
          <Button variant="ghost" size="icon-xs" onClick={load} disabled={loading || !driver.ready} title="Refresh">
            <RefreshCcw className={cn("size-3", loading && "animate-spin")} />
          </Button>
          <Button variant="outline" size="xs" onClick={() => setCreateOpen(true)} disabled={!driver.ready}>
            <Plus className="size-3" />
            Add
          </Button>
        </>
      }
    >
      <DomainList
        loading={loading}
        hasLoaded={hasLoaded}
        domains={domains}
        onView={openDns}
        onDelete={(domain) => setDeleteTarget(domain)}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add domain</DialogTitle>
            <DialogDescription>Enter the domain you want to configure for sending.</DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && addDomain()}
            placeholder="example.com"
            className="text-xs"
            autoFocus
          />
          <DialogFooter>
            <Button onClick={addDomain} disabled={adding || !newName.trim()} size="sm">
              {adding ? "Adding…" : "Add domain"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete domain</DialogTitle>
            <DialogDescription>
              Delete{" "}
              <span className="font-mono font-medium text-foreground">{deleteTarget?.domain}</span>? This cannot be
              undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="destructive"
              size="sm"
              disabled={deletingId === deleteTarget?.id}
              onClick={() => deleteTarget && deleteDomain(deleteTarget)}
            >
              <Trash2 className="size-3" />
              {deletingId === deleteTarget?.id ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!dnsTarget} onOpenChange={(open) => !open && setDnsTarget(null)}>
        <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">{dnsTarget?.domain}</DialogTitle>
            <DialogDescription>DNS records required to verify this domain.</DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
            <ShieldCheck className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 text-xs text-muted-foreground">
              {dnsTarget?.verification?.checkedAt ? (
                <>
                  Last checked <TimeAgo date={dnsTarget.verification.checkedAt} />
                </>
              ) : (
                "Not yet verified"
              )}
            </span>
            <Button
              variant="outline"
              size="xs"
              disabled={verifyingId === dnsTarget?.id}
              onClick={() => dnsTarget && verifyDomain(dnsTarget)}
            >
              <RefreshCcw className={cn("size-3", verifyingId === dnsTarget?.id && "animate-spin")} />
              {verifyingId === dnsTarget?.id ? "Checking…" : "Re-verify"}
            </Button>
          </div>

          {(dnsTarget?.verification?.records ?? []).length > 0 ? (
            <div className="flex flex-col gap-2">
              {dnsTarget!.verification!.records.map((record, index) => (
                <DnsRecordCard key={`${record.type}-${record.name}-${index}`} record={record} />
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {fetchingDns || verifyingId === dnsTarget?.id
                ? "Fetching DNS records…"
                : "No DNS records found. Click Re-verify."}
            </p>
          )}

          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </SidebarSection>
  )
}

function DomainList({
  loading,
  hasLoaded,
  domains,
  onView,
  onDelete,
}: {
  loading: boolean
  hasLoaded: boolean
  domains: Domain[]
  onView: (domain: Domain) => void
  onDelete: (domain: Domain) => void
}) {
  if (loading && domains.length === 0) {
    return <p className="px-3 py-3 text-center text-[10px] text-muted-foreground">Loading…</p>
  }

  if (hasLoaded && domains.length === 0) {
    return <p className="px-3 py-3 text-center text-[10px] text-muted-foreground">No domains configured.</p>
  }

  if (!hasLoaded && domains.length === 0) {
    return null
  }

  return (
    <Table className="text-xs">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-7 px-3 text-[10px] uppercase tracking-wider text-muted-foreground">Domain</TableHead>
          <TableHead className="h-7 px-3 text-[10px] uppercase tracking-wider text-muted-foreground">Status</TableHead>
          <TableHead className="h-7 w-20 px-1" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {domains.map((domain) => (
          <TableRow key={domain.id} className="hover:bg-muted/30">
            <TableCell className="px-3 py-1.5">
              <span className="font-mono text-xs">{domain.domain}</span>
              {domain.region && <span className="ml-1.5 text-[10px] text-muted-foreground">{domain.region}</span>}
            </TableCell>
            <TableCell className="px-3 py-1.5">
              <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", STATUS_STYLE[domain.status] ?? STATUS_STYLE.unknown)}>
                {domain.status}
              </span>
            </TableCell>
            <TableCell className="px-1 py-1.5">
              <div className="flex items-center justify-end gap-0.5">
                <Button variant="ghost" size="icon-xs" title="DNS records" onClick={() => onView(domain)}>
                  <FileText className="size-3.5" />
                </Button>
                <Button variant="ghost" size="icon-xs" title="Delete" onClick={() => onDelete(domain)}>
                  <Trash2 className="size-3.5 text-destructive" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function DnsRecordCard({ record }: { record: DomainDNSRecord }) {
  return (
    <div className="rounded-lg border bg-background/50 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {record.type}
        </span>
        {record.purpose && <span className="text-[10px] text-muted-foreground">{record.purpose}</span>}
        {record.priority !== undefined && (
          <span className="text-[10px] text-muted-foreground">pri: {record.priority}</span>
        )}
        {record.verified !== undefined && (
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium",
              record.verified ? "bg-success/15 text-success" : "bg-orange-500/15 text-orange-500",
            )}
          >
            {record.verified ? <Check className="size-2.5" /> : <TriangleAlert className="size-2.5" />}
            {record.verified ? "verified" : "pending"}
          </span>
        )}
      </div>
      <CopyableField label="Name" value={record.name} />
      <CopyableField label="Value" value={record.value} />
    </div>
  )
}

function CopyableField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground/60">{label}</span>
        <button onClick={copy} className="text-muted-foreground/40 transition-colors hover:text-foreground">
          <Copy className="size-2.5" />
        </button>
        {copied && <span className="text-[10px] text-success">copied</span>}
      </div>
      <p className="break-all font-mono text-[10px] leading-relaxed text-foreground">{value}</p>
    </div>
  )
}

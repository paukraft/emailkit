import { useCallback, useEffect, useRef, useState } from "react";
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiGlobalLine,
  RiAddLine,
  RiRefreshLine,
  RiShieldCheckLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiMore2Fill,
  RiFileListLine,
  RiCheckLine,
  RiAlertLine,
} from "@remixicon/react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type {
  SandboxProviderId,
  SandboxProviderInfo,
} from "@/lib/sandbox-types";
import type {
  DomainDNSRecord,
  DomainVerification,
  SandboxDomain,
} from "@/lib/sandbox-domain-types";

const hasDnsRecords = (domain: SandboxDomain | null | undefined) =>
  (domain?.verification?.records?.length ?? 0) > 0;

const mergeDomain = (
  current: SandboxDomain | undefined,
  incoming: SandboxDomain,
): SandboxDomain => {
  if (!current || hasDnsRecords(incoming) || !hasDnsRecords(current))
    return incoming;

  return {
    ...incoming,
    verification: incoming.verification
      ? {
          ...current.verification,
          ...incoming.verification,
          records: current.verification!.records,
        }
      : current.verification,
  };
};

const mergeDomains = (current: SandboxDomain[], incoming: SandboxDomain[]) => {
  const currentById = new Map(current.map((domain) => [domain.id, domain]));
  return incoming.map((domain) =>
    mergeDomain(currentById.get(domain.id), domain),
  );
};

export function DomainsPanel({
  provider,
  selectedProvider,
}: {
  provider: SandboxProviderInfo;
  selectedProvider: SandboxProviderId;
}) {
  const [open, setOpen] = useState(false);
  const [domains, setDomains] = useState<SandboxDomain[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Dialog states
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [adding, setAdding] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<SandboxDomain | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const [dnsTarget, setDnsTarget] = useState<SandboxDomain | null>(null);
  const [fetchingDns, setFetchingDns] = useState(false);
  const [verifyingId, setVerifyingId] = useState<string | null>(null);

  useEffect(() => {
    setDomains([]);
    setError("");
  }, [selectedProvider]);

  const loadDomains = useCallback(async () => {
    if (!provider.capabilities.domains || !provider.ready) return;
    setLoading(true);
    setError("");
    try {
      const res = await fetch(
        `/api/sandbox/domains?provider=${selectedProvider}`,
      );
      const data = await res.json();
      if (!res.ok || !data.ok)
        throw new Error(data.error || "Failed to load domains");
      setDomains((prev) => mergeDomains(prev, data.domains as SandboxDomain[]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load domains");
    } finally {
      setLoading(false);
    }
  }, [selectedProvider, provider.capabilities.domains, provider.ready]);

  useEffect(() => {
    if (open) void loadDomains();
  }, [open, loadDomains]);

  const addDomain = async () => {
    if (!newName.trim()) return;
    setAdding(true);
    setError("");
    try {
      const res = await fetch("/api/sandbox/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          action: "create",
          name: newName.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok)
        throw new Error(data.error || "Failed to add domain");
      const created = data.domain as SandboxDomain;
      setDomains((prev) => [
        mergeDomain(
          prev.find((domain) => domain.id === created.id),
          created,
        ),
        ...prev.filter((domain) => domain.id !== created.id),
      ]);
      setNewName("");
      setCreateOpen(false);
      void loadDomains();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to add domain");
    } finally {
      setAdding(false);
    }
  };

  const verifyDomain = async (domain: SandboxDomain) => {
    setVerifyingId(domain.id);
    setError("");
    try {
      const res = await fetch("/api/sandbox/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          action: "verify",
          identifier: { domain: domain.name, domainId: domain.id },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok)
        throw new Error(data.error || "Verification failed");
      const verification = data.verification as DomainVerification;
      setDomains((prev) =>
        prev.map((d) => (d.id === domain.id ? { ...d, verification } : d)),
      );
      // Update dnsTarget if it's the same domain so the dialog reflects new data
      setDnsTarget((prev) =>
        prev?.id === domain.id ? { ...prev, verification } : prev,
      );
      void loadDomains();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Verification failed");
    } finally {
      setVerifyingId(null);
    }
  };

  const deleteDomain = async (domain: SandboxDomain) => {
    setDeletingId(domain.id);
    setError("");
    try {
      const res = await fetch("/api/sandbox/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          action: "delete",
          identifier: { domain: domain.name, domainId: domain.id },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || "Delete failed");
      setDomains((prev) => prev.filter((d) => d.id !== domain.id));
      setDeleteTarget(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  };

  const fetchDomain = async (domain: SandboxDomain) => {
    setFetchingDns(true);
    try {
      const res = await fetch("/api/sandbox/domains", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: selectedProvider,
          action: "get",
          identifier: { domain: domain.name, domainId: domain.id },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok)
        throw new Error(data.error || "Failed to fetch domain");
      const fresh = mergeDomain(domain, data.domain as SandboxDomain);
      setDnsTarget(fresh);
      setDomains((prev) =>
        prev.map((d) => (d.id === fresh.id ? mergeDomain(d, fresh) : d)),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch domain");
    } finally {
      setFetchingDns(false);
    }
  };

  const openDnsDialog = (domain: SandboxDomain, autoVerify: boolean) => {
    setDnsTarget(domain);
    void fetchDomain(domain);
    if (autoVerify) void verifyDomain(domain);
  };

  if (!provider.capabilities.domains) return null;

  return (
    <>
      <button
        onClick={() => setOpen(!open)}
        className="flex h-9 items-center gap-1.5 border-b px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {open ? (
          <RiArrowDownSLine className="size-3.5" />
        ) : (
          <RiArrowRightSLine className="size-3.5" />
        )}
        <RiGlobalLine className="size-3" />
        Domains
        {domains.length > 0 && (
          <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground/60">
            {domains.length}
          </span>
        )}
      </button>

      {open && (
        <div className="flex flex-col border-b scrollbar-thin">
          {/* Header bar */}
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
              {loading
                ? "Loading\u2026"
                : `${domains.length} domain${domains.length === 1 ? "" : "s"}`}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={loadDomains}
                disabled={loading}
              >
                <RiRefreshLine
                  className={cn("size-3", loading && "animate-spin")}
                />
              </Button>
              <Button
                variant="outline"
                size="xs"
                onClick={() => setCreateOpen(true)}
              >
                <RiAddLine className="size-3" />
                Add
              </Button>
            </div>
          </div>

          {error && (
            <p className="px-3 pb-2 font-mono text-[10px] text-destructive">
              {error}
            </p>
          )}

          {/* Domains table */}
          {domains.length > 0 && (
            <Table className="text-xs">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="h-7 px-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Domain
                  </TableHead>
                  <TableHead className="h-7 px-3 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Status
                  </TableHead>
                  <TableHead className="h-7 w-8 px-1" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((domain) => (
                  <DomainRow
                    key={domain.id}
                    domain={domain}
                    onOpenDns={() => openDnsDialog(domain, false)}
                    onVerify={() => openDnsDialog(domain, true)}
                    onDelete={() => setDeleteTarget(domain)}
                  />
                ))}
              </TableBody>
            </Table>
          )}

          {domains.length === 0 && !loading && (
            <p className="px-3 pb-3 text-center text-[10px] text-muted-foreground">
              No domains configured.
            </p>
          )}
        </div>
      )}

      {/* Create domain dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Add Domain</DialogTitle>
            <DialogDescription>
              Enter the domain name you want to configure for sending.
            </DialogDescription>
          </DialogHeader>
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addDomain()}
            placeholder="example.com"
            className="text-xs"
            autoFocus
          />
          <DialogFooter>
            <Button
              onClick={addDomain}
              disabled={adding || !newName.trim()}
              size="sm"
            >
              {adding ? "Adding\u2026" : "Add Domain"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation alert dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete domain</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-mono font-medium text-foreground">
                {deleteTarget?.name}
              </span>
              ? This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deletingId === deleteTarget?.id}
              onClick={() => deleteTarget && deleteDomain(deleteTarget)}
            >
              <RiDeleteBinLine className="size-3.5" />
              {deletingId === deleteTarget?.id ? "Deleting\u2026" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* DNS Records dialog */}
      <Dialog open={!!dnsTarget} onOpenChange={(o) => !o && setDnsTarget(null)}>
        <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="font-mono text-sm">
              {dnsTarget?.name}
            </DialogTitle>
            <DialogDescription>
              DNS records required for this domain.
            </DialogDescription>
          </DialogHeader>

          {/* Reverify banner */}
          <div className="flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
            <RiShieldCheckLine className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex-1 text-xs text-muted-foreground">
              {dnsTarget?.verification?.checkedAt
                ? `Last checked ${new Date(dnsTarget.verification.checkedAt).toLocaleString()}`
                : "Records not yet verified"}
            </span>
            <Button
              variant="outline"
              size="xs"
              disabled={verifyingId === dnsTarget?.id}
              onClick={() => dnsTarget && verifyDomain(dnsTarget)}
            >
              <RiRefreshLine
                className={cn(
                  "size-3",
                  verifyingId === dnsTarget?.id && "animate-spin",
                )}
              />
              {verifyingId === dnsTarget?.id ? "Checking\u2026" : "Re-verify"}
            </Button>
          </div>

          {/* Records */}
          {(dnsTarget?.verification?.records ?? []).length > 0 ? (
            <div className="flex flex-col gap-2">
              {dnsTarget!.verification!.records.map((record, i) => (
                <DNSRecordCard
                  key={`${record.name}-${record.type}-${i}`}
                  record={record}
                />
              ))}
            </div>
          ) : (
            <p className="py-4 text-center text-xs text-muted-foreground">
              {fetchingDns || verifyingId === dnsTarget?.id
                ? "Fetching DNS records\u2026"
                : "No DNS records found. Click Re-verify to check again."}
            </p>
          )}

          <DialogFooter showCloseButton />
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Sub-components ──

const DOMAIN_STATUS_STYLE: Record<string, string> = {
  verified: "bg-success/15 text-success",
  active: "bg-success/15 text-success",
  pending: "bg-orange-500/15 text-orange-500",
  unverified: "bg-secondary text-muted-foreground",
  disabled: "bg-destructive/15 text-destructive",
};

function DomainRow({
  domain,
  onOpenDns,
  onVerify,
  onDelete,
}: {
  domain: SandboxDomain;
  onOpenDns: () => void;
  onVerify: () => void;
  onDelete: () => void;
}) {
  const statusStyle =
    DOMAIN_STATUS_STYLE[domain.status] ?? DOMAIN_STATUS_STYLE.unverified;

  return (
    <TableRow>
      <TableCell className="px-3 py-1.5">
        <span className="font-mono text-xs">{domain.name}</span>
        {domain.region && (
          <span className="ml-1.5 text-[10px] text-muted-foreground">
            {domain.region}
          </span>
        )}
      </TableCell>
      <TableCell className="px-3 py-1.5">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium",
            statusStyle,
          )}
        >
          {domain.status}
        </span>
      </TableCell>
      <TableCell className="px-1 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-xs" />}
          >
            <RiMore2Fill className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="bottom">
            <DropdownMenuItem onClick={onOpenDns}>
              <RiFileListLine className="size-3.5" />
              DNS Records
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onVerify}>
              <RiShieldCheckLine className="size-3.5" />
              Verify DNS Records
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <RiDeleteBinLine className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

function DNSRecordCard({ record }: { record: DomainDNSRecord }) {
  const [copied, setCopied] = useState<"name" | "value" | null>(null);

  const copy = (text: string, field: "name" | "value") => {
    navigator.clipboard.writeText(text);
    setCopied(field);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="rounded-lg border bg-background/50 px-3 py-2">
      <div className="flex items-center gap-1.5">
        <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
          {record.type}
        </span>
        {record.purpose && (
          <span className="text-[10px] text-muted-foreground">
            {record.purpose}
          </span>
        )}
        {record.priority !== undefined && (
          <span className="text-[10px] text-muted-foreground">
            pri: {record.priority}
          </span>
        )}
        {record.verified !== undefined && (
          <span
            className={cn(
              "ml-auto inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium",
              record.verified
                ? "bg-success/15 text-success"
                : "bg-orange-500/15 text-orange-500",
            )}
          >
            {record.verified ? (
              <RiCheckLine className="size-2.5" />
            ) : (
              <RiAlertLine className="size-2.5" />
            )}
            {record.verified ? "verified" : "pending"}
          </span>
        )}
      </div>
      <CopyableField
        label="Name"
        value={record.name}
        copied={copied === "name"}
        onCopy={() => copy(record.name, "name")}
      />
      <CopyableField
        label="Value"
        value={record.value}
        copied={copied === "value"}
        onCopy={() => copy(record.value, "value")}
      />
    </div>
  );
}

function CopyableField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-1">
        <span className="text-[10px] text-muted-foreground/60">{label}</span>
        <button
          onClick={onCopy}
          className="text-muted-foreground/40 transition-colors hover:text-foreground"
        >
          <RiFileCopyLine className="size-2.5" />
        </button>
        {copied && <span className="text-[10px] text-success">copied</span>}
      </div>
      <p className="break-all font-mono text-[10px] leading-relaxed text-foreground">
        {value}
      </p>
    </div>
  );
}

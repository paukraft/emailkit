"use client"

import { AlertOctagon, CircleDot, Search, Tag, X } from "lucide-react"
import { useDeferredValue, useEffect, useMemo, useState } from "react"

import { Button } from "@/components/ui/button"
import {
  Filters,
  type AppliedFilter,
  type FilterFieldDef,
} from "@/components/ui/filters"
import { cn } from "@/lib/utils"
import {
  dotColor,
  eventLabel,
  extractFrom,
  hasError,
  kindColor,
  matchesQuery,
  STATUS_STYLE,
  traceDuration,
} from "../sandbox/trace-helpers"
import { TimeAgo } from "./time-ago"
import type { SandboxEventCategory, SandboxTrace } from "../sandbox/types"

const CATEGORY_OPTIONS: { value: SandboxEventCategory; label: string }[] = [
  { value: "send", label: "Send" },
  { value: "hook", label: "Hook" },
  { value: "webhook", label: "Webhook" },
  { value: "domain", label: "Domain" },
  { value: "mailbox", label: "Mailbox" },
  { value: "tool", label: "Tool" },
  { value: "system", label: "System" },
]

const STATUS_OPTIONS = [
  { value: "delivered", label: "Delivered" },
  { value: "opened", label: "Opened" },
  { value: "clicked", label: "Clicked" },
  { value: "bounced", label: "Bounced" },
  { value: "rejected", label: "Rejected" },
  { value: "complained", label: "Complained" },
]

const FILTER_FIELDS: FilterFieldDef[] = [
  {
    id: "category",
    label: "Category",
    icon: <Tag />,
    options: CATEGORY_OPTIONS,
  },
  {
    id: "status",
    label: "Status",
    icon: <CircleDot />,
    options: STATUS_OPTIONS,
  },
  {
    id: "errors",
    label: "Errors",
    icon: <AlertOctagon />,
    options: [
      { value: "errored", label: "Errored only" },
      { value: "clean", label: "Clean only" },
    ],
  },
]

type FilterState = {
  query: string
  applied: AppliedFilter[]
}

const DEFAULT_FILTERS: FilterState = { query: "", applied: [] }

const matchesApplied = (trace: SandboxTrace, applied: AppliedFilter[]) => {
  for (const filter of applied) {
    if (filter.values.length === 0) continue
    const matched = matchesField(trace, filter)
    if (filter.operator === "include" ? !matched : matched) return false
  }
  return true
}

const matchesField = (trace: SandboxTrace, filter: AppliedFilter) => {
  if (filter.field === "category") {
    return trace.events.some((event) => filter.values.includes(event.category))
  }
  if (filter.field === "status") {
    return trace.events.some((event) => {
      const kind = event.kind.toLowerCase()
      return filter.values.some((value) => kind.includes(value))
    })
  }
  if (filter.field === "errors") {
    const errored = hasError(trace)
    return filter.values.some((value) =>
      value === "errored" ? errored : !errored,
    )
  }
  return true
}

export function TraceList({
  traces,
  selectedDriver,
  selectedTraceId,
  onSelectTrace,
}: {
  traces: SandboxTrace[]
  selectedDriver: string
  selectedTraceId: string | null
  onSelectTrace: (id: string | null) => void
}) {
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS)
  const deferredQuery = useDeferredValue(filters.query)

  const driverTraces = useMemo(
    () => traces.filter((trace) => trace.driver === selectedDriver),
    [selectedDriver, traces],
  )

  const filtered = useMemo(
    () =>
      driverTraces.filter((trace) => {
        if (!matchesApplied(trace, filters.applied)) return false
        return matchesQuery(trace, deferredQuery.trim())
      }),
    [deferredQuery, driverTraces, filters.applied],
  )

  useEffect(() => {
    if (filtered.length === 0) {
      onSelectTrace(null)
      return
    }
    if (!selectedTraceId || !filtered.some((trace) => trace.id === selectedTraceId)) {
      onSelectTrace(filtered[0].id)
    }
  }, [filtered, onSelectTrace, selectedTraceId])

  const hasActive = filters.query.trim() || filters.applied.length > 0

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex flex-col border-b">
        <div className="flex h-9 items-center gap-2 px-3">
          <Search className="size-3 shrink-0 text-muted-foreground/50" />
          <input
            value={filters.query}
            onChange={(event) => setFilters((current) => ({ ...current, query: event.target.value }))}
            placeholder="Search traces…"
            className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
          />
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {filtered.length}
            {hasActive && <span className="text-muted-foreground/40">/{driverTraces.length}</span>}
          </span>
          {hasActive && (
            <Button variant="ghost" size="icon-xs" onClick={() => setFilters(DEFAULT_FILTERS)}>
              <X className="size-3.5" />
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1.5 px-3 pb-2">
          <Filters
            fields={FILTER_FIELDS}
            value={filters.applied}
            onChange={(next) => setFilters((current) => ({ ...current, applied: next }))}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {driverTraces.length === 0 ? (
          <Empty message="No traces yet. Send a test email or point a provider webhook at the sandbox routes." />
        ) : filtered.length === 0 ? (
          <Empty message="No traces match filters." />
        ) : (
          <div className="flex flex-col">
            {filtered.map((trace) => (
              <TraceRow
                key={trace.id}
                trace={trace}
                selected={selectedTraceId === trace.id}
                onSelect={() => onSelectTrace(trace.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Empty({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <p className="max-w-[240px] text-center text-xs leading-relaxed text-muted-foreground">{message}</p>
    </div>
  )
}

function TraceRow({
  trace,
  selected,
  onSelect,
}: {
  trace: SandboxTrace
  selected: boolean
  onSelect: () => void
}) {
  const lead = trace.events.find((event) => event.category === "send" || event.category === "hook") ?? trace.events[0]
  const from = extractFrom(lead)
  const { recipient, subject, status } = trace.correlation
  const errored = hasError(trace)
  const leadKind = lead?.kind ?? trace.summary

  return (
    <button
      onClick={onSelect}
      className={cn(
        "group/row relative flex flex-col gap-1.5 border-b px-3 py-2.5 text-left transition-colors",
        selected ? "bg-secondary/70" : "hover:bg-secondary/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 w-[2px] origin-center transition-transform duration-200 ease-[var(--ease-out)]",
          selected ? "scale-y-100" : "scale-y-0",
          errored ? "bg-destructive" : "bg-foreground",
        )}
      />

      <div className="flex items-center gap-2 text-xs">
        <span className={cn("inline-flex shrink-0 items-center gap-1 font-medium", kindColor(leadKind))}>
          <span className={cn("size-1.5 rounded-full", dotColor(leadKind))} />
          {eventLabel(leadKind)}
        </span>
        {status && (
          <span
            className={cn(
              "shrink-0 rounded px-1 py-px font-mono text-[10px] uppercase tracking-wider",
              STATUS_STYLE[status] ?? "bg-secondary text-muted-foreground",
            )}
          >
            {status}
          </span>
        )}
        <div className="flex-1" />
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/70">
          <TimeAgo date={trace.updatedAt} />
        </span>
      </div>

      {subject ? (
        <p className="truncate text-[12px] leading-snug font-medium text-foreground">{subject}</p>
      ) : (
        <p className="truncate text-[12px] font-medium text-foreground">{trace.summary}</p>
      )}

      {(from || recipient) && (
        <div className="flex min-w-0 items-center gap-1 truncate font-mono text-[10px] text-muted-foreground">
          {from && <span className="truncate">{from}</span>}
          {from && recipient && <span className="shrink-0 text-muted-foreground/40">→</span>}
          {recipient && <span className="truncate">{recipient}</span>}
        </div>
      )}

      <EventRibbon trace={trace} />
    </button>
  )
}

function EventRibbon({ trace }: { trace: SandboxTrace }) {
  const start = new Date(trace.startedAt).getTime()
  const span = Math.max(1, traceDuration(trace))
  const events = trace.events

  return (
    <div className="mt-0.5 flex items-center gap-2">
      <div className="relative h-3 flex-1">
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {events.map((event) => {
          const offset = new Date(event.timestamp).getTime() - start
          const pct = events.length === 1 ? 0 : Math.min(100, Math.max(0, (offset / span) * 100))
          return (
            <span
              key={event.id}
              className={cn(
                "absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background",
                dotColor(event.kind),
              )}
              style={{ left: `${pct}%` }}
              title={eventLabel(event.kind)}
            />
          )
        })}
      </div>
      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground/60">
        {events.length}
      </span>
    </div>
  )
}


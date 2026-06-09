"use client"

import { Check, ChevronDown, ChevronRight, Copy } from "lucide-react"
import { useMemo, useState } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  dotColor,
  eventLabel,
  formatFacts,
  formatOffset,
  kindColor,
  STATUS_STYLE,
  traceDuration,
} from "../sandbox/trace-helpers"
import type { SandboxEvent, SandboxTrace } from "../sandbox/types"
import { JsonViewer } from "./json-viewer"

export function TraceInspector({ trace }: { trace: SandboxTrace }) {
  return <TraceInspectorContent key={trace.id} trace={trace} />
}

function TraceInspectorContent({ trace }: { trace: SandboxTrace }) {
  const [allExpanded, setAllExpanded] = useState(false)
  const [version, setVersion] = useState(0)

  const start = useMemo(() => new Date(trace.startedAt).getTime(), [trace.startedAt])
  const duration = traceDuration(trace)
  const subject = trace.correlation.subject ?? trace.summary
  const { recipient, messageId, providerId, status } = trace.correlation

  return (
    <div className="flex h-full flex-col">
      <header className="border-b">
        <div className="px-4 pt-3 pb-3">
          <div className="flex items-start gap-2">
            <p className="flex-1 text-[13px] leading-snug font-medium text-foreground">{subject}</p>
            {status && (
              <span
                className={cn(
                  "shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider",
                  STATUS_STYLE[status] ?? "bg-secondary text-muted-foreground",
                )}
              >
                {status}
              </span>
            )}
          </div>
          <dl className="mt-2.5 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[11px]">
            <Field label="trace" value={trace.id} mono truncate />
            {recipient && <Field label="to" value={recipient} mono />}
            {messageId && <Field label="msg" value={messageId} mono truncate />}
            {providerId && <Field label="provider" value={providerId} mono truncate />}
          </dl>
        </div>
        <div className="flex h-8 items-center gap-3 border-t bg-muted/30 px-4 font-mono text-[10px] tabular-nums text-muted-foreground">
          <span>
            <span className="text-foreground/70">{trace.events.length}</span> event
            {trace.events.length === 1 ? "" : "s"}
          </span>
          <span className="text-border">·</span>
          <span>{duration > 0 ? `${duration}ms span` : "instant"}</span>
          <div className="flex-1" />
          <button
            onClick={() => {
              setAllExpanded((current) => !current)
              setVersion((v) => v + 1)
            }}
            className="uppercase tracking-wider transition-[color,transform] duration-150 ease-out hover:text-foreground active:scale-[0.97]"
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scrollbar-thin">
        <ol className="relative px-4 py-4">
          <span
            aria-hidden
            className="pointer-events-none absolute top-6 bottom-6 left-8 w-px -translate-x-1/2 bg-gradient-to-b from-transparent via-border to-transparent"
          />
          {trace.events.map((event, index) => (
            <EventNode
              key={`${event.id}-${version}`}
              event={event}
              offsetMs={new Date(event.timestamp).getTime() - start}
              index={index}
              defaultOpen={allExpanded}
            />
          ))}
        </ol>
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  mono,
  truncate,
}: {
  label: string
  value: string
  mono?: boolean
  truncate?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }
  return (
    <div className="contents group/field">
      <dt className="self-center text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <span
          className={cn(
            "min-w-0 text-foreground",
            mono && "font-mono text-[11px]",
            truncate && "truncate",
          )}
          title={value}
        >
          {value}
        </span>
        <button
          onClick={copy}
          className="shrink-0 text-muted-foreground/40 opacity-0 transition-[color,opacity,transform] duration-150 ease-[var(--ease-out)] hover:text-foreground active:scale-90 group-hover/field:opacity-100"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
        </button>
      </dd>
    </div>
  )
}

function EventNode({
  event,
  offsetMs,
  index,
  defaultOpen,
}: {
  event: SandboxEvent
  offsetMs: number
  index: number
  defaultOpen: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  const facts = formatFacts(event)
  const hasPayload = event.details != null

  return (
    <li className={cn("relative pl-10", index > 0 && "pt-3")}>
      <span
        aria-hidden
        className={cn(
          "absolute top-[7px] left-4 size-2.5 -translate-x-1/2 rounded-full ring-4 ring-background",
          dotColor(event.kind),
        )}
      />
      <div className="flex flex-col">
        <div className="flex items-baseline gap-2">
          <span className={cn("text-xs font-medium", kindColor(event.kind))}>
            {eventLabel(event.kind)}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground/60">{event.kind}</span>
          <div className="flex-1" />
          <Tooltip>
            <TooltipTrigger
              render={
                <time className="cursor-default font-mono text-[10px] tabular-nums text-muted-foreground/70">
                  {formatOffset(offsetMs)}
                </time>
              }
            />
            <TooltipContent>
              <span className="font-mono text-[10px]">
                {new Date(event.timestamp).toLocaleTimeString()} · {new Date(event.timestamp).toLocaleDateString()}
              </span>
            </TooltipContent>
          </Tooltip>
        </div>

        {event.summary && event.summary !== event.kind && (
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{event.summary}</p>
        )}

        {facts.length > 0 && (
          <dl className="mt-2 grid grid-cols-[58px_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-dashed bg-muted/25 px-2.5 py-1.5 text-[11px]">
            {facts.map((fact) => (
              <Fact key={fact.label} label={fact.label} value={fact.value} />
            ))}
          </dl>
        )}

        {hasPayload && (
          <div className="mt-2">
            <button
              onClick={() => setOpen((current) => !current)}
              className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground/70 transition-[color,transform] duration-150 ease-out hover:text-foreground active:scale-[0.97]"
            >
              {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
              Payload
            </button>
            {open && <JsonViewer value={event.details} className="mt-1.5" />}
          </div>
        )}
      </div>
    </li>
  )
}

function Fact({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }
  return (
    <div className="contents group/fact">
      <dt className="self-center text-[10px] uppercase tracking-wider text-muted-foreground/70">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate font-mono text-foreground" title={value}>
          {value}
        </span>
        <button
          onClick={copy}
          className="shrink-0 text-muted-foreground/40 opacity-0 transition-[color,opacity,transform] duration-150 ease-[var(--ease-out)] hover:text-foreground active:scale-90 group-hover/fact:opacity-100"
          aria-label={`Copy ${label}`}
        >
          {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
        </button>
      </dd>
    </div>
  )
}

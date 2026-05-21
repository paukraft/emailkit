import { type Dispatch, type SetStateAction, useDeferredValue, useEffect, useMemo, useState } from "react";
import {
  RiSearchLine,
  RiCloseLine,
  RiRobotLine,
  RiLinkM,
} from "@remixicon/react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { EventIcon } from "./event-icon";
import { FilterSelect } from "./form-primitives";
import type { SandboxProviderId, SandboxTrace } from "@/lib/sandbox-types";
import {
  type TraceFilters,
  DEFAULT_TRACE_FILTERS,
  eventLabel,
  eventIconKey,
  kindColor,
  kindDotColor,
  getBotDetection,
  matchesTraceQuery,
  hasTraceError,
  getRecencyCutoff,
  extractFrom,
} from "@/lib/trace-helpers";

export function TraceList({
  traces,
  selectedProvider,
  selectedTraceId,
  onSelectTrace,
}: {
  traces: SandboxTrace[];
  selectedProvider: SandboxProviderId;
  selectedTraceId: string | null;
  onSelectTrace: Dispatch<SetStateAction<string | null>>;
}) {
  const [traceFilters, setTraceFilters] = useState<TraceFilters>(DEFAULT_TRACE_FILTERS);
  const deferredQuery = useDeferredValue(traceFilters.query);

  const providerTraces = useMemo(
    () => traces.filter((t) => t.provider === selectedProvider),
    [selectedProvider, traces],
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
    const query = deferredQuery.trim().toLowerCase();
    const recencyCutoff = getRecencyCutoff(traceFilters.recency);
    return providerTraces.filter((trace) => {
      if (traceFilters.category !== "all" && !trace.events.some((e) => e.category === traceFilters.category))
        return false;
      if (traceFilters.kind !== "all" && !trace.events.some((e) => e.kind === traceFilters.kind))
        return false;
      if (traceFilters.status !== "all" && trace.correlation.status !== traceFilters.status)
        return false;
      if (traceFilters.errorsOnly && !hasTraceError(trace)) return false;
      if (recencyCutoff !== null && new Date(trace.updatedAt).getTime() < recencyCutoff)
        return false;
      return matchesTraceQuery(trace, query);
    });
  }, [deferredQuery, providerTraces, traceFilters]);

  useEffect(() => {
    if (!filteredTraces.length) return onSelectTrace(null);
    onSelectTrace((c) =>
      c && filteredTraces.some((t) => t.id === c) ? c : (filteredTraces[0]?.id ?? null),
    );
  }, [filteredTraces, onSelectTrace]);

  const setFilter = <K extends keyof TraceFilters>(key: K, value: TraceFilters[K]) =>
    setTraceFilters((c) => ({ ...c, [key]: value }));

  const hasActiveFilters =
    traceFilters.query.trim().length > 0 ||
    traceFilters.category !== "all" ||
    traceFilters.kind !== "all" ||
    traceFilters.status !== "all" ||
    traceFilters.recency !== "all" ||
    traceFilters.errorsOnly;

  return (
    <div className="flex flex-1 flex-col min-w-0">
      {/* Search + filters */}
      <div className="flex flex-col border-b">
        <div className="flex h-9 items-center gap-2 px-3">
          <RiSearchLine className="size-3 shrink-0 text-muted-foreground/50" />
          <input
            value={traceFilters.query}
            onChange={(e) => setFilter("query", e.target.value)}
            placeholder="Search traces…"
            className="flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground/40"
          />
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
            {filteredTraces.length}
            {hasActiveFilters && (
              <span className="text-muted-foreground/40">/{providerTraces.length}</span>
            )}
          </span>
          {hasActiveFilters && (
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
            onValueChange={(v) => setFilter("category", v as TraceFilters["category"])}
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
              onValueChange={(v) => setFilter("kind", v)}
              options={[
                { value: "all", label: "Kind" },
                ...traceFilterOptions.eventKinds.map((k) => ({ value: k, label: k })),
              ]}
            />
          )}
          {traceFilterOptions.statuses.length > 0 && (
            <FilterSelect
              value={traceFilters.status}
              onValueChange={(v) => setFilter("status", v)}
              options={[
                { value: "all", label: "Status" },
                ...traceFilterOptions.statuses.map((s) => ({ value: s, label: s })),
              ]}
            />
          )}
          <FilterSelect
            value={traceFilters.recency}
            onValueChange={(v) => setFilter("recency", v as TraceFilters["recency"])}
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
            onPressedChange={(v) => setFilter("errorsOnly", v)}
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
              No traces yet. Send a test email or point a provider webhook at the sandbox routes.
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
                onSelect={() => onSelectTrace(trace.id)}
              />
            ))}
          </div>
        )}
      </div>
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
    trace.events.find((e) => e.category === "hook" || e.category === "send") ?? trace.events[0];
  const leadKind = leadEvent?.kind ?? "";
  const timeline = trace.events.slice(0, 6);
  const hasBot = trace.events.some((e) => getBotDetection(e.details)?.isBot);
  const { recipient, subject, status } = trace.correlation;
  const from = extractFrom(leadEvent?.details);

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
        <div className="flex items-center gap-1.5 text-xs">
          <span className={cn("inline-flex shrink-0 items-center gap-0.5 font-medium", kindColor(leadKind))}>
            <EventIcon iconKey={eventIconKey(leadKind)} className="size-3.5" />
            <span>{eventLabel(leadKind)}</span>
          </span>
          {(from || recipient) && (
            <span className="flex min-w-0 items-center gap-1 truncate font-mono text-muted-foreground">
              {from && <span className="truncate">{from}</span>}
              {from && recipient && <span className="shrink-0">&rarr;</span>}
              {recipient && <span className="truncate">{recipient}</span>}
            </span>
          )}
        </div>
        {subject && (
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{subject}</p>
        )}
        {clickUrl && (
          <p className="mt-0.5 flex items-center gap-1 truncate font-mono text-[10px] text-blue-400">
            <RiLinkM className="size-2.5 shrink-0" />
            <span className="truncate">{clickUrl}</span>
          </p>
        )}
        {!from && !recipient && !subject && (
          <span className="block truncate text-xs font-medium">{trace.summary}</span>
        )}
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
            {[...timeline].reverse().map((ev) => (
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

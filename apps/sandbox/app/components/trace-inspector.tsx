import { useState } from "react";
import {
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiRobotLine,
} from "@remixicon/react";
import { cn } from "@/lib/cn";
import { JsonViewer } from "../json-viewer";
import { EventIcon } from "./event-icon";
import type { SandboxTrace } from "@/lib/sandbox-types";
import {
  eventLabel,
  eventIconKey,
  kindColor,
  getBotDetection,
  getEventFacts,
  extractFrom,
} from "@/lib/trace-helpers";

export function TraceInspector({ trace }: { trace: SandboxTrace }) {
  const { recipient, status } = trace.correlation;
  const subject = trace.correlation.subject;

  const leadEvent =
    trace.events.find((e) => e.category === "hook" || e.category === "send") ?? trace.events[0];
  const from = extractFrom(leadEvent?.details);

  return (
    <div className="flex flex-col">
      {/* Trace header */}
      <div className="border-b px-3 py-2.5">
        {subject ? (
          <p className="text-sm font-medium">{subject}</p>
        ) : (
          <p className="text-sm font-medium text-muted-foreground">{trace.summary}</p>
        )}
        <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {from && <span className="font-mono">{from}</span>}
          {from && recipient && <span className="text-muted-foreground/40">&rarr;</span>}
          {recipient && <span className="font-mono">{recipient}</span>}
          {(from || recipient) && status && <span className="text-muted-foreground/30">&middot;</span>}
          {status && (
            <span
              className={cn(
                "font-mono",
                status === "delivered"
                  ? "text-emerald-500"
                  : status === "bounced" || status === "rejected"
                    ? "text-destructive"
                    : status === "complained"
                      ? "text-orange-500"
                      : "",
              )}
            >
              {status}
            </span>
          )}
        </div>
      </div>

      {/* Events */}
      <div className="flex flex-col divide-y">
        {trace.events.map((event) => (
          <TraceEventNode key={event.id} event={event} />
        ))}
      </div>
    </div>
  );
}

function TraceEventNode({ event }: { event: SandboxTrace["events"][number] }) {
  const [open, setOpen] = useState(event.category === "hook" || event.category === "send");
  const bot = getBotDetection(event.details);
  const facts = getEventFacts(event.kind, event.details);
  const label = eventLabel(event.kind);

  return (
    <div className="cursor-pointer px-3 py-2" onClick={() => setOpen(!open)}>
      <div className="flex w-full items-center gap-1.5">
        <span className={cn("shrink-0", kindColor(event.kind))}>
          <EventIcon iconKey={eventIconKey(event.kind)} className="size-3.5" />
        </span>
        <span className={cn("text-xs font-medium", kindColor(event.kind))}>{label}</span>
        {bot?.isBot && (
          <span
            className="inline-flex shrink-0 items-center gap-0.5 rounded bg-orange-500/15 px-1 py-px text-[10px] font-medium text-orange-500"
            title={`Bot: ${bot.reason}`}
          >
            <RiRobotLine className="size-2.5" />
            bot
          </span>
        )}
        {bot && !bot.isBot && (
          <span className="rounded bg-emerald-500/15 px-1 py-px font-mono text-[10px] text-emerald-500">
            {bot.reason}
          </span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {new Date(event.timestamp).toLocaleTimeString()}
          </span>
          <span className="text-muted-foreground/40">
            {open ? <RiArrowDownSLine className="size-3" /> : <RiArrowRightSLine className="size-3" />}
          </span>
        </span>
      </div>

      {facts.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-5">
          {facts.map((f) => (
            <span key={f.label} className="text-[10px] text-muted-foreground">
              <span className="text-muted-foreground/50">{f.label}</span>{" "}
              <span className="font-mono">{f.value}</span>
            </span>
          ))}
        </div>
      )}

      {open && (
        <div className="mt-2 rounded-lg border bg-background/50 p-2.5" onClick={(e) => e.stopPropagation()}>
          <JsonViewer data={event.details} />
        </div>
      )}
    </div>
  );
}

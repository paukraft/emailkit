"use client";

import { useState, useCallback } from "react";
import { RiArrowDownSLine, RiArrowRightSLine, RiFileCopyLine, RiCheckLine } from "@remixicon/react";
import { cn } from "@/lib/cn";

const AUTO_COLLAPSE_DEPTH = 3;

function isExpandable(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === "object";
}

function childCount(value: Record<string, unknown> | unknown[]): number {
  return Array.isArray(value) ? value.length : Object.keys(value).length;
}

function preview(value: Record<string, unknown> | unknown[]): string {
  if (Array.isArray(value)) {
    const n = value.length;
    return n === 0 ? "[]" : `[${n}]`;
  }
  const keys = Object.keys(value);
  const n = keys.length;
  if (n === 0) return "{}";
  const shown = keys.slice(0, 3).join(", ");
  return `{ ${shown}${n > 3 ? ", …" : ""} }`;
}

// ── Value rendering ──

function StringValue({ value }: { value: string }) {
  const isLong = value.length > 120 || value.includes("\n");
  const [expanded, setExpanded] = useState(false);

  if (!isLong) {
    return <span className="text-green-400">&quot;{value}&quot;</span>;
  }

  const display = expanded ? value : value.slice(0, 80) + "…";

  return (
    <span className="text-green-400">
      &quot;
      <span className="whitespace-pre-wrap break-all">{display}</span>
      &quot;
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
        className="ml-1 rounded px-1 text-[10px] text-muted-foreground hover:text-foreground hover:bg-secondary/60"
      >
        {expanded ? "less" : `${value.length} chars`}
      </button>
    </span>
  );
}

function PrimitiveValue({ value }: { value: unknown }) {
  if (typeof value === "string") return <StringValue value={value} />;
  if (typeof value === "number") return <span className="text-orange-400">{String(value)}</span>;
  if (typeof value === "boolean") return <span className="text-purple-400">{String(value)}</span>;
  if (value === null) return <span className="text-muted-foreground/50 italic">null</span>;
  return <span className="text-muted-foreground">{String(value)}</span>;
}

// ── Expandable node ──

function JsonNode({
  keyName,
  value,
  depth,
  isLast,
}: {
  keyName?: string;
  value: unknown;
  depth: number;
  isLast: boolean;
}) {
  const expandable = isExpandable(value);
  const [open, setOpen] = useState(
    expandable ? depth < AUTO_COLLAPSE_DEPTH && childCount(value) > 0 : false,
  );

  const comma = isLast ? "" : ",";

  // Primitive leaf
  if (!expandable) {
    return (
      <div className="flex hover:bg-secondary/30 -mx-2 px-2 rounded-sm">
        <Indent depth={depth} />
        {keyName !== undefined && <Key name={keyName} />}
        <PrimitiveValue value={value} />
        <Comma value={comma} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries = isArray
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value as Record<string, unknown>);
  const empty = entries.length === 0;
  const openBracket = isArray ? "[" : "{";
  const closeBracket = isArray ? "]" : "}";

  // Empty container
  if (empty) {
    return (
      <div className="flex hover:bg-secondary/30 -mx-2 px-2 rounded-sm">
        <Indent depth={depth} />
        {keyName !== undefined && <Key name={keyName} />}
        <span className="text-muted-foreground/50">{openBracket}{closeBracket}</span>
        <Comma value={comma} />
      </div>
    );
  }

  return (
    <div>
      {/* Header row */}
      <div
        className="flex items-center cursor-pointer group/node hover:bg-secondary/30 -mx-2 px-2 rounded-sm"
        onClick={() => setOpen(!open)}
      >
        <Indent depth={depth} collapse />
        <span className="text-muted-foreground/40 mr-0.5 shrink-0 transition-transform">
          {open
            ? <RiArrowDownSLine className="size-3" />
            : <RiArrowRightSLine className="size-3" />}
        </span>
        {keyName !== undefined && <Key name={keyName} />}
        <span className="text-muted-foreground/50">{openBracket}</span>
        {!open && (
          <>
            <span className="text-muted-foreground/30 ml-1 text-[10px]">
              {preview(value as Record<string, unknown> | unknown[])}
            </span>
            <span className="text-muted-foreground/50">{closeBracket}</span>
            <Comma value={comma} />
          </>
        )}
      </div>
      {/* Children */}
      {open && (
        <>
          {entries.map(([k, v], i) => (
            <JsonNode
              key={k}
              keyName={isArray ? undefined : k}
              value={v}
              depth={depth + 1}
              isLast={i === entries.length - 1}
            />
          ))}
          <div className="flex -mx-2 px-2">
            <Indent depth={depth} />
            <span className="text-muted-foreground/50">{closeBracket}</span>
            <Comma value={comma} />
          </div>
        </>
      )}
    </div>
  );
}

function Key({ name }: { name: string }) {
  return (
    <span className="text-blue-300/80 mr-1 shrink-0">
      {name}<span className="text-muted-foreground/30">: </span>
    </span>
  );
}

function Comma({ value }: { value: string }) {
  if (!value) return null;
  return <span className="text-muted-foreground/30">{value}</span>;
}

function Indent({ depth, collapse }: { depth: number; collapse?: boolean }) {
  if (depth === 0) return null;
  const width = collapse ? depth * 16 - 12 : depth * 16;
  return <span className="shrink-0" style={{ width }} />;
}

// ── Root ──

export function JsonViewer({ data }: { data: unknown }) {
  const [copied, setCopied] = useState(false);

  const copyAll = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [data]);

  return (
    <div className="group/viewer relative">
      <button
        onClick={copyAll}
        className={cn(
          "absolute -top-0.5 right-0 z-10 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono transition-all",
          copied
            ? "bg-success/15 text-success opacity-100"
            : "bg-secondary text-muted-foreground opacity-0 group-hover/viewer:opacity-100 hover:text-foreground",
        )}
      >
        {copied
          ? <><RiCheckLine className="size-2.5" /> copied</>
          : <><RiFileCopyLine className="size-2.5" /> copy</>}
      </button>
      <div className="font-mono text-xs leading-[1.7] overflow-hidden break-all">
        <JsonNode value={data} depth={0} isLast />
      </div>
    </div>
  );
}

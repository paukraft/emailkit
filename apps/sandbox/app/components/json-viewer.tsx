"use client"

import { Check, Copy } from "lucide-react"
import { useMemo, useState } from "react"

import { cn } from "@/lib/utils"

const TOKEN_REGEX = /("(?:\\.|[^"\\])*"(?:\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

function highlight(json: string) {
  return json.replace(TOKEN_REGEX, (match) => {
    if (match.endsWith(":")) {
      return `<span class="text-foreground/80">${match.slice(0, -1)}</span><span class="text-muted-foreground/60">:</span>`
    }
    if (match.startsWith('"')) return `<span class="text-success/90">${match}</span>`
    if (match === "true" || match === "false") return `<span class="text-blue-500/90">${match}</span>`
    if (match === "null") return `<span class="text-muted-foreground/60">${match}</span>`
    return `<span class="text-amber-500/90">${match}</span>`
  })
}

const escape = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

export function JsonViewer({ value, className }: { value: unknown; className?: string }) {
  const [copied, setCopied] = useState(false)

  const raw = useMemo(() => JSON.stringify(value, null, 2), [value])
  const html = useMemo(() => highlight(escape(raw)), [raw])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {}
  }

  return (
    <div
      className={cn(
        "group/json relative overflow-hidden rounded-md border bg-muted/40",
        className,
      )}
    >
      <button
        onClick={copy}
        className="absolute top-1.5 right-1.5 z-10 flex h-5 items-center gap-1 rounded border bg-background/80 px-1.5 text-[10px] uppercase tracking-wider text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground group-hover/json:opacity-100"
      >
        {copied ? <Check className="size-3 text-success" /> : <Copy className="size-3" />}
        {copied ? "Copied" : "Copy"}
      </button>
      <pre
        className="max-h-[420px] overflow-auto p-3 font-mono text-[11px] leading-relaxed text-muted-foreground scrollbar-thin"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  )
}

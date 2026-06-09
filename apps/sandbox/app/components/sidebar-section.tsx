"use client"

import { ChevronDown, ChevronRight } from "lucide-react"
import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

export function SidebarSection({
  title,
  icon,
  count,
  defaultOpen = false,
  trailing,
  onOpen,
  children,
}: {
  title: string
  icon?: ReactNode
  count?: number
  defaultOpen?: boolean
  trailing?: ReactNode
  onOpen?: () => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const measureRef = useRef<HTMLDivElement | null>(null)
  const [contentHeight, setContentHeight] = useState(0)
  const [primed, setPrimed] = useState(false)

  const toggle = () => {
    setOpen((current) => {
      const next = !current
      if (next) onOpen?.()
      return next
    })
  }

  useLayoutEffect(() => {
    const node = measureRef.current
    if (!node) return
    setContentHeight(node.scrollHeight)
    const raf = requestAnimationFrame(() => setPrimed(true))
    const ro = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.height
      if (typeof next === "number") setContentHeight(next)
    })
    ro.observe(node)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return (
    <div className="flex flex-col border-b">
      <div className="flex h-9 items-center border-b">
        <button
          onClick={toggle}
          className="flex h-full flex-1 items-center gap-1.5 px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          {icon}
          <span>{title}</span>
          {count !== undefined && count > 0 && (
            <span className={cn("ml-1 font-mono text-[10px] tabular-nums text-muted-foreground/60")}>{count}</span>
          )}
        </button>
        {trailing && <div className="flex items-center gap-1 pr-2">{trailing}</div>}
      </div>
      <div
        aria-hidden={!open}
        style={{ height: open ? contentHeight : 0 }}
        className={cn(
          "overflow-hidden ease-[var(--ease-out)]",
          primed && "transition-[height,opacity] duration-[220ms]",
          open ? "opacity-100" : "opacity-0",
        )}
      >
        <div ref={measureRef} className="flex flex-col">
          {children}
        </div>
      </div>
    </div>
  )
}

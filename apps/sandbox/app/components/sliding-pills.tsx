"use client"

import { useLayoutEffect, useRef, useState, type ReactNode } from "react"

import { cn } from "@/lib/utils"

type Option<T extends string> = {
  value: T
  label: ReactNode
  title?: string
}

export function SlidingPills<T extends string>({
  options,
  value,
  onChange,
  className,
  size = "sm",
}: {
  options: Option<T>[]
  value: T
  onChange: (next: T) => void
  className?: string
  size?: "sm" | "md"
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null)
  const [primed, setPrimed] = useState(false)

  useLayoutEffect(() => {
    const measure = () => {
      const node = buttonRefs.current[value]
      const container = containerRef.current
      if (!node || !container) return
      const cRect = container.getBoundingClientRect()
      const nRect = node.getBoundingClientRect()
      setIndicator({ x: nRect.left - cRect.left, w: nRect.width })
    }
    measure()
    const id = requestAnimationFrame(() => setPrimed(true))
    const ro = new ResizeObserver(measure)
    if (containerRef.current) ro.observe(containerRef.current)
    return () => {
      cancelAnimationFrame(id)
      ro.disconnect()
    }
  }, [value, options])

  const sizing = size === "sm" ? "p-0.5" : "p-[3px]"
  const btnSizing =
    size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-xs"

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative inline-flex items-center rounded-md bg-secondary",
        sizing,
        className,
      )}
    >
      {indicator && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-0.5 rounded-[5px] bg-background shadow-sm",
            "ease-[var(--ease-out)] [transition-property:transform,width] duration-[220ms]",
            !primed && "opacity-0",
          )}
          style={{
            transform: `translateX(${indicator.x - (size === "sm" ? 2 : 3)}px)`,
            width: indicator.w,
          }}
        />
      )}
      {options.map((option) => {
        const selected = option.value === value
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttonRefs.current[option.value] = node
            }}
            type="button"
            onClick={() => onChange(option.value)}
            title={option.title}
            className={cn(
              "relative z-[1] inline-flex items-center gap-1.5 rounded-[5px] font-medium whitespace-nowrap transition-colors duration-150 ease-[var(--ease-out)]",
              btnSizing,
              selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

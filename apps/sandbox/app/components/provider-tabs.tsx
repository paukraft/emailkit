"use client"

import { useLayoutEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"
import type { SandboxDriverInfo } from "../sandbox/types"

export function ProviderTabs({
  drivers,
  selected,
  onSelect,
}: {
  drivers: SandboxDriverInfo[]
  selected: string
  onSelect: (driver: string) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const buttonRefs = useRef<Record<string, HTMLButtonElement | null>>({})
  const [indicator, setIndicator] = useState<{ x: number; w: number } | null>(null)
  const [primed, setPrimed] = useState(false)

  useLayoutEffect(() => {
    const measure = () => {
      const node = buttonRefs.current[selected]
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
  }, [selected, drivers])

  return (
    <div
      ref={containerRef}
      className="relative inline-flex items-center rounded-md bg-secondary p-0.5"
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
            transform: `translateX(${indicator.x - 2}px)`,
            width: indicator.w,
          }}
        />
      )}
      {drivers.map((driver) => {
        const isSelected = selected === driver.id
        return (
          <button
            key={driver.id}
            ref={(node) => {
              buttonRefs.current[driver.id] = node
            }}
            type="button"
            onClick={() => onSelect(driver.id)}
            title={`${driver.id} (${driver.family})`}
            className={cn(
              "relative z-[1] flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors duration-150 ease-[var(--ease-out)]",
              isSelected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "size-1.5 rounded-full transition-colors duration-150",
                driver.ready ? "bg-success" : "bg-destructive",
              )}
            />
            <span>{driver.label}</span>
          </button>
        )
      })}
    </div>
  )
}

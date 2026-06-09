"use client"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { durationAgo, timeAgo } from "@/lib/time-ago"
import { useEffect, useMemo, useState } from "react"

export const TimeAgo = ({
  date,
  variant = "default",
}: {
  date?: Date | string | number | null
  variant?: "default" | "duration"
}) => {
  const [tick, setTick] = useState(() => Date.now())

  const resolved = useMemo(() => (date ? new Date(date) : null), [date])
  const resolvedTime = resolved?.getTime()
  const now = useMemo(() => new Date(tick), [tick])

  useEffect(() => {
    if (resolvedTime === undefined) return

    const interval = setInterval(() => {
      setTick(Date.now())
    }, 30000)

    return () => clearInterval(interval)
  }, [resolvedTime])

  const timeAgoState = useMemo(
    () =>
      !resolved
        ? ""
        : variant === "duration"
          ? durationAgo(resolved, now)
          : timeAgo(resolved, now),
    [now, resolved, variant]
  )

  if (!resolved) return null

  if (variant === "duration") {
    return <span>{timeAgoState}</span>
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="cursor-default">{timeAgoState}</span>}
      />
      <TooltipContent>{resolved.toLocaleString()}</TooltipContent>
    </Tooltip>
  )
}

import { cn } from "@/lib/utils"
import type { SandboxDriverInfo } from "../sandbox/types"

export function ProviderStatus({ driver }: { driver: SandboxDriverInfo }) {
  return (
    <div className="border-t px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            driver.ready ? "bg-success" : "bg-destructive"
          )}
        />
        <span className="text-xs font-medium">{driver.label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {driver.ready ? "ready" : "not configured"}
        </span>
      </div>

      <div className="mt-1 flex flex-wrap gap-1 font-mono text-[10px] text-muted-foreground">
        <span>driver:{driver.id}</span>
        <span>family:{driver.family}</span>
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {driver.requiredEnv.map((key) => (
          <span
            key={key}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              driver.missingRequiredEnv.includes(key)
                ? "bg-destructive/15 text-destructive"
                : "bg-success/15 text-success"
            )}
          >
            {key}
          </span>
        ))}
        {driver.missingOptionalEnv.map((key) => (
          <span
            key={key}
            className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            {key}
          </span>
        ))}
      </div>

      <code className="mt-1.5 block truncate font-mono text-[10px] text-muted-foreground">
        {driver.publicWebhookUrl}
      </code>
    </div>
  )
}

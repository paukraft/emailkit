import { cn } from "@/lib/cn";
import type { SandboxProviderInfo } from "@/lib/sandbox-types";

export function ProviderStatus({ provider }: { provider: SandboxProviderInfo }) {
  return (
    <div className="border-t px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "size-1.5 rounded-full",
            provider.ready ? "bg-success" : "bg-destructive",
          )}
        />
        <span className="text-xs font-medium">{provider.label}</span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {provider.ready ? "ready" : "not configured"}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {provider.requiredEnv.map((key) => (
          <span
            key={key}
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              provider.missingRequiredEnv.includes(key)
                ? "bg-destructive/15 text-destructive"
                : "bg-success/15 text-success",
            )}
          >
            {key}
          </span>
        ))}
        {provider.missingOptionalEnv.map((key) => (
          <span
            key={key}
            className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          >
            {key}
          </span>
        ))}
      </div>
      <code className="mt-1.5 block truncate font-mono text-[10px] text-muted-foreground">
        {typeof window === "undefined"
          ? provider.webhookPath
          : `${window.location.origin}${provider.webhookPath}`}
      </code>
    </div>
  );
}

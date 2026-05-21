import Link from "next/link";
import { cn } from "@/lib/cn";
import type { SandboxProviderId, SandboxSnapshot } from "@/lib/sandbox-types";

export function ProviderTabs({
  providers,
  selected,
}: {
  providers: SandboxSnapshot["providers"];
  selected: SandboxProviderId;
}) {
  return (
    <div className="ml-2 flex items-center rounded-md bg-secondary p-0.5">
      {providers.map((p) => (
        <Link
          key={p.id}
          href={`/${p.id}`}
          className={cn(
            "flex items-center gap-1.5 rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
            selected === p.id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              p.ready ? "bg-success" : "bg-destructive",
            )}
          />
          {p.label}
        </Link>
      ))}
    </div>
  );
}

import { cn } from "@/lib/cn";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { SandboxProviderCapabilities } from "@/lib/sandbox-types";

export function FormField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

export function CheckboxField({
  label,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Label
      className={cn(
        "gap-1.5 text-[10px] uppercase tracking-wider",
        disabled
          ? "cursor-not-allowed text-muted-foreground/40"
          : "text-muted-foreground",
      )}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        className="size-3.5"
      />
      {label}
    </Label>
  );
}

export function CapabilitySection({
  caps,
  features,
  children,
}: {
  caps: SandboxProviderCapabilities;
  features: (keyof SandboxProviderCapabilities)[];
  children: React.ReactNode;
}) {
  if (!features.some((f) => caps[f])) return null;
  return <>{children}</>;
}

export function FilterSelect({
  value,
  onValueChange,
  options,
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  const isActive = value !== options[0]?.value;
  return (
    <select
      value={value}
      onChange={(e) => onValueChange(e.target.value)}
      className={cn(
        "shrink-0 cursor-pointer appearance-none rounded-full border-none bg-transparent px-2 py-0.5 text-[10px] font-medium outline-none transition-colors",
        isActive
          ? "bg-accent text-accent-foreground"
          : "text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

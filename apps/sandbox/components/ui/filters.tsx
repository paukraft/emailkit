"use client"

import { Plus, X } from "lucide-react"
import { useState, type ReactNode } from "react"

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * Generic, config-driven filter bar. Callers supply `fields`; the component
 * renders applied filters as editable chips plus an "Add filter" entry point.
 */

export type FilterOperator = "include" | "exclude"

export type AppliedFilter = {
  field: string
  operator: FilterOperator
  values: string[]
}

export type FilterOption = {
  value: string
  label: string
  icon?: ReactNode
}

export type FilterFieldDef = {
  id: string
  label: string
  icon: ReactNode
  options: FilterOption[]
}

const operatorLabel = (operator: FilterOperator, count: number) =>
  operator === "include"
    ? count > 1
      ? "is any of"
      : "is"
    : count > 1
      ? "is none of"
      : "is not"

const segment =
  "inline-flex h-full items-center gap-1 px-2 transition-colors duration-150 ease-out"

const OperatorDropdown = ({
  operator,
  count,
  onChange,
}: {
  operator: FilterOperator
  count: number
  onChange: (operator: FilterOperator) => void
}) => (
  <DropdownMenu>
    <DropdownMenuTrigger
      className={cn(
        segment,
        "text-muted-foreground hover:bg-muted hover:text-foreground aria-expanded:bg-muted",
      )}
    >
      {operatorLabel(operator, count)}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-fit">
      {(["include", "exclude"] as const).map((op) => (
        <DropdownMenuItem key={op} onClick={() => onChange(op)}>
          {operatorLabel(op, count)}
        </DropdownMenuItem>
      ))}
    </DropdownMenuContent>
  </DropdownMenu>
)

const ValueCombobox = ({
  field,
  values,
  defaultOpen,
  onChange,
  onClose,
}: {
  field: FilterFieldDef
  values: string[]
  defaultOpen: boolean
  onChange: (values: string[]) => void
  onClose: () => void
}) => {
  const [open, setOpen] = useState(defaultOpen)
  const selected = field.options.filter((o) => values.includes(o.value))

  const toggle = (value: string) =>
    onChange(
      values.includes(value)
        ? values.filter((v) => v !== value)
        : [...values, value],
    )

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) onClose()
      }}
    >
      <PopoverTrigger
        className={cn(
          segment,
          "text-foreground hover:bg-muted aria-expanded:bg-muted font-medium",
        )}
      >
        {selected.length > 0 && (
          <span className="flex items-center -space-x-1">
            {selected.slice(0, 3).map(
              (option) =>
                option.icon && (
                  <span key={option.value} className="flex items-center">
                    {option.icon}
                  </span>
                ),
            )}
          </span>
        )}
        <span className="max-w-[180px] truncate">
          {selected.length === 0
            ? "Select…"
            : selected.length === 1
              ? selected[0]!.label
              : `${selected.length} selected`}
        </span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command>
          <CommandInput placeholder={field.label} />
          <CommandList>
            <CommandEmpty>No results.</CommandEmpty>
            <CommandGroup>
              {field.options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.label}
                  onSelect={() => toggle(option.value)}
                  data-checked={values.includes(option.value)}
                >
                  {option.icon}
                  <span className="flex-1 truncate">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

const FilterChip = ({
  field,
  filter,
  justAdded,
  onChange,
  onRemove,
}: {
  field: FilterFieldDef
  filter: AppliedFilter
  justAdded: boolean
  onChange: (filter: AppliedFilter) => void
  onRemove: () => void
}) => (
  <div className="border-border bg-background flex h-7 items-center rounded-md border text-xs">
    <span
      className={cn(segment, "text-foreground gap-1.5 [&_svg]:size-3.5")}
      aria-hidden
    >
      {field.icon}
      {field.label}
    </span>
    <span className="bg-border h-full w-px" />
    <OperatorDropdown
      operator={filter.operator}
      count={filter.values.length}
      onChange={(operator) => onChange({ ...filter, operator })}
    />
    <span className="bg-border h-full w-px" />
    <ValueCombobox
      field={field}
      values={filter.values}
      defaultOpen={justAdded}
      onChange={(values) => onChange({ ...filter, values })}
      onClose={() => {
        if (filter.values.length === 0) onRemove()
      }}
    />
    <button
      type="button"
      onClick={onRemove}
      aria-label={`Remove ${field.label} filter`}
      className="text-muted-foreground hover:text-foreground hover:bg-muted flex h-full w-6 items-center justify-center rounded-r-md transition-colors duration-150 ease-out active:scale-90"
    >
      <X className="size-3" />
    </button>
  </div>
)

const AddFilterButton = ({
  fields,
  onAdd,
}: {
  fields: FilterFieldDef[]
  onAdd: (fieldId: string) => void
}) => {
  const [open, setOpen] = useState(false)
  if (fields.length === 0) return null
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="border-border text-muted-foreground hover:bg-muted hover:text-foreground inline-flex h-7 items-center gap-1 rounded-md border border-dashed px-2 text-xs transition-colors duration-150 ease-out active:scale-[0.97]">
        <Plus className="size-3.5" />
        Add filter
      </PopoverTrigger>
      <PopoverContent align="start" className="w-52 p-0">
        <Command>
          <CommandInput placeholder="Filter by…" />
          <CommandList>
            <CommandEmpty>No filters left.</CommandEmpty>
            <CommandGroup>
              {fields.map((field) => (
                <CommandItem
                  key={field.id}
                  value={field.label}
                  onSelect={() => {
                    onAdd(field.id)
                    setOpen(false)
                  }}
                >
                  <span className="[&_svg]:size-3.5">{field.icon}</span>
                  <span className="flex-1">{field.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export const Filters = ({
  fields,
  value,
  onChange,
}: {
  fields: FilterFieldDef[]
  value: AppliedFilter[]
  onChange: (filters: AppliedFilter[]) => void
}) => {
  const [justAdded, setJustAdded] = useState<string | null>(null)
  const fieldById = new Map(fields.map((f) => [f.id, f]))
  const usedFieldIds = new Set(value.map((f) => f.field))
  const available = fields.filter((f) => !usedFieldIds.has(f.id))

  const updateAt = (index: number, next: AppliedFilter) =>
    onChange(value.map((f, i) => (i === index ? next : f)))

  const removeAt = (index: number) =>
    onChange(value.filter((_, i) => i !== index))

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {value.map((filter, index) => {
        const field = fieldById.get(filter.field)
        if (!field) return null
        return (
          <FilterChip
            key={filter.field}
            field={field}
            filter={filter}
            justAdded={justAdded === filter.field}
            onChange={(next) => updateAt(index, next)}
            onRemove={() => removeAt(index)}
          />
        )
      })}
      <AddFilterButton
        fields={available}
        onAdd={(fieldId) => {
          setJustAdded(fieldId)
          onChange([
            ...value,
            { field: fieldId, operator: "include", values: [] },
          ])
        }}
      />
    </div>
  )
}

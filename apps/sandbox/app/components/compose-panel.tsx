import { useState } from "react";
import {
  RiSendPlaneFill,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiSettings3Line,
} from "@remixicon/react";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { RichEditor } from "../rich-editor";
import {
  FormField,
  CheckboxField,
  CapabilitySection,
} from "./form-primitives";
import type { Draft } from "@/lib/draft";
import type {
  SandboxProviderCapabilities,
  SandboxProviderInfo,
} from "@/lib/sandbox-types";

export function ComposePanel({
  draft,
  caps,
  provider,
  isSending,
  feedback,
  onUpdateDraft,
  onSend,
}: {
  draft: Draft;
  caps: SandboxProviderCapabilities;
  provider: SandboxProviderInfo;
  isSending: boolean;
  feedback: string;
  onUpdateDraft: (field: keyof Draft, value: Draft[keyof Draft]) => void;
  onSend: () => void;
}) {
  const [composeOpen, setComposeOpen] = useState(true);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [composeMode, setComposeMode] = useState<"visual" | "html" | "text">("visual");

  return (
    <>
      <button
        onClick={() => setComposeOpen(!composeOpen)}
        className="flex h-9 items-center gap-1.5 border-b px-3 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        {composeOpen ? (
          <RiArrowDownSLine className="size-3.5" />
        ) : (
          <RiArrowRightSLine className="size-3.5" />
        )}
        Compose
        {!provider.ready && (
          <span className="ml-auto rounded bg-destructive/20 px-1.5 py-0.5 font-mono text-[10px] text-destructive">
            missing env
          </span>
        )}
      </button>

      {composeOpen && (
        <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-3 scrollbar-thin">
          <div className="grid grid-cols-2 gap-2">
            <FormField label="From">
              <Input
                value={draft.fromEmail}
                onChange={(e) => onUpdateDraft("fromEmail", e.target.value)}
                placeholder="sender@example.com"
                className="h-7 text-xs"
              />
            </FormField>
            <FormField label="Name">
              <Input
                value={draft.fromName}
                onChange={(e) => onUpdateDraft("fromName", e.target.value)}
                placeholder="(optional)"
                className="h-7 text-xs"
              />
            </FormField>
          </div>
          <FormField label="To">
            <Input
              value={draft.toEmail}
              onChange={(e) => onUpdateDraft("toEmail", e.target.value)}
              placeholder="recipient@example.com"
              className="h-7 text-xs"
            />
          </FormField>
          <div className="grid grid-cols-2 gap-2">
            <FormField label="CC">
              <Input
                value={draft.ccEmail}
                onChange={(e) => onUpdateDraft("ccEmail", e.target.value)}
                placeholder="(optional)"
                className="h-7 text-xs"
              />
            </FormField>
            <FormField label="BCC">
              <Input
                value={draft.bccEmail}
                onChange={(e) => onUpdateDraft("bccEmail", e.target.value)}
                placeholder="(optional)"
                className="h-7 text-xs"
              />
            </FormField>
          </div>
          <FormField label="Subject">
            <Input
              value={draft.subject}
              onChange={(e) => onUpdateDraft("subject", e.target.value)}
              className="h-7 text-xs"
            />
          </FormField>

          {/* Body mode switcher */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Body
              </label>
              <div className="flex items-center rounded-md bg-secondary p-0.5">
                {(["visual", "html", "text"] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={() => setComposeMode(mode)}
                    className={cn(
                      "rounded-[5px] px-2 py-0.5 text-[10px] font-medium capitalize transition-colors",
                      composeMode === mode
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {mode}
                  </button>
                ))}
              </div>
            </div>

            {composeMode === "visual" && (
              <RichEditor
                value={draft.html}
                onChange={(v) => onUpdateDraft("html", v)}
              />
            )}
            {composeMode === "html" && (
              <Textarea
                value={draft.html}
                onChange={(e) => onUpdateDraft("html", e.target.value)}
                rows={6}
                placeholder="<p>Your HTML here</p>"
                className="font-mono text-xs"
              />
            )}
            {composeMode === "text" && (
              <Textarea
                value={draft.text}
                onChange={(e) => onUpdateDraft("text", e.target.value)}
                rows={6}
                placeholder="Plain text fallback"
                className="text-xs"
              />
            )}
          </div>

          {/* Options */}
          <button
            onClick={() => setOptionsOpen(!optionsOpen)}
            className="flex items-center gap-1.5 pt-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
          >
            <RiSettings3Line className="size-3" />
            Options
            {optionsOpen ? (
              <RiArrowDownSLine className="size-3" />
            ) : (
              <RiArrowRightSLine className="size-3" />
            )}
          </button>

          {optionsOpen && (
            <div className="flex flex-col gap-3 rounded-lg border p-3">
              <FormField label="Reply-To">
                <Input
                  value={draft.replyToEmail}
                  onChange={(e) => onUpdateDraft("replyToEmail", e.target.value)}
                  placeholder="reply@example.com"
                  className="h-7 text-xs"
                />
              </FormField>
              <FormField label="In-Reply-To (Message-ID)">
                <Input
                  value={draft.inReplyToMessageId}
                  onChange={(e) => onUpdateDraft("inReplyToMessageId", e.target.value)}
                  placeholder="<msg-id@provider>"
                  className="h-7 text-xs"
                />
              </FormField>

              <CapabilitySection caps={caps} features={["trackOpens", "trackClicks"]}>
                <div className="flex items-center gap-4">
                  <CheckboxField
                    label="Track opens"
                    checked={draft.trackOpens}
                    onCheckedChange={(v) => onUpdateDraft("trackOpens", !!v)}
                    disabled={!caps.trackOpens}
                  />
                  <CheckboxField
                    label="Track clicks"
                    checked={draft.trackClicks}
                    onCheckedChange={(v) => onUpdateDraft("trackClicks", !!v)}
                    disabled={!caps.trackClicks}
                  />
                </div>
              </CapabilitySection>

              <CapabilitySection caps={caps} features={["scheduling"]}>
                <FormField label="Schedule (ISO)">
                  <Input
                    value={draft.sendAt}
                    onChange={(e) => onUpdateDraft("sendAt", e.target.value)}
                    placeholder="2026-04-03T10:00:00Z"
                    className="h-7 text-xs"
                  />
                </FormField>
              </CapabilitySection>

              <CapabilitySection caps={caps} features={["unsubscribe"]}>
                <CheckboxField
                  label="Global unsubscribe header"
                  checked={draft.unsubscribeGlobal}
                  onCheckedChange={(v) => onUpdateDraft("unsubscribeGlobal", !!v)}
                />
              </CapabilitySection>

              <CapabilitySection caps={caps} features={["templates"]}>
                <FormField label="Template ID">
                  <Input
                    value={draft.templateId}
                    onChange={(e) => onUpdateDraft("templateId", e.target.value)}
                    className="h-7 text-xs"
                  />
                </FormField>
                <FormField label="Template data (JSON)">
                  <Textarea
                    value={draft.templateData}
                    onChange={(e) => onUpdateDraft("templateData", e.target.value)}
                    rows={2}
                    className="font-mono text-xs"
                  />
                </FormField>
              </CapabilitySection>

              <CapabilitySection caps={caps} features={["sendIdempotency"]}>
                <FormField label="Idempotency key">
                  <Input
                    value={draft.idempotencyKey}
                    onChange={(e) => onUpdateDraft("idempotencyKey", e.target.value)}
                    className="h-7 text-xs"
                  />
                </FormField>
              </CapabilitySection>

              <CapabilitySection caps={caps} features={["tenantRouting"]}>
                <FormField label="Tenant ID">
                  <Input
                    value={draft.tenantId}
                    onChange={(e) => onUpdateDraft("tenantId", e.target.value)}
                    className="h-7 text-xs"
                  />
                </FormField>
              </CapabilitySection>

              <Separator />

              <FormField label="Tags (comma-separated)">
                <Input
                  value={draft.tags}
                  onChange={(e) => onUpdateDraft("tags", e.target.value)}
                  placeholder="test, sandbox"
                  className="h-7 text-xs"
                />
              </FormField>
              <FormField label="Metadata (JSON)">
                <Textarea
                  value={draft.metadata}
                  onChange={(e) => onUpdateDraft("metadata", e.target.value)}
                  rows={2}
                  placeholder='{"key": "value"}'
                  className="font-mono text-xs"
                />
              </FormField>
              <FormField label="Custom headers (JSON)">
                <Textarea
                  value={draft.headers}
                  onChange={(e) => onUpdateDraft("headers", e.target.value)}
                  rows={2}
                  placeholder='{"X-Custom": "value"}'
                  className="font-mono text-xs"
                />
              </FormField>
            </div>
          )}

          <div className="flex items-center gap-2 pt-1">
            <Button
              size="sm"
              onClick={onSend}
              disabled={isSending || !provider.ready}
            >
              <RiSendPlaneFill className="size-3" />
              {isSending ? "Sending…" : "Send"}
            </Button>
            {feedback && (
              <span
                className={cn(
                  "font-mono text-xs",
                  feedback.startsWith("Sent")
                    ? "text-success"
                    : "text-destructive",
                )}
              >
                {feedback}
              </span>
            )}
          </div>
        </div>
      )}
    </>
  );
}

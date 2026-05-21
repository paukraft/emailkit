import type { SandboxProviderId, SandboxSnapshot } from "./sandbox-types";

export type Draft = {
  fromEmail: string;
  fromName: string;
  toEmail: string;
  ccEmail: string;
  bccEmail: string;
  subject: string;
  text: string;
  html: string;
  replyToEmail: string;
  inReplyToMessageId: string;
  trackOpens: boolean;
  trackClicks: boolean;
  sendAt: string;
  unsubscribeGlobal: boolean;
  tags: string;
  metadata: string;
  headers: string;
  templateId: string;
  templateData: string;
  idempotencyKey: string;
  tenantId: string;
};

export const defaultDraft = (
  snapshot: SandboxSnapshot,
  provider: SandboxProviderId,
): Draft => {
  const info = snapshot.providers.find((p) => p.id === provider);
  return {
    fromEmail: info?.defaultFromEmail ?? "",
    fromName: "",
    toEmail: info?.defaultToEmail ?? "",
    ccEmail: "",
    bccEmail: "",
    subject: `EmailKit sandbox test via ${info?.label ?? provider}`,
    text: "Provider smoke test from the EmailKit sandbox.",
    html: "<p>Provider smoke test from the <strong>EmailKit sandbox</strong>.</p>",
    replyToEmail: "",
    inReplyToMessageId: "",
    trackOpens: true,
    trackClicks: true,
    sendAt: "",
    unsubscribeGlobal: false,
    tags: "",
    metadata: "",
    headers: "",
    templateId: "",
    templateData: "",
    idempotencyKey: "",
    tenantId: "",
  };
};

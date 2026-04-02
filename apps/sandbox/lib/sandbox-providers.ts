import {
  AIINBX_CAPABILITIES,
  AIInbxDriver,
  EmailKit,
  MAILGUN_CAPABILITIES,
  MailgunDriver,
  RESEND_CAPABILITIES,
  ResendDriver,
  type DriverCapabilities,
  type WebhookRequest,
  type WebhookResponse,
} from "emailkit";

import { recordSandboxEvent } from "./sandbox-state";
import type {
  SandboxProviderCapabilities,
  SandboxProviderId,
  SandboxProviderInfo,
  SandboxSendPayload,
} from "./sandbox-types";

type SandboxProviderRuntime = {
  info: SandboxProviderInfo;
  send: (payload: SandboxSendPayload) => Promise<unknown>;
  handleWebhook: (request: WebhookRequest) => Promise<WebhookResponse>;
};

const DEFAULT_FROM = process.env.FROM_EMAIL_ADDRESS ?? "";
const DEFAULT_TO = process.env.TO_EMAIL_ADDRESS ?? "";

const toSandboxCapabilities = (caps: DriverCapabilities): SandboxProviderCapabilities => ({
  templates: caps.templates ?? false,
  scheduling: caps.scheduling ?? false,
  unsubscribe: caps.unsubscribe ?? false,
  trackOpens: caps.trackOpens ?? false,
  trackClicks: caps.trackClicks ?? false,
  sendIdempotency: caps.sendIdempotency ?? false,
  tenantRouting: caps.tenantRouting ?? false,
});

const providerMeta: Record<
  SandboxProviderId,
  Pick<SandboxProviderInfo, "label" | "webhookPath" | "requiredEnv" | "optionalEnv"> & {
    driverCapabilities: DriverCapabilities;
  }
> = {
  mailgun: {
    label: "Mailgun",
    webhookPath: "/api/email/mailgun",
    requiredEnv: ["MAILGUN_API_KEY"],
    optionalEnv: ["MAILGUN_WEBHOOK_SIGNING_KEY", "FROM_EMAIL_ADDRESS", "TO_EMAIL_ADDRESS"],
    driverCapabilities: MAILGUN_CAPABILITIES,
  },
  resend: {
    label: "Resend",
    webhookPath: "/api/email/resend",
    requiredEnv: ["RESEND_API_KEY"],
    optionalEnv: ["RESEND_WEBHOOK_SECRET", "FROM_EMAIL_ADDRESS", "TO_EMAIL_ADDRESS"],
    driverCapabilities: RESEND_CAPABILITIES,
  },
  aiinbx: {
    label: "AIInbx",
    webhookPath: "/api/email/aiinbx",
    requiredEnv: ["AI_INBX_API_KEY"],
    optionalEnv: ["AI_INBX_SECRET", "FROM_EMAIL_ADDRESS", "TO_EMAIL_ADDRESS"],
    driverCapabilities: AIINBX_CAPABILITIES,
  },
};

const HOOK_EVENTS = [
  ["onInboundEmail", "hook", "inbound-email", "Inbound email normalized by EmailKit"],
  ["onOutboundEmail", "hook", "outbound-email", "Outbound email accepted by provider"],
  ["onOutboundEmailDelivered", "hook", "outbound-email-delivered", "Delivery confirmation received"],
  ["onOutboundEmailOpened", "hook", "outbound-email-opened", "Open event received"],
  ["onOutboundEmailClicked", "hook", "outbound-email-clicked", "Click event received"],
  ["onOutboundEmailBounced", "hook", "outbound-email-bounced", "Bounce event received"],
  ["onOutboundEmailComplained", "hook", "outbound-email-complained", "Complaint event received"],
  ["onOutboundEmailRejected", "hook", "outbound-email-rejected", "Rejection event received"],
  ["onUnknownEvent", "hook", "unknown-event", "Unknown provider event received"],
] as const;

const createHooks = (provider: SandboxProviderId) =>
  Object.fromEntries(
    HOOK_EVENTS.map(([hookName, category, kind, summary]) => [
      hookName,
      async (payload: unknown) => {
        recordSandboxEvent({ provider, category, kind, summary, details: payload });
      },
    ]),
  );

const buildProviderInfo = (id: SandboxProviderId): SandboxProviderInfo => {
  const meta = providerMeta[id];
  const missingRequiredEnv = meta.requiredEnv.filter((key) => !process.env[key]);
  const missingOptionalEnv = meta.optionalEnv.filter((key) => !process.env[key]);

  const { driverCapabilities, ...rest } = meta;
  return {
    id,
    ...rest,
    missingRequiredEnv,
    missingOptionalEnv,
    ready: missingRequiredEnv.length === 0,
    defaultFromEmail: DEFAULT_FROM,
    defaultToEmail: DEFAULT_TO,
    capabilities: toSandboxCapabilities(driverCapabilities),
  };
};

const buildMessage = (payload: SandboxSendPayload) => {
  const msg: Record<string, unknown> = {
    from: { email: payload.fromEmail, name: payload.fromName || undefined },
    to: { email: payload.toEmail },
    subject: payload.subject,
    text: payload.text || undefined,
    html: payload.html || undefined,
  };

  if (payload.ccEmail) msg.cc = { email: payload.ccEmail };
  if (payload.bccEmail) msg.bcc = { email: payload.bccEmail };

  if (payload.replyToEmail || payload.inReplyToMessageId) {
    msg.reply = {
      addresses: payload.replyToEmail ? [{ email: payload.replyToEmail }] : undefined,
      messageId: payload.inReplyToMessageId || undefined,
    };
  }

  if (payload.trackOpens !== undefined || payload.trackClicks !== undefined) {
    msg.track = { opens: payload.trackOpens, clicks: payload.trackClicks };
  }

  if (payload.sendAt) msg.sendAt = new Date(payload.sendAt);
  if (payload.unsubscribeGlobal) msg.unsubscribe = { global: true };
  if (payload.tags?.length) msg.tags = payload.tags;
  if (payload.metadata && Object.keys(payload.metadata).length) msg.metadata = payload.metadata;
  if (payload.headers && Object.keys(payload.headers).length) msg.headers = payload.headers;
  if (payload.templateId) {
    msg.templateId = payload.templateId;
    msg.templateData = payload.templateData;
  }
  if (payload.idempotencyKey) msg.idempotencyKey = payload.idempotencyKey;
  if (payload.tenantId) msg.tenantId = payload.tenantId;

  return msg;
};

const createDriver = (id: SandboxProviderId) => {
  const hooks = createHooks(id);
  switch (id) {
    case "mailgun":
      return EmailKit({
        emailDriver: MailgunDriver({
          apiKey: process.env.MAILGUN_API_KEY!,
          region: "eu",
          webhookSigningKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY,
          inboundAttachmentHandling: "inline",
        }),
        hooks,
      });
    case "resend":
      return EmailKit({
        emailDriver: ResendDriver({
          apiKey: process.env.RESEND_API_KEY!,
          webhookSecret: process.env.RESEND_WEBHOOK_SECRET,
        }),
        hooks,
      });
    case "aiinbx":
      return EmailKit({
        emailDriver: AIInbxDriver({
          apiKey: process.env.AI_INBX_API_KEY!,
          webhookSecret: process.env.AI_INBX_SECRET,
        }),
        hooks,
      });
  }
};

const createProviderRuntime = (id: SandboxProviderId): SandboxProviderRuntime => {
  const info = buildProviderInfo(id);

  if (!info.ready) {
    return {
      info,
      send: async () => {
        throw new Error(`Provider ${info.label} is missing required environment variables.`);
      },
      handleWebhook: async () => ({
        status: 503,
        headers: {},
        body: { error: `${info.label} is not configured`, missingRequiredEnv: info.missingRequiredEnv },
      }),
    };
  }

  const client = createDriver(id);
  return {
    info,
    send: async (payload) => client.sendEmail(buildMessage(payload) as never),
    handleWebhook: client.webhookRoute(),
  };
};

const runtimes = Object.fromEntries(
  (Object.keys(providerMeta) as SandboxProviderId[]).map((id) => [id, createProviderRuntime(id)]),
) as Record<SandboxProviderId, SandboxProviderRuntime>;

export const getSandboxProviders = (): SandboxProviderInfo[] =>
  (Object.values(runtimes) as SandboxProviderRuntime[]).map((r) => r.info);

export const getSandboxProviderRuntime = (
  provider: SandboxProviderId,
): SandboxProviderRuntime => runtimes[provider];

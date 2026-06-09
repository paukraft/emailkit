/**
 * Resend email driver
 *
 * Implements the Resend API for sending emails and handling webhooks.
 * Documentation: https://resend.com/docs
 */

import { Webhook } from "svix";
import type {
  EmailDriver,
  EmailDriverConfig,
  ProviderFetch,
  SendEmailOptions,
} from "../driver";
import type {
  AccountWebhookDeleteInput,
  AccountWebhookDeleteResult,
  AccountWebhookRefreshInput,
  AccountWebhookRefreshResult,
  AccountWebhookSetupInput,
  AccountWebhookSetupResult,
  Attachment,
  CreateDomainInput,
  Domain,
  DomainDeleteResult,
  DomainDNSRecord,
  DomainRecordPurpose,
  DomainStatus,
  DomainVerification,
  DriverCapabilities,
  EmailTag,
  EmailAddress,
  EmailMessage,
  InboundEmailEvent,
  ListDomainsOptions,
  OutboundEmailEvent,
  SendEmailResult,
  UpdateDomainInput,
  WebhookEvent,
  WebhookEventSelection,
  WebhookEventType,
  WebhookRequest,
  WebhookResponse,
  WebhookStatus,
  Webhook as EmailKitWebhook,
} from "../types";
import { EmailKitError } from "../types";
import { bytesToBase64, stringToBase64 } from "../utils/base64";
import { createProviderFetch } from "../utils/provider-fetch";
import {
  buildReplyContext,
  hasReplyData,
  replyAddressesAsArray,
  resolveMessageReplyContext,
} from "../utils/reply";

/**
 * Resend-specific configuration
 */
export interface ResendDriverConfig<TId extends string = "resend">
  extends EmailDriverConfig {
  /**
   * EmailKit driver id. Override when configuring multiple Resend drivers.
   */
  id?: TId;
  apiKey: string;
  /**
   * Optional API base URL (defaults to https://api.resend.com)
   */
  apiBase?: string;
  /**
   * Optional webhook signing secret for webhook verification
   * This is the signing_secret returned when creating a webhook via Resend API
   * Resend uses Svix for webhook signing, so this should be the Svix signing secret
   * (can be in format: whsec_<base64> or just the base64 string)
   */
  webhookSecret?: string;
  /**
   * Automatically fetch inbound attachments from provided URLs.
   * If false, attachments will include metadata and URL only.
   * App code can still retrieve content later via `emailkit.attachments.getContent(...)`.
   * Default: true
   */
  autoFetchInboundAttachments?: boolean;
}

/**
 * Format email address for Resend API
 * Supports format: "Name <email@example.com>" or "email@example.com"
 */
const formatEmailAddress = (address: EmailAddress): string => {
  if (address.name) {
    return `${address.name} <${address.email}>`;
  }
  return address.email;
};

/**
 * Format multiple email addresses for Resend API
 */
const formatEmailAddresses = (
  addresses: EmailAddress | EmailAddress[],
): string[] => {
  if (Array.isArray(addresses)) {
    return addresses.map(formatEmailAddress);
  }
  return [formatEmailAddress(addresses)];
};

/**
 * Parse email address string into EmailAddress object
 */
const parseEmailAddress = (emailStr: string): EmailAddress => {
  if (!emailStr) return { email: "" };
  const match = emailStr.match(/^(.+?)\s*<(.+?)>$/i);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { email: emailStr.trim() };
};

/**
 * Resend webhook event payload structure
 * Based on Resend webhook documentation
 */
interface ResendWebhookEvent {
  type:
    | "email.sent"
    | "email.delivered"
    | "email.delivery_delayed"
    | "email.failed"
    | "email.complained"
    | "email.bounced"
    | "email.opened"
    | "email.clicked"
    | "email.scheduled"
    | "email.suppressed"
    | "email.unsubscribed";
  created_at: string;
  data: ResendWebhookEventData;
}

/**
 * Resend webhook event data
 */
interface ResendWebhookEventData {
  email_id: string;
  from: string;
  to: string[];
  subject: string;
  created_at: string;
  [key: string]: unknown;
}

/**
 * Resend inbound email webhook payload
 * Based on Receiving Emails API
 */
interface ResendInboundEmailWebhook {
  type: "email.received";
  created_at: string;
  data: {
    // The webhook minimally includes an email identifier
    // Some payloads may include fields like to/from/subject
    email_id?: string;
    id?: string;
    to?: string[];
    from?: string;
    subject?: string;
    message_id?: string;
    bcc?: string[];
    cc?: string[];
    reply_to?: string[];
    headers?: Record<string, string>;
    created_at?: string;
  };
}

/**
 * Resend Receiving API: GET /emails/receiving/:id
 */
type ResendReceivedEmail = {
  object: "email";
  id: string;
  to: string[];
  from: string;
  created_at: string;
  subject: string | null;
  html: string | null;
  text: string | null;
  stripped_html?: string | null;
  stripped_text?: string | null;
  stripped_signature?: string | null;
  headers: Record<string, string>;
  bcc: string[];
  cc: string[];
  reply_to: string[];
  message_id: string;
  attachments: Array<{
    id: string;
    filename: string;
    content_type: string;
    content_disposition: "inline" | "attachment" | string;
    content_id?: string | null;
  }>;
};

/**
 * Resend Attachments API: GET /emails/receiving/:id/attachments
 */
type ResendAttachmentList = {
  object: "list";
  has_more: boolean;
  data: Array<{
    id: string;
    filename: string;
    size?: number;
    content_type: string;
    content_disposition?: "inline" | "attachment" | string;
    content_id?: string | null;
    download_url: string;
    expires_at: string;
  }>;
};

/**
 * Resend driver capabilities
 */
export const RESEND_CAPABILITIES = {
  cc: true,
  bcc: true,
  replyTo: true,
  replyHeaders: true,
  attachments: true,
  customHeaders: true,
  tags: true,
  metadata: true,
  templates: true, // Resend supports templates via template.id and template.variables
  personalizations: false, // Resend does not support per-recipient personalizations
  scheduling: true, // Resend supports scheduled_at for scheduling
  unsubscribe: false, // Resend does not support unsubscribe management in send API
  eventTracking: { opens: true, clicks: true },
  sandbox: false, // Resend does not have a sandbox mode
  sendIdempotency: true,
  tenantRouting: true,
  providerFetch: true,
  domains: {
    list: true,
    create: true,
    get: true,
    update: true,
    verify: true,
    delete: true,
    identifier: "domainId" as const,
  },
  webhooks: { account: true },
  publicRoutes: { webhook: true },
  requiresSecret: false,
} as const satisfies DriverCapabilities;

/**
 * Type helper for Resend capabilities
 */
export type ResendCapabilities = typeof RESEND_CAPABILITIES;

const RESEND_VERIFY_POLL_INTERVAL_MS = 1000;
const RESEND_VERIFY_TIMEOUT_MS = 10000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Map Resend domain status to standardized DomainStatus
 */
const mapDomainStatus = (status: string | undefined): DomainStatus => {
  if (!status) return "unknown";
  const normalized = status.toLowerCase();
  switch (normalized) {
    case "verified":
      return "verified";
    case "not_started":
    case "pending_verification":
      return "pending";
    case "pending":
    case "partially_verified":
    case "temporary_failure":
      return "pending";
    case "failed":
    case "partially_failed":
    case "unverified":
      return "unverified";
    default:
      return "unknown";
  }
};

/**
 * Map Resend DNS record to standardized DomainDNSRecord
 */
const mapDnsRecord = (record: {
  record?: string;
  name?: string;
  value?: string;
  type?: string;
  ttl?: string | number;
  status?: string;
  priority?: number | string;
}): DomainDNSRecord => {
  const type = (record.type?.toUpperCase() || "TXT") as DomainDNSRecord["type"];
  const priority =
    record.priority !== undefined
      ? typeof record.priority === "string"
        ? parseInt(record.priority, 10)
        : record.priority
      : undefined;

  // Determine purpose from record type and name
  let purpose: DomainRecordPurpose | undefined;
  const recordType = (record.record || "").toLowerCase();
  const name = (record.name || "").toLowerCase();

  if (recordType === "spf" || name.includes("spf")) {
    purpose = "spf";
  } else if (
    recordType === "dkim" ||
    name.includes("dkim") ||
    name.includes("_domainkey")
  ) {
    purpose = "dkim";
  } else if (recordType === "dmarc" || name.includes("dmarc")) {
    purpose = "dmarc";
  } else if (type === "MX") {
    purpose = "mx";
  } else if (name.includes("return-path") || name.includes("bounce")) {
    purpose = "returnPath";
  }

  // Parse TTL - Resend uses "Auto" as string
  const ttl =
    record.ttl === "Auto" || record.ttl === "auto"
      ? ("auto" as const)
      : typeof record.ttl === "string"
        ? parseInt(record.ttl, 10)
        : record.ttl;

  return {
    type,
    name: record.name || "",
    value: record.value || "",
    priority,
    purpose,
    verified: record.status === "verified" || record.status === "valid",
    lastCheckedAt: undefined,
    ttl,
  };
};

type ResendEmailTag = { name: string; value: string };

const RESEND_TAG_PART_PATTERN = /^[A-Za-z0-9_-]+$/;
const RESEND_TAG_PART_MAX_LENGTH = 256;
const RESEND_TAGS_MAX_COUNT = 75;

const assertValidResendTagPart = (
  field: "name" | "value",
  value: unknown,
  source: string,
): string => {
  if (typeof value !== "string") {
    throw new EmailKitError(
      `Resend ${source} tag ${field} must be a string`,
      "resend",
      "INVALID_TAG",
    );
  }
  if (value.length === 0) {
    throw new EmailKitError(
      `Resend ${source} tag ${field} cannot be empty`,
      "resend",
      "INVALID_TAG",
    );
  }
  if (value.length > RESEND_TAG_PART_MAX_LENGTH) {
    throw new EmailKitError(
      `Resend ${source} tag ${field} must be ${RESEND_TAG_PART_MAX_LENGTH} characters or fewer`,
      "resend",
      "INVALID_TAG",
    );
  }
  if (!RESEND_TAG_PART_PATTERN.test(value)) {
    throw new EmailKitError(
      `Resend ${source} tag ${field} can only contain ASCII letters, numbers, underscores, or dashes`,
      "resend",
      "INVALID_TAG",
    );
  }
  return value;
};

const toResendTag = (
  tag: EmailTag,
  source = "message.tags",
): ResendEmailTag => {
  if (typeof tag === "string") {
    return {
      name: assertValidResendTagPart("name", tag, source),
      value: "true",
    };
  }

  return {
    name: assertValidResendTagPart("name", tag.name, source),
    value: assertValidResendTagPart("value", tag.value, source),
  };
};

const toResendMetadataTag = (name: string, value: string): ResendEmailTag => ({
  name: assertValidResendTagPart("name", name, "message.metadata"),
  value: assertValidResendTagPart("value", value, "message.metadata"),
});

const assertResendTagCount = (tags: ResendEmailTag[]): void => {
  if (tags.length > RESEND_TAGS_MAX_COUNT) {
    throw new EmailKitError(
      `Resend supports at most ${RESEND_TAGS_MAX_COUNT} tags per email`,
      "resend",
      "INVALID_TAG",
    );
  }
};

const normalizeResendWebhookTags = (
  tags: unknown,
): Pick<OutboundEmailEvent, "tags" | "metadata"> => {
  const normalizedTags: EmailTag[] = [];
  const metadata: Record<string, string> = {};

  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (!tag || typeof tag !== "object") continue;
      const { name, value } = tag as { name?: unknown; value?: unknown };
      if (typeof name !== "string" || typeof value !== "string") continue;
      normalizedTags.push({ name, value });
      metadata[name] = value;
    }
  } else if (tags && typeof tags === "object") {
    for (const [name, value] of Object.entries(tags)) {
      if (typeof value !== "string") continue;
      normalizedTags.push({ name, value });
      metadata[name] = value;
    }
  }

  return {
    ...(normalizedTags.length > 0 ? { tags: normalizedTags } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
};

type ResendAccountWebhook = {
  id?: string;
  endpoint?: string;
  status?: string;
  events?: string[];
  created_at?: string;
  updated_at?: string;
  signing_secret?: string;
};

const RESEND_DEFAULT_WEBHOOK_EVENTS = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.failed",
  "email.opened",
  "email.clicked",
  "email.bounced",
  "email.complained",
  "email.unsubscribed",
  "email.received",
  "email.scheduled",
  "email.suppressed",
] as const;

const RESEND_EVENT_BY_EMAILKIT_EVENT: Record<string, string[]> = {
  outbound: ["email.sent"],
  sent: ["email.sent"],
  delivered: ["email.delivered"],
  opened: ["email.opened"],
  clicked: ["email.clicked"],
  bounced: ["email.bounced"],
  complained: ["email.complained"],
  rejected: ["email.failed", "email.suppressed"],
  inbound: ["email.received"],
};

const EMAILKIT_EVENT_BY_RESEND_EVENT: Record<string, WebhookEventType> = {
  "email.sent": "outbound",
  "email.delivered": "delivered",
  "email.delivery_delayed": "outbound",
  "email.failed": "rejected",
  "email.opened": "opened",
  "email.clicked": "clicked",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.scheduled": "outbound",
  "email.suppressed": "rejected",
  "email.unsubscribed": "complained",
  "email.received": "inbound",
};

const unique = <T>(values: T[]): T[] => Array.from(new Set(values));

const toResendWebhookEvents = (events?: WebhookEventSelection): string[] => {
  if (events === "all") {
    return [...RESEND_DEFAULT_WEBHOOK_EVENTS];
  }
  const requested = events?.length ? events : undefined;
  if (!requested?.length) {
    return [...RESEND_DEFAULT_WEBHOOK_EVENTS];
  }

  return unique(
    requested.flatMap((event) => {
      if (event.startsWith("email.")) return [event];
      return RESEND_EVENT_BY_EMAILKIT_EVENT[event] || [event];
    }),
  );
};

const fromResendWebhookEvents = (events?: string[]): WebhookEventType[] =>
  unique(
    (events || []).map(
      (event) => EMAILKIT_EVENT_BY_RESEND_EVENT[event] || event,
    ),
  );

const mapResendWebhookStatus = (status?: string): WebhookStatus => {
  const normalized = status?.toLowerCase();
  if (!normalized) return "active";
  if (normalized === "enabled") return "active";
  if (normalized === "disabled") return "disabled";
  return "unknown";
};

const resolveWebhookId = (
  input: AccountWebhookRefreshInput | AccountWebhookDeleteInput,
): string | undefined => {
  return (
    input.webhook?.providerId ||
    input.webhook?.id ||
    ("providerId" in input ? input.providerId : undefined) ||
    input.webhookId
  );
};

const requireWebhookSetupUrl = (url: string | undefined): string => {
  if (!url?.trim()) {
    throw new EmailKitError(
      "Webhook setup requires input.url",
      "resend",
      "MISSING_REQUIRED_FIELD",
    );
  }
  return url;
};

const normalizeUrlBase = (value: string): string => value.replace(/\/+$/, "");

const isAbsoluteHttpUrl = (value: string): boolean =>
  /^https?:\/\//i.test(value);

const isResendApiUrl = (path: string | URL, apiBase: string): boolean => {
  if (typeof path === "string" && !isAbsoluteHttpUrl(path)) {
    return true;
  }

  try {
    const url = path instanceof URL ? path : new URL(path);
    const base = new URL(normalizeUrlBase(apiBase));
    const basePath = normalizeUrlBase(base.pathname);

    if (url.origin !== base.origin) return false;
    if (!basePath) return true;

    return url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
  } catch {
    return true;
  }
};

const createResendProviderFetch = (
  apiBase: string,
  apiKey: string,
): ProviderFetch => {
  const authedFetch = createProviderFetch({
    baseUrl: apiBase,
    defaultHeaders: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  const anonymousFetch = createProviderFetch({ baseUrl: apiBase });

  return (path, init) =>
    isResendApiUrl(path, apiBase)
      ? authedFetch(path, init)
      : anonymousFetch(path, init);
};

/**
 * Retrieve attachment content from Resend download URLs
 */
const retrieveResendAttachments = async (
  attachmentMetadata: Attachment[],
): Promise<Attachment[]> => {
  const attachments: Attachment[] = [];

  for (const attachmentMeta of attachmentMetadata) {
    if (attachmentMeta.url) {
      try {
        const res = await fetch(attachmentMeta.url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());

        attachments.push({
          filename: attachmentMeta.filename,
          content: buf,
          contentType: attachmentMeta.contentType,
          url: attachmentMeta.url,
          size: attachmentMeta.size,
          contentId: attachmentMeta.contentId,
          isInline: attachmentMeta.isInline,
        });
      } catch (error) {
        console.error(
          `Failed to retrieve Resend attachment ${attachmentMeta.filename}:`,
          error,
        );
        attachments.push(attachmentMeta);
      }
    } else {
      attachments.push(attachmentMeta);
    }
  }

  return attachments;
};

/**
 * Fetch a received email and its attachments from Resend APIs and
 * transform into an InboundEmailEvent. Optionally download attachment content.
 */
const transformInboundEmail = async (
  webhookData: ResendInboundEmailWebhook["data"],
  webhookTimestamp: string,
  rawPayload: ResendInboundEmailWebhook,
  apiBaseUrl: string,
  apiKey: string,
  autoFetchAttachments: boolean,
): Promise<InboundEmailEvent> => {
  const parseEmailAddressList = (addresses: string[]): EmailAddress[] => {
    return addresses.map(parseEmailAddress);
  };

  // Determine emailId from webhook data
  const emailId = webhookData.id || webhookData.email_id;
  if (!emailId) {
    throw new EmailKitError(
      "Missing email id in Resend inbound webhook payload",
      "resend",
      "MISSING_EMAIL_ID",
    );
  }

  // Fetch the received email (body + headers)
  const emailUrl = `${apiBaseUrl}/emails/receiving/${emailId}`;
  const emailRes = await fetch(emailUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!emailRes.ok) {
    const body = await emailRes.text();
    throw new EmailKitError(
      `Failed to retrieve received email: HTTP ${emailRes.status} ${body}`,
      "resend",
      emailRes.status,
    );
  }
  const email = (await emailRes.json()) as ResendReceivedEmail;

  // Fetch attachments list to obtain download_url (not in webhook/primary response)
  const attUrl = `${apiBaseUrl}/emails/receiving/${emailId}/attachments`;
  const attRes = await fetch(attUrl, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!attRes.ok) {
    const body = await attRes.text();
    throw new EmailKitError(
      `Failed to list received email attachments: HTTP ${attRes.status} ${body}`,
      "resend",
      attRes.status,
    );
  }
  const attList = (await attRes.json()) as ResendAttachmentList;

  // Map attachments by id to include download_url
  const attachmentMetadata: Attachment[] = attList.data.map((att) => ({
    filename: att.filename,
    contentType: att.content_type,
    size: att.size,
    contentId: att.content_id || undefined,
    isInline: att.content_disposition === "inline",
    url: att.download_url,
  }));

  const attachments =
    attachmentMetadata.length > 0
      ? autoFetchAttachments
        ? await retrieveResendAttachments(attachmentMetadata)
        : attachmentMetadata
      : undefined;

  const from = parseEmailAddress(email.from);
  const to = parseEmailAddressList(email.to);
  const cc =
    email.cc && email.cc.length > 0
      ? parseEmailAddressList(email.cc)
      : undefined;
  const bcc =
    email.bcc && email.bcc.length > 0
      ? parseEmailAddressList(email.bcc)
      : undefined;
  const replyAddresses =
    email.reply_to && email.reply_to.length > 0
      ? email.reply_to.map((value) => parseEmailAddress(value))
      : undefined;

  const headers = email.headers || {};
  const inReplyTo = headers["In-Reply-To"] || headers["in-reply-to"];
  const references = headers["References"] || headers["references"];
  const referencesArray = references
    ? references.split(/\s+/).filter(Boolean)
    : undefined;

  const reply = buildReplyContext({
    addresses: replyAddresses,
    messageId: inReplyTo,
    references: referencesArray,
  });

  const ts = email.created_at || webhookTimestamp;
  const strippedText = email.stripped_text || undefined;
  const strippedHtml = email.stripped_html || undefined;
  const event: InboundEmailEvent = {
    schemaVersion: "1",
    eventId: `${email.id}:email.received:${ts}`,
    messageId: email.message_id,
    providerId: email.id,
    from,
    to,
    cc,
    bcc,
    reply,
    subject: email.subject || "",
    text: email.text || strippedText || undefined,
    html: email.html || strippedHtml || undefined,
    strippedText,
    strippedHtml,
    attachments,
    headers,
    timestamp: new Date(ts),
    raw: rawPayload,
  };

  return event;
};

/**
 * Transform Resend outbound event to OutboundEmailEvent
 */
const transformOutboundEvent = (
  eventType: string,
  data: ResendWebhookEventData,
  timestamp: string,
  rawPayload: ResendWebhookEvent,
): OutboundEmailEvent => {
  const baseEvent: OutboundEmailEvent = {
    schemaVersion: "1",
    messageId: "", // Will be set from data
    recipient: "",
    status: "sent",
    timestamp: new Date(timestamp),
    raw: rawPayload,
  };

  // Map event types to status
  const statusMap: Record<string, OutboundEmailEvent["status"]> = {
    "email.sent": "sent",
    "email.delivered": "delivered",
    "email.delivery_delayed": "sent",
    "email.failed": "rejected",
    "email.opened": "opened",
    "email.clicked": "clicked",
    "email.bounced": "bounced",
    "email.complained": "complained",
    "email.scheduled": "sent",
    "email.suppressed": "rejected",
    "email.unsubscribed": "complained", // Map unsubscribe to complained
  };

  baseEvent.status = statusMap[eventType] || "sent";
  baseEvent.providerId = data.email_id;
  baseEvent.recipient = data.to[0] || "";
  baseEvent.recipientDomain = data.to[0]?.split("@")[1];
  baseEvent.eventId = `${data.email_id}:${eventType}:${timestamp}`;

  // Extract common fields
  if (data.from) {
    baseEvent.from = parseEmailAddress(data.from);
  }
  if (data.to && data.to.length > 0) {
    baseEvent.to = data.to.map(parseEmailAddress);
  }
  if (data.subject) {
    baseEvent.subject = data.subject;
  }
  Object.assign(baseEvent, normalizeResendWebhookTags(data["tags"]));

  // Extract event-specific fields
  switch (eventType) {
    case "email.delivered": {
      return {
        ...baseEvent,
        responseTime: data["processing_time_ms"] as number | undefined,
      } as OutboundEmailEvent & { responseTime?: number };
    }

    case "email.delivery_delayed": {
      const delayed = data["delayed"] as
        | { reason?: string; message?: string; category?: string }
        | undefined;
      return {
        ...baseEvent,
        category: delayed?.category || "delivery_delayed",
        reason:
          delayed?.reason ||
          delayed?.message ||
          (data["delay_reason"] as string | undefined),
      } as OutboundEmailEvent & { category: string; reason?: string };
    }

    case "email.opened": {
      return {
        ...baseEvent,
        ip: data["ip_address"] as string | undefined,
        userAgent: data["user_agent"] as string | undefined,
        location: data["location"] as
          | {
              city?: string;
              country?: string;
              region?: string;
              timezone?: string;
            }
          | undefined,
      } as OutboundEmailEvent & {
        ip?: string;
        userAgent?: string;
        location?: {
          city?: string;
          country?: string;
          region?: string;
          timezone?: string;
        };
      };
    }

    case "email.clicked": {
      return {
        ...baseEvent,
        url: data["link"] as string | undefined,
        ip: data["ip_address"] as string | undefined,
        userAgent: data["user_agent"] as string | undefined,
        location: data["location"] as
          | {
              city?: string;
              country?: string;
              region?: string;
              timezone?: string;
            }
          | undefined,
      } as OutboundEmailEvent & {
        url?: string;
        ip?: string;
        userAgent?: string;
        location?: {
          city?: string;
          country?: string;
          region?: string;
          timezone?: string;
        };
      };
    }

    case "email.bounced": {
      return {
        ...baseEvent,
        severity:
          (data["bounce_type"] as "permanent" | "temporary") || undefined,
        reason: data["bounce_message"] as string | undefined,
        code: data["bounce_code"] as string | number | undefined,
      } as OutboundEmailEvent & {
        severity?: "permanent" | "temporary";
        reason?: string;
        code?: string | number;
      };
    }

    case "email.complained": {
      return {
        ...baseEvent,
        feedbackType: data["complaint_type"] as string | undefined,
        feedback: data["complaint_message"] as string | undefined,
      } as OutboundEmailEvent & {
        feedbackType?: string;
        feedback?: string;
      };
    }

    case "email.failed": {
      const failed = data["failed"] as
        | { reason?: string; code?: string | number; message?: string }
        | undefined;
      return {
        ...baseEvent,
        reason:
          failed?.reason ||
          failed?.message ||
          (data["failed_reason"] as string | undefined),
        code:
          failed?.code || (data["failed_code"] as string | number | undefined),
      } as OutboundEmailEvent & {
        reason?: string;
        code?: string | number;
      };
    }

    case "email.suppressed": {
      const suppressed = data["suppressed"] as
        | { message?: string; type?: string }
        | undefined;
      return {
        ...baseEvent,
        reason:
          suppressed?.message ||
          (data["suppressed_reason"] as string | undefined),
        category: suppressed?.type,
      } as OutboundEmailEvent & {
        reason?: string;
        category?: string;
      };
    }

    default:
      return baseEvent;
  }
};

export const ResendDriver = <const TId extends string = "resend">(
  config: ResendDriverConfig<TId>,
): EmailDriver<ResendDriverConfig<TId>, typeof RESEND_CAPABILITIES, TId> => {
  const apiBase = config.apiBase || "https://api.resend.com";
  const baseUrl = `${apiBase}`;
  const driverId = (config.id || "resend") as TId;

  const parseResendResponse = async (res: Response): Promise<unknown> => {
    if (res.status === 204) return undefined;
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return res.json();
    }
    const text = await res.text();
    return text || undefined;
  };

  const requestResendWebhook = async (
    path: string,
    init?: RequestInit,
    action = "manage webhook",
  ): Promise<unknown> => {
    const res = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
    const body = await parseResendResponse(res);

    if (!res.ok) {
      throw new EmailKitError(
        typeof (body as any)?.message === "string"
          ? (body as any).message
          : `HTTP ${res.status}: Failed to ${action}`,
        "resend",
        undefined,
        res.status,
        undefined,
        body,
      );
    }

    return body;
  };

  const normalizeResendAccountWebhook = (
    raw: ResendAccountWebhook,
    fallback?: Partial<EmailKitWebhook>,
  ): EmailKitWebhook => {
    const id = raw.id || fallback?.providerId || fallback?.id || "";
    const events = raw.events?.length
      ? fromResendWebhookEvents(raw.events)
      : fallback?.events;
    const provider: Record<string, unknown> | undefined = raw.signing_secret
      ? { signingSecret: raw.signing_secret }
      : fallback?.provider;

    return {
      id,
      scope: "account",
      url: raw.endpoint || fallback?.url || "",
      events,
      status: raw.status
        ? mapResendWebhookStatus(raw.status)
        : (fallback?.status ?? "active"),
      providerId: id,
      createdAt: raw.created_at
        ? new Date(raw.created_at)
        : fallback?.createdAt,
      updatedAt: raw.updated_at
        ? new Date(raw.updated_at)
        : fallback?.updatedAt,
      provider,
      raw,
    };
  };

  // Helper to get domain details
  const getDomainDetails = async (idOrName: string): Promise<Domain> => {
    const res = await fetch(
      `${baseUrl}/domains/${encodeURIComponent(idOrName)}`,
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      },
    );

    const contentType = res.headers.get("content-type") || "";
    const body = contentType.includes("application/json")
      ? await res.json()
      : await res.text();

    if (!res.ok) {
      throw new EmailKitError(
        typeof (body as any)?.message === "string"
          ? (body as any).message
          : `HTTP ${res.status}: Failed to get domain`,
        "resend",
        undefined,
        res.status,
        undefined,
        body,
      );
    }

    const domainData = body as {
      id?: string;
      name?: string;
      status?: string;
      created_at?: string;
      region?: string;
      records?: Array<{
        record?: string;
        name?: string;
        value?: string;
        type?: string;
        ttl?: string | number;
        status?: string;
        priority?: number | string;
      }>;
    };

    const status = mapDomainStatus(domainData.status);
    const records = domainData.records
      ? domainData.records.map(mapDnsRecord)
      : [];

    const domain: Domain = {
      id: domainData.id || domainData.name || idOrName,
      domain: domainData.name || idOrName,
      status,
      region: domainData.region,
      createdAt: domainData.created_at
        ? new Date(domainData.created_at)
        : undefined,
      verification:
        records.length > 0
          ? { status, records, checkedAt: undefined }
          : undefined,
      raw: body,
    };

    return domain;
  };

  return {
    id: driverId,
    name: "resend",
    capabilities: RESEND_CAPABILITIES,
    providerFetch: createResendProviderFetch(apiBase, config.apiKey),

    sendEmail: async (
      message: EmailMessage<typeof RESEND_CAPABILITIES>,
      options?: SendEmailOptions,
    ): Promise<SendEmailResult> => {
      // Resend requires either html or text, or template
      if (!message.html && !message.text && !message.templateId) {
        throw new EmailKitError(
          "Either html, text, or templateId must be provided",
          "resend",
          "MISSING_REQUIRED_FIELD",
        );
      }

      const requestBody: Record<string, unknown> = {
        from: formatEmailAddress(message.from),
        to: formatEmailAddresses(message.to),
        subject: message.subject,
      };
      const headers: Record<string, string> = { ...(message.headers ?? {}) };
      const reply = resolveMessageReplyContext(message);
      if (hasReplyData(reply)) {
        if (reply.threadId) {
          throw new EmailKitError(
            "Resend does not support provider thread IDs. Use reply.messageId and reply.references to set RFC reply headers.",
            "resend",
            "UNSUPPORTED_REPLY_THREAD_ID",
          );
        }
        if (
          reply.isReply &&
          !reply.messageId &&
          (!reply.references || reply.references.length === 0)
        ) {
          throw new EmailKitError(
            "Resend does not support reply.isReply by itself. Use reply.messageId or reply.references to set RFC reply headers.",
            "resend",
            "UNSUPPORTED_REPLY_FLAG",
          );
        }

        const replyAddresses = replyAddressesAsArray(reply);
        if (replyAddresses.length === 1) {
          requestBody.reply_to = replyAddresses[0].email;
        } else if (replyAddresses.length > 1) {
          requestBody.reply_to = replyAddresses.map((address) => address.email);
        }

        if (reply.messageId && !headers["In-Reply-To"]) {
          headers["In-Reply-To"] = reply.messageId;
        }
        if (
          reply.references &&
          reply.references.length > 0 &&
          !headers["References"]
        ) {
          headers["References"] = reply.references.join(" ");
        }
      }

      if (message.templateId) {
        requestBody.template = {
          id: message.templateId,
          variables: message.templateData || {},
        };
      } else {
        // Add html or text (or both). Resend rejects html/text when a template is provided.
        if (message.html) {
          requestBody.html = message.html;
        }
        if (message.text) {
          requestBody.text = message.text;
        }
      }

      // Optional CC/BCC
      if (message.cc) {
        requestBody.cc = formatEmailAddresses(message.cc);
      }
      if (message.bcc) {
        requestBody.bcc = formatEmailAddresses(message.bcc);
      }

      // Add attachments
      if (message.attachments && message.attachments.length > 0) {
        requestBody.attachments = message.attachments.map((att) => {
          const baseAttachment: Record<string, unknown> = {
            filename: att.filename,
            content_type: att.contentType,
          };

          // Add content_id for inline attachments (required by Resend)
          if (att.isInline && att.contentId) {
            baseAttachment.content_id = att.contentId;
          }

          if (att.content) {
            // Content is available - encode as base64
            const content =
              typeof att.content === "string"
                ? stringToBase64(att.content)
                : att.content
                  ? bytesToBase64(att.content)
                  : "";
            return {
              ...baseAttachment,
              content,
            };
          } else if (att.url) {
            // URL is provided - use path field
            return {
              ...baseAttachment,
              path: att.url,
            };
          } else {
            throw new EmailKitError(
              `Attachment ${att.filename} must have either content or url`,
              "resend",
              "INVALID_ATTACHMENT",
            );
          }
        });
      }

      const tags: ResendEmailTag[] = [];
      if (message.tags && message.tags.length > 0) {
        tags.push(...message.tags.map((tag) => toResendTag(tag)));
      }

      if (message.metadata) {
        for (const [key, value] of Object.entries(message.metadata)) {
          tags.push(toResendMetadataTag(key, value));
        }
      }

      // Tenant routing (capability)
      if ("tenantId" in message && message.tenantId) {
        headers["X-Tenant-Id"] = message.tenantId;
        tags.push(toResendMetadataTag("tenant", message.tenantId));
      }

      if (tags.length > 0) {
        assertResendTagCount(tags);
        requestBody.tags = tags;
      }

      // Add scheduling
      if (message.sendAt) {
        const sendAtDate =
          message.sendAt instanceof Date
            ? message.sendAt
            : new Date(message.sendAt);
        requestBody.scheduled_at = sendAtDate.toISOString();
      }

      if (Object.keys(headers).length > 0) {
        requestBody.headers = headers;
      }

      if ("track" in message && message.track !== undefined) {
        throw new EmailKitError(
          "Resend does not support send-time message.track controls. Use account webhooks and eventTracking for open/click events.",
          "resend",
          "UNSUPPORTED_SEND_TRACKING",
        );
      }

      // Idempotency key (optional; capability)
      const idempotencyKey =
        ("idempotencyKey" in message && message.idempotencyKey
          ? message.idempotencyKey
          : undefined) ||
        (message.provider?.["idempotency-key"] as string | undefined);
      const requestHeaders: Record<string, string> = {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      };
      if (idempotencyKey) requestHeaders["Idempotency-Key"] = idempotencyKey;

      const url = `${baseUrl}/emails`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(requestBody),
          signal: options?.signal,
        });

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          const bodyObj =
            typeof body === "object" && body !== null
              ? (body as Record<string, unknown>)
              : undefined;
          let errorMessage =
            (bodyObj?.message as string | undefined) ||
            (typeof body === "string" ? body : "Failed to send email");

          if (res.status === 404) {
            errorMessage = `Endpoint not found: POST ${url}. Please check the Resend API documentation.`;
          } else if (res.status === 401) {
            errorMessage = `Unauthorized: Invalid API key. Please check your Resend API key.`;
          } else if (res.status === 400) {
            errorMessage = `Bad Request: ${errorMessage}. Request body: ${JSON.stringify(requestBody, null, 2)}`;
          } else if (res.status === 403) {
            errorMessage = `Forbidden: ${errorMessage}. You may not have permission to send emails from this address.`;
          } else if (res.status) {
            errorMessage = `HTTP ${res.status}: ${errorMessage} (POST ${url})`;
          }

          throw new EmailKitError(
            errorMessage,
            "resend",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const emailId = (body as any)?.id;
        if (!emailId) {
          throw new EmailKitError(
            `Invalid response from Resend API. Expected id. Response: ${typeof body === "string" ? body : JSON.stringify(body)}`,
            "resend",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        return {
          messageId: emailId,
          provider: driverId,
          providerId: emailId,
        };
      } catch (error) {
        if (error instanceof EmailKitError) {
          throw error;
        }

        const errorRecord =
          error && typeof error === "object"
            ? (error as {
                httpStatus?: unknown;
                status?: unknown;
                raw?: unknown;
              })
            : undefined;
        const httpStatus =
          typeof errorRecord?.httpStatus === "number"
            ? errorRecord.httpStatus
            : typeof errorRecord?.status === "number"
              ? errorRecord.status
              : undefined;

        throw new EmailKitError(
          `Failed to send email: ${error instanceof Error ? error.message : String(error)}`,
          "resend",
          undefined,
          httpStatus,
          error,
          errorRecord && "raw" in errorRecord ? errorRecord.raw : undefined,
        );
      }
    },

    handleWebhook: async (request: WebhookRequest): Promise<WebhookEvent> => {
      const payload = request.body as
        | ResendWebhookEvent
        | ResendInboundEmailWebhook;

      // Handle inbound email event
      if (payload.type === "email.received") {
        const inboundPayload = payload as ResendInboundEmailWebhook;
        const inboundEvent = await transformInboundEmail(
          inboundPayload.data,
          inboundPayload.created_at,
          inboundPayload,
          baseUrl,
          config.apiKey,
          config.autoFetchInboundAttachments ?? true,
        );
        return { type: "inbound", data: inboundEvent };
      }

      // Handle outbound events
      const outboundPayload = payload as ResendWebhookEvent;
      const eventType = outboundPayload.type;

      const outboundEventTypes = [
        "email.sent",
        "email.delivered",
        "email.delivery_delayed",
        "email.failed",
        "email.opened",
        "email.clicked",
        "email.bounced",
        "email.complained",
        "email.scheduled",
        "email.suppressed",
        "email.unsubscribed",
      ] as const;

      if (outboundEventTypes.includes(eventType as any)) {
        const outboundEvent = transformOutboundEvent(
          eventType,
          outboundPayload.data,
          outboundPayload.created_at,
          outboundPayload,
        );

        // Map to specific event type
        const eventTypeMap: Record<
          typeof eventType,
          | "sent"
          | "delivered"
          | "opened"
          | "clicked"
          | "bounced"
          | "complained"
          | "rejected"
          | "outbound"
        > = {
          "email.sent": "sent",
          "email.delivered": "delivered",
          "email.delivery_delayed": "outbound",
          "email.failed": "rejected",
          "email.opened": "opened",
          "email.clicked": "clicked",
          "email.bounced": "bounced",
          "email.complained": "complained",
          "email.scheduled": "outbound",
          "email.suppressed": "rejected",
          "email.unsubscribed": "complained",
        };

        const mappedType = eventTypeMap[eventType];
        if (mappedType === "sent" || mappedType === "outbound") {
          return { type: "outbound", data: outboundEvent } as WebhookEvent;
        }
        return {
          type: mappedType,
          data: outboundEvent,
        } as WebhookEvent;
      }

      return { type: "unknown", data: payload };
    },

    verifyWebhook: config.webhookSecret
      ? async (request: WebhookRequest): Promise<boolean> => {
          // Resend uses Svix for webhook signing
          // Use the Svix library to verify webhooks
          try {
            // Use rawBody if available (CRITICAL: must be raw, unmodified body)
            // If rawBody is not available, fallback to stringified body (may fail verification)
            const payload = request.rawBody || JSON.stringify(request.body);

            // Extract Svix headers
            const headers = {
              "svix-id":
                request.headers["svix-id"] ||
                request.headers["Svix-Id"] ||
                request.headers["SVIX-ID"],
              "svix-timestamp":
                request.headers["svix-timestamp"] ||
                request.headers["Svix-Timestamp"] ||
                request.headers["SVIX-TIMESTAMP"],
              "svix-signature":
                request.headers["svix-signature"] ||
                request.headers["Svix-Signature"] ||
                request.headers["SVIX-SIGNATURE"],
            };

            // Check if all required headers are present
            if (
              !headers["svix-id"] ||
              !headers["svix-timestamp"] ||
              !headers["svix-signature"]
            ) {
              return false;
            }

            // Create Svix Webhook instance with the secret
            const wh = new Webhook(config.webhookSecret!);

            // Verify the webhook - throws on error, returns verified payload on success
            wh.verify(payload, headers);

            // If we get here, verification succeeded
            return true;
          } catch {
            // Verification failed
            return false;
          }
        }
      : undefined,

    webhookResponse: async (
      request: WebhookRequest,
      handled: boolean,
    ): Promise<WebhookResponse> => {
      return {
        status: 200,
        body: { success: true },
      };
    },

    webhooks: {
      account: {
        setup: async (
          input: AccountWebhookSetupInput,
        ): Promise<AccountWebhookSetupResult> => {
          const webhookUrl = requireWebhookSetupUrl(input.url);

          const resendEvents = toResendWebhookEvents(input.events);
          const raw = (await requestResendWebhook(
            "/webhooks",
            {
              method: "POST",
              body: JSON.stringify({
                endpoint: webhookUrl,
                events: resendEvents,
              }),
            },
            "create webhook",
          )) as ResendAccountWebhook;
          const webhook = normalizeResendAccountWebhook(raw, {
            id: raw.id,
            providerId: raw.id,
            scope: "account",
            url: webhookUrl,
            events: fromResendWebhookEvents(resendEvents),
            status: "active",
          });

          return { webhook, raw };
        },

        refresh: async (
          input: AccountWebhookRefreshInput,
        ): Promise<AccountWebhookRefreshResult> => {
          const webhookId = resolveWebhookId(input);
          if (!webhookId) {
            throw new EmailKitError(
              "Webhook refresh requires a webhook id or providerId",
              "resend",
              "MISSING_REQUIRED_FIELD",
            );
          }

          const raw = (await requestResendWebhook(
            `/webhooks/${encodeURIComponent(webhookId)}`,
            { method: "GET" },
            "refresh webhook",
          )) as ResendAccountWebhook;

          return {
            webhook: normalizeResendAccountWebhook(raw, input.webhook),
            raw,
          };
        },

        delete: async (
          input: AccountWebhookDeleteInput,
        ): Promise<AccountWebhookDeleteResult> => {
          const webhookId = resolveWebhookId(input);
          if (!webhookId) {
            throw new EmailKitError(
              "Webhook delete requires a webhook id or providerId",
              "resend",
              "MISSING_REQUIRED_FIELD",
            );
          }

          const raw = await requestResendWebhook(
            `/webhooks/${encodeURIComponent(webhookId)}`,
            { method: "DELETE" },
            "delete webhook",
          );

          return {
            deleted: true,
            webhook: {
              id: input.webhook?.id || webhookId,
              providerId: input.webhook?.providerId || webhookId,
              scope: "account",
              url: input.webhook?.url || "",
              events: input.webhook?.events,
              status: "deleted",
              raw,
            },
            raw,
          };
        },
      },
    },

    domains: {
      list: async (opts?: ListDomainsOptions): Promise<Domain[]> => {
        const url = new URL(`${baseUrl}/domains`);
        if (opts?.limit) {
          url.searchParams.append("limit", String(opts.limit));
        }
        if (opts?.provider) {
          // Resend supports after and before for pagination
          if (opts.provider.after) {
            url.searchParams.append("after", String(opts.provider.after));
          }
          if (opts.provider.before) {
            url.searchParams.append("before", String(opts.provider.before));
          }
        }

        const res = await fetch(url.toString(), {
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
          },
        });

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to list domains`,
            "resend",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const response = body as {
          data?: Array<{
            id?: string;
            name?: string;
            status?: string;
            created_at?: string;
            region?: string;
          }>;
        };

        const domains = response.data || [];
        return domains.map((d) => {
          const status = mapDomainStatus(d.status);
          const domain: Domain = {
            id: d.id || d.name || "",
            domain: d.name || "",
            status,
            region: d.region,
            createdAt: d.created_at ? new Date(d.created_at) : undefined,
            raw: d,
          };
          return domain;
        });
      },

      create: async (input: CreateDomainInput): Promise<Domain> => {
        const requestBody: Record<string, unknown> = {
          name: input.domain,
        };

        if (input.region) {
          requestBody.region = input.region;
        }

        if (input.returnPathSubdomain) {
          requestBody.custom_return_path = input.returnPathSubdomain;
        }

        if (input.tracking?.opens !== undefined) {
          requestBody.open_tracking = input.tracking.opens;
        }
        if (input.tracking?.clicks !== undefined) {
          requestBody.click_tracking = input.tracking.clicks;
        }

        // Add provider-specific options
        if (input.provider) {
          Object.assign(requestBody, input.provider);
        }

        const res = await fetch(`${baseUrl}/domains`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(requestBody),
        });

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to create domain`,
            "resend",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const domainData = body as {
          id?: string;
          name?: string;
          status?: string;
          created_at?: string;
          region?: string;
          records?: Array<{
            record?: string;
            name?: string;
            value?: string;
            type?: string;
            ttl?: string | number;
            status?: string;
            priority?: number | string;
          }>;
        };

        const status = mapDomainStatus(domainData.status);
        const records = domainData.records
          ? domainData.records.map(mapDnsRecord)
          : [];

        const domain: Domain = {
          id: domainData.id || input.domain,
          domain: domainData.name || input.domain,
          status,
          region: domainData.region,
          createdAt: domainData.created_at
            ? new Date(domainData.created_at)
            : undefined,
          verification:
            records.length > 0
              ? { status, records, checkedAt: new Date() }
              : undefined,
          raw: body,
        };

        return domain;
      },

      get: async (idOrName: string): Promise<Domain> => {
        return getDomainDetails(idOrName);
      },

      update: async (
        idOrName: string,
        patch: UpdateDomainInput,
      ): Promise<Domain> => {
        const requestBody: Record<string, unknown> = {};

        if (patch.tracking?.opens !== undefined) {
          requestBody.open_tracking = patch.tracking.opens;
        }
        if (patch.tracking?.clicks !== undefined) {
          requestBody.click_tracking = patch.tracking.clicks;
        }
        if (patch.provider) {
          Object.assign(requestBody, patch.provider);
        }

        const res = await fetch(
          `${baseUrl}/domains/${encodeURIComponent(idOrName)}`,
          {
            method: "PATCH",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
          },
        );

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to update domain`,
            "resend",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const updatedId =
          typeof body === "object" && body !== null
            ? ((body as { id?: string }).id ?? idOrName)
            : idOrName;
        return getDomainDetails(updatedId);
      },

      verify: async (idOrName: string): Promise<DomainVerification> => {
        let previousDomain: Domain | null = null;
        try {
          previousDomain = await getDomainDetails(idOrName);
        } catch {
          previousDomain = null;
        }

        const res = await fetch(
          `${baseUrl}/domains/${encodeURIComponent(idOrName)}/verify`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
            },
          },
        );

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to verify domain`,
            "resend",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        // Resend verification is asynchronous and marks the domain as pending
        // regardless of the previous status while the re-check is running.
        // Poll briefly so verify() returns a settled state when available.
        const deadline = Date.now() + RESEND_VERIFY_TIMEOUT_MS;
        let domain: Domain | null = null;

        while (true) {
          domain = await getDomainDetails(idOrName);
          if (domain.status !== "pending" || Date.now() >= deadline) break;
          await sleep(RESEND_VERIFY_POLL_INTERVAL_MS);
        }

        // If Resend is still pending after the polling window, prefer the last
        // known verified snapshot over a transient downgrade caused by reverify.
        if (
          domain.status === "pending" &&
          previousDomain?.status === "verified"
        ) {
          domain = previousDomain;
        }

        const verification: DomainVerification = {
          status: domain.status,
          records: domain.verification?.records || [],
          checkedAt: new Date(),
          raw: {
            verify: body,
            domain: domain.raw,
          },
        };

        return verification;
      },

      delete: async (idOrName: string): Promise<DomainDeleteResult> => {
        const res = await fetch(
          `${baseUrl}/domains/${encodeURIComponent(idOrName)}`,
          {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
            },
          },
        );

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to delete domain`,
            "resend",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        return {
          deleted:
            typeof body === "object" && body !== null && "deleted" in body
              ? Boolean((body as { deleted?: boolean }).deleted)
              : res.ok,
        };
      },
    },
  };
};

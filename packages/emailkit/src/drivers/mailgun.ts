/**
 * Mailgun email driver
 *
 * Implements the Mailgun API for sending emails and handling webhooks.
 * Documentation: https://documentation.mailgun.com/docs/mailgun/quickstart
 */

import { createHmac } from "crypto";
import type {
  EmailDriver,
  EmailDriverConfig,
  SendEmailOptions,
} from "../driver";
import type {
  Attachment,
  CreateDomainInput,
  Domain,
  DomainDeleteResult,
  DomainDNSRecord,
  DomainRecordPurpose,
  DomainStatus,
  DomainVerification,
  DriverCapabilities,
  EmailAddress,
  EmailMessage,
  EmailTag,
  InboundEmailEvent,
  ListDomainsOptions,
  OutboundEmailEvent,
  SendEmailResult,
  UpdateDomainInput,
  WebhookEvent,
  WebhookEventSelection,
  WebhookEventType,
  WebhookInboundOptions,
  Webhook,
  AccountWebhookSetupInput,
  AccountWebhookRefreshInput,
  AccountWebhookDeleteInput,
  AccountWebhookSetupResult,
  AccountWebhookRefreshResult,
  AccountWebhookDeleteResult,
  DomainWebhookSetupInput,
  DomainWebhookRefreshInput,
  DomainWebhookDeleteInput,
  DomainWebhookSetupResult,
  DomainWebhookRefreshResult,
  DomainWebhookDeleteResult,
  WebhookRequest,
  WebhookResponse,
} from "../types";
import { EmailKitError } from "../types";
import { base64ToBytes, stringToBase64 } from "../utils/base64";
import { createProviderFetch } from "../utils/provider-fetch";
import {
  buildReplyContext,
  hasReplyData,
  replyAddressesAsArray,
  resolveMessageReplyContext,
} from "../utils/reply";

/**
 * How to handle inbound email attachments
 * - 'inline': Receive attachments directly in webhook body (default, limited by server body size limits)
 * - 'stored': Store message and retrieve attachments via API (requires Mailgun paid tier)
 */
export type InboundAttachmentHandling = "inline" | "stored";

/**
 * Mailgun API endpoints by region
 * Based on: https://documentation.mailgun.com/docs/mailgun/api-reference/api-overview
 */
export const MAILGUN_ENDPOINTS = {
  us: {
    apiBase: "https://api.mailgun.net",
    smtpServer: "smtp.mailgun.org",
    inboundServers: ["mxa.mailgun.org", "mxb.mailgun.org"],
  },
  eu: {
    apiBase: "https://api.eu.mailgun.net",
    smtpServer: "smtp.eu.mailgun.org",
    inboundServers: ["mxa.eu.mailgun.org", "mxb.eu.mailgun.org"],
  },
} as const;

/**
 * Mailgun-specific configuration
 */
export interface MailgunDriverConfig<TId extends string = "mailgun">
  extends EmailDriverConfig {
  /**
   * EmailKit driver id. Override when configuring multiple Mailgun drivers.
   */
  id?: TId;
  apiKey: string;
  region?: "us" | "eu"; // Defaults to 'us' if not specified
  webhookSigningKey?: string; // Optional webhook signing key (different from API key)
  /**
   * How to handle inbound attachments (default: 'inline')
   * - 'inline': Attachments come directly in webhook body (default, limited by server body size limits)
   * - 'stored': Messages stored, attachments are automatically fetched via API when handling webhooks (requires Mailgun paid tier)
   *   When using 'stored', EmailKit eagerly hydrates attachment content when possible.
   *   App code can always call `emailkit.attachments.getContent(...)` as the stable retrieval path.
   */
  inboundAttachmentHandling?: InboundAttachmentHandling;
  apiBase?: string; // Optional: Override API base URL (defaults based on region)
  /**
   * Automatically fetch inbound attachments from URLs/storage when available.
   * If false, include only attachment metadata and URLs (no eager content fetching).
   * App code can still retrieve content later via `emailkit.attachments.getContent(...)`.
   * Default: true
   */
  autoFetchInboundAttachments?: boolean;
}

/**
 * Format email address for Mailgun API
 */
const formatEmailAddress = (address: EmailAddress): string => {
  if (address.name) {
    return `${address.name} <${address.email}>`;
  }
  return address.email;
};

/**
 * Format multiple email addresses for Mailgun API
 */
const formatEmailAddresses = (
  addresses: EmailAddress | EmailAddress[],
): string => {
  if (Array.isArray(addresses)) {
    return addresses.map(formatEmailAddress).join(", ");
  }
  return formatEmailAddress(addresses);
};

const formatMailgunDeliveryTime = (date: Date): string => {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  const pad = (value: number) => String(value).padStart(2, "0");

  return `${days[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${
    months[date.getUTCMonth()]
  } ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(
    date.getUTCMinutes(),
  )}:${pad(date.getUTCSeconds())} +0000`;
};

const formatMailgunTag = (tag: EmailTag): string => {
  if (typeof tag === "string") return tag;
  return `${tag.name}:${tag.value}`;
};

const resolveMailgunAttachmentContent = async (
  attachment: Attachment,
): Promise<string | Uint8Array> => {
  if (attachment.content !== undefined) {
    return typeof attachment.content === "string"
      ? attachment.content
      : attachment.content;
  }

  if (!attachment.url) {
    throw new EmailKitError(
      `Attachment ${attachment.filename} must have either content or url`,
      "mailgun",
      "INVALID_ATTACHMENT",
    );
  }

  try {
    const res = await fetch(attachment.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  } catch (error) {
    throw new EmailKitError(
      `Failed to fetch attachment ${attachment.filename} from URL: ${attachment.url}`,
      "mailgun",
      "ATTACHMENT_FETCH_FAILED",
      undefined,
      error,
    );
  }
};

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      const found = value.find(
        (item): item is string => typeof item === "string",
      );
      if (found) return found;
    }
  }
  return undefined;
};

const parseMailgunMessageHeaders = (
  headers: unknown,
): Record<string, string> => {
  if (!headers) return {};

  if (typeof headers === "string") {
    try {
      return parseMailgunMessageHeaders(JSON.parse(headers));
    } catch {
      return {};
    }
  }

  if (Array.isArray(headers)) {
    const parsed: Record<string, string> = {};
    for (const header of headers) {
      if (
        Array.isArray(header) &&
        typeof header[0] === "string" &&
        typeof header[1] === "string"
      ) {
        parsed[header[0].toLowerCase()] = header[1];
      }
    }
    return parsed;
  }

  if (typeof headers === "object") {
    const parsed: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") {
        parsed[key.toLowerCase()] = value;
      }
    }
    return parsed;
  }

  return {};
};

/**
 * Mailgun webhook event payload
 */
interface MailgunWebhookPayload {
  signature?: {
    signature?: string;
    timestamp?: string;
    token?: string;
  };
  "event-data"?: {
    event?: string;
    id?: string;
    timestamp?: number;
    message?: {
      headers?: {
        "message-id"?: string;
        from?: string;
        to?: string;
        subject?: string;
      };
      attachments?: Array<{
        filename?: string;
        name?: string;
        size?: number;
        "content-type"?: string;
        "content-id"?: string;
        url?: string;
      }>;
      storage?: {
        url?: string;
        key?: string;
      };
    };
    "user-variables"?: Record<string, string>;
    domain?: {
      name?: string;
    };
    "recipient-domain"?: string;
    recipient?: string;
    storage?: {
      url?: string;
      key?: string;
    };
    severity?: "permanent" | "temporary";
    "delivery-status"?: {
      message?: string;
      code?: number;
      "enhanced-code"?: string;
      description?: string;
    };
    url?: string;
    reason?: string;
    ip?: string; // IP address of the user
    "client-info"?: {
      "client-name"?: string;
      "client-os"?: string;
      "client-type"?: string;
      "device-type"?: string;
      "user-agent"?: string;
      bot?: string;
    };
    geolocation?: {
      city?: string;
      country?: string;
      region?: string;
      timezone?: string;
    };
  };
  // Mailgun stored-message webhook format.
  storage?: {
    url?: string;
    key?: string;
  };
  "message-url"?: string; // URL to retrieve stored message (for inbound emails)
  "attachment-count"?: string;
  // Mailgun flat webhook fields.
  domain?: string;
  from?: string;
  sender?: string;
  subject?: string;
  event?: string;
  timestamp?: string;
  "message-headers"?: string;
  token?: string;
  recipient?: string;
  "Message-Id"?: string;
  From?: string;
  To?: string;
  Cc?: string;
  Bcc?: string;
  "Reply-To"?: string;
  "In-Reply-To"?: string;
  References?: string;
  Subject?: string;
  "body-plain"?: string;
  "body-html"?: string;
  "stripped-text"?: string;
  "stripped-html"?: string;
  "content-id-map"?: string | Record<string, string>; // Maps CID to attachment URL for inline attachments
  "Content-id-map"?: string | Record<string, string>;
  attachments?: string | unknown[]; // JSON string or array of attachment objects
  // Dynamic attachment fields (attachment-1, attachment-2, etc.)
  [key: string]: unknown;
}

type MailgunStoredAttachment = {
  filename?: string;
  name?: string;
  "content-type"?: string;
  size?: number;
  url?: string;
  "content-id"?: string;
};

type MailgunStoredMessage = {
  "Content-Transfer-Encoding"?: string;
  "Content-Type"?: string;
  From?: string;
  "Message-Id"?: string;
  Subject?: string;
  To?: string;
  "body-html"?: string;
  "body-plain"?: string;
  "stripped-html"?: string;
  "stripped-text"?: string;
  "stripped-signature"?: string;
  attachments?: MailgunStoredAttachment[];
  "message-headers"?: Array<[string, string]>;
  [key: string]: unknown;
};

type MailgunStorageLocation = {
  url?: string;
  key?: string;
};

type MailgunAttachmentProviderMetadata = {
  kind: "stored-inbound-attachment";
  storageUrl?: string;
  storageKey?: string;
  attachmentUrl?: string;
  filename?: string;
  index?: number;
  contentId?: string;
};

const MAILGUN_PROVIDER_METADATA_KEY = "mailgun";
const MAILGUN_STORED_ATTACHMENT_URL_PREFIX =
  "emailkit://mailgun/stored-attachment";

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const cleanContentId = (value: string | undefined): string | undefined =>
  value?.replace(/^<|>$/g, "");

const mailgunAttachmentProviderMetadata = (
  provider: Record<string, unknown> | undefined,
): MailgunAttachmentProviderMetadata | undefined => {
  const metadata = provider?.[MAILGUN_PROVIDER_METADATA_KEY];
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Partial<MailgunAttachmentProviderMetadata>;
  return record.kind === "stored-inbound-attachment"
    ? (record as MailgunAttachmentProviderMetadata)
    : undefined;
};

const resolveMailgunStorageLocation = (
  payload: MailgunWebhookPayload,
): MailgunStorageLocation | undefined => {
  const eventData = payload["event-data"];
  const eventStorage = eventData?.storage;
  const messageStorage =
    eventData?.message &&
    typeof eventData.message === "object" &&
    "storage" in eventData.message
      ? (eventData.message.storage as MailgunStorageLocation | undefined)
      : undefined;
  const topLevelStorage = payload.storage;
  const messageUrl = payload["message-url"];

  const url =
    messageStorage?.url ||
    eventStorage?.url ||
    topLevelStorage?.url ||
    (isNonEmptyString(messageUrl) ? messageUrl : undefined);
  const key = messageStorage?.key || eventStorage?.key || topLevelStorage?.key;

  if (!url && !key) return undefined;
  return { url, key };
};

const mailgunDomainName = (
  payload: MailgunWebhookPayload,
): string | undefined => {
  const domain = payload["event-data"]?.domain as
    | { name?: unknown }
    | undefined;
  return firstString(domain?.name, payload.domain);
};

const mailgunRecipientDomain = (
  payload: MailgunWebhookPayload,
): string | undefined => {
  const eventData = payload["event-data"];
  const recipient = firstString(eventData?.recipient, payload.recipient);
  return firstString(
    eventData?.["recipient-domain"],
    recipient?.split("@").pop(),
  )?.toLowerCase();
};

const isInboundMailgunAcceptedEvent = (
  payload: MailgunWebhookPayload,
): boolean => {
  const eventData = payload["event-data"];
  const event = eventData?.event || payload.event;
  if (event !== "accepted" || !resolveMailgunStorageLocation(payload)) {
    return false;
  }

  const domain = mailgunDomainName(payload)?.toLowerCase();
  const recipientDomain = mailgunRecipientDomain(payload);
  return Boolean(domain && recipientDomain && domain === recipientDomain);
};

const isMailgunMessageStorageUrl = (
  url: string | undefined,
  storageUrl?: string,
): boolean => {
  if (!url) return false;
  if (storageUrl && url === storageUrl) return true;
  try {
    const parsed = new URL(url);
    return /\/messages\/[^/?#]+\/?$/i.test(parsed.pathname);
  } catch {
    return /\/messages\/[^/?#]+\/?$/i.test(url);
  }
};

const isDirectMailgunAttachmentUrl = (
  url: string | undefined,
  storageUrl?: string,
): url is string => {
  if (!isNonEmptyString(url) || !/^https?:\/\//i.test(url)) return false;
  return !isMailgunMessageStorageUrl(url, storageUrl);
};

const buildMailgunStoredAttachmentUrl = (
  metadata: MailgunAttachmentProviderMetadata,
): string => {
  const messageId =
    metadata.storageKey ||
    (metadata.storageUrl
      ? extractProviderIdFromUrl(metadata.storageUrl)
      : "") ||
    "message";
  const selector =
    metadata.index !== undefined
      ? `index-${metadata.index}`
      : `name-${encodeURIComponent(metadata.filename || "attachment")}`;
  return `${MAILGUN_STORED_ATTACHMENT_URL_PREFIX}/${encodeURIComponent(
    messageId,
  )}/${selector}`;
};

const withMailgunStoredAttachmentMetadata = ({
  attachment,
  storage,
  directUrl,
  index,
}: {
  attachment: Attachment;
  storage?: MailgunStorageLocation;
  directUrl?: string;
  index?: number;
}): Attachment => {
  const metadata: MailgunAttachmentProviderMetadata = {
    kind: "stored-inbound-attachment",
    storageUrl: storage?.url,
    storageKey: storage?.key,
    attachmentUrl: directUrl,
    filename: attachment.filename,
    index,
    contentId: cleanContentId(attachment.contentId),
  };

  return {
    ...attachment,
    url: directUrl || buildMailgunStoredAttachmentUrl(metadata),
    provider: {
      ...attachment.provider,
      [MAILGUN_PROVIDER_METADATA_KEY]: metadata,
    },
  };
};

const fetchMailgunStoredMessage = async ({
  storageUrl,
  apiKey,
}: {
  storageUrl: string;
  apiKey: string;
}): Promise<MailgunStoredMessage | null> => {
  try {
    const basic = `Basic ${stringToBase64(`api:${apiKey}`)}`;
    const res = await fetch(storageUrl, {
      headers: { Authorization: basic },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as MailgunStoredMessage;
  } catch (error) {
    console.error("Failed to retrieve stored message:", error);
    return null;
  }
};

/**
 * Parse inline attachments from Mailgun webhook payload
 * For inline attachments, Mailgun sends them as attachment-N fields
 */
const parseInlineAttachments = (
  payload: MailgunWebhookPayload,
): Attachment[] => {
  const attachments: Attachment[] = [];
  const attachmentCount = payload["attachment-count"]
    ? parseInt(payload["attachment-count"] as string, 10)
    : 0;

  // Parse attachment-N fields (N is 1-indexed)
  for (let i = 1; i <= attachmentCount; i++) {
    const attachmentKey = `attachment-${i}` as keyof MailgunWebhookPayload;
    const attachment = payload[attachmentKey];

    // Attachment could be:
    // 1. A File object (if parsed from multipart form data - Next.js adapter handles this)
    // 2. An object with content from Next.js adapter (has content, filename, type, size)
    // 3. A string (filename only, content needs to be fetched separately)
    if (attachment) {
      if (
        typeof attachment === "object" &&
        attachment !== null &&
        "content" in attachment &&
        "filename" in attachment
      ) {
        // Already parsed attachment object from Next.js adapter
        const att = attachment as {
          filename: string;
          content?: Uint8Array | string;
          type?: string;
          size?: number;
        };
        attachments.push({
          filename: att.filename,
          content:
            typeof att.content === "string"
              ? base64ToBytes(att.content)
              : att.content,
          contentType: att.type,
          size: att.size,
        });
      } else if (attachment instanceof File) {
        // File object - should be handled by Next.js adapter, but fallback
        attachments.push({
          filename: attachment.name,
          contentType: attachment.type,
          size: attachment.size,
        });
      } else if (typeof attachment === "string") {
        // Just filename, content would be in separate fields or need fetching
        attachments.push({
          filename: attachment,
        });
      }
    }
  }

  return attachments;
};

/**
 * Extract provider ID from Mailgun URL
 * Extracts the storage key/ID from Mailgun storage URLs (for messages only)
 */
const extractProviderIdFromUrl = (url: string): string | undefined => {
  // Extract ID from URLs like:
  // https://storage-europe-west1.api.mailgun.net/v3/domains/iic-ag.de/messages/BAAGAgHaCY6POp8P419IY7k2V0PSXp5GYQ
  // The ID is the message key (BAAGAgHaCY6POp8P419IY7k2V0PSXp5GYQ)
  const match = url.match(/\/messages\/([^\/]+)/);
  if (match) {
    return match[1];
  }
  return undefined;
};

/**
 * Parse stored attachments from Mailgun webhook payload
 */
const parseStoredAttachments = (
  payload: MailgunWebhookPayload,
): Attachment[] => {
  const attachments: Attachment[] = [];
  const eventData = payload["event-data"];
  const message = eventData?.message;
  const storage = resolveMailgunStorageLocation(payload);

  // Parse content-id-map to identify inline attachments
  // Format: "{\"<cid>\":\"url\",...}"
  const contentIdMap: Record<string, string> = {};
  const contentIdMapPayload =
    payload["content-id-map"] || payload["Content-id-map"];
  if (contentIdMapPayload) {
    try {
      const mapData =
        typeof contentIdMapPayload === "string"
          ? JSON.parse(contentIdMapPayload)
          : contentIdMapPayload;
      if (mapData && typeof mapData === "object") {
        // Create reverse map: URL -> CID (without angle brackets)
        for (const [cid, url] of Object.entries(mapData)) {
          if (typeof url === "string") {
            // Remove angle brackets from CID (e.g., "<ii_mheuh73y1>" -> "ii_mheuh73y1")
            const cleanCid = cid.replace(/^<|>$/g, "");
            contentIdMap[url] = cleanCid;
          }
        }
      }
    } catch (error) {
      // Invalid JSON, skip content-id mapping
      console.warn("Failed to parse content-id-map:", error);
    }
  }

  // Helper to check if attachment is inline and set CID
  const enrichAttachment = (attachment: Attachment): Attachment => {
    if (attachment.url && contentIdMap[attachment.url]) {
      return {
        ...attachment,
        contentId: contentIdMap[attachment.url],
        isInline: true,
      };
    }
    return attachment;
  };

  // New format: attachments in event-data.message.attachments
  if (message?.attachments && Array.isArray(message.attachments)) {
    for (const [index, attachment] of message.attachments.entries()) {
      const filename = attachment.filename || attachment.name;
      const directUrl = isDirectMailgunAttachmentUrl(
        attachment.url,
        storage?.url,
      )
        ? attachment.url
        : undefined;
      if (filename) {
        attachments.push(
          enrichAttachment({
            ...withMailgunStoredAttachmentMetadata({
              attachment: {
                filename,
                contentType: attachment["content-type"],
                size: attachment.size,
                contentId: attachment["content-id"],
              },
              storage,
              directUrl,
              index,
            }),
          }),
        );
      }
    }
  }

  // Format for stored inbound emails: attachments field as JSON string
  // Example: "attachments": "[{\"name\":\"file.png\",\"content-type\":\"image/png\",\"size\":1234,\"url\":\"https://...\"}]"
  if (payload.attachments) {
    try {
      let attachmentData: unknown[] = [];

      if (typeof payload.attachments === "string") {
        // Parse JSON string
        attachmentData = JSON.parse(payload.attachments) as unknown[];
      } else if (Array.isArray(payload.attachments)) {
        // Already an array
        attachmentData = payload.attachments;
      }

      if (Array.isArray(attachmentData)) {
        for (const [index, attachment] of attachmentData.entries()) {
          if (
            attachment &&
            typeof attachment === "object" &&
            ("name" in attachment || "filename" in attachment)
          ) {
            const att = attachment as {
              name?: string;
              filename?: string;
              "content-type"?: string;
              size?: number;
              url?: string;
              "content-id"?: string;
            };

            const filename = att.name || att.filename;
            const directUrl = isDirectMailgunAttachmentUrl(
              att.url,
              storage?.url,
            )
              ? att.url
              : undefined;
            if (filename) {
              attachments.push(
                enrichAttachment({
                  ...withMailgunStoredAttachmentMetadata({
                    attachment: {
                      filename,
                      contentType: att["content-type"],
                      size: att.size,
                      contentId: att["content-id"],
                    },
                    storage,
                    directUrl,
                    index,
                  }),
                }),
              );
            }
          }
        }
      }
    } catch (error) {
      // Invalid JSON, skip this format
      console.warn("Failed to parse attachments JSON:", error);
    }
  }

  // Legacy format: attachment-count and attachment-X fields
  const attachmentCount = payload["attachment-count"]
    ? parseInt(payload["attachment-count"] as string, 10)
    : 0;

  if (attachmentCount > 0 && storage?.url) {
    // Attachments are stored, need to retrieve from storage URL
    // The attachment-X fields contain attachment info
    for (let i = 1; i <= attachmentCount; i++) {
      const attachmentKey = `attachment-${i}` as keyof MailgunWebhookPayload;
      const attachmentInfo = payload[attachmentKey];

      if (attachmentInfo && typeof attachmentInfo === "string") {
        // Parse attachment info (format: filename;size;content-type)
        const parts = attachmentInfo.split(";");
        const filename = parts[0]?.trim() || `attachment-${i}`;
        const size = parts[1] ? parseInt(parts[1].trim(), 10) : undefined;
        const contentType = parts[2]?.trim();

        attachments.push(
          enrichAttachment({
            ...withMailgunStoredAttachmentMetadata({
              attachment: {
                filename,
                contentType,
                size,
              },
              storage,
              index: i - 1,
            }),
          }),
        );
      }
    }
  }

  return attachments;
};

/**
 * Transform Mailgun webhook event to standard format
 */
const transformMailgunEvent = async ({
  payload,
  attachmentHandling = "inline",
  apiKey,
  autoFetchAttachments = true,
}: {
  payload: MailgunWebhookPayload;
  attachmentHandling?: InboundAttachmentHandling;
  apiKey?: string;
  autoFetchAttachments?: boolean;
}): Promise<OutboundEmailEvent | InboundEmailEvent> => {
  const eventData = payload["event-data"] || payload;
  const event = eventData.event || payload.event || "unknown";
  const timestampNum =
    typeof eventData.timestamp === "number"
      ? eventData.timestamp
      : payload.timestamp
        ? Number(payload.timestamp)
        : null;
  const timestamp = timestampNum ? new Date(timestampNum * 1000) : new Date();

  const messageHeadersFromEvent = parseMailgunMessageHeaders(
    eventData.message &&
      typeof eventData.message === "object" &&
      "headers" in eventData.message
      ? eventData.message.headers
      : undefined,
  );
  const messageHeadersFromPayload = parseMailgunMessageHeaders(
    payload["message-headers"],
  );
  const messageHeaders = {
    ...messageHeadersFromPayload,
    ...messageHeadersFromEvent,
  };
  const messageId =
    messageHeaders["message-id"] ||
    payload["Message-Id"] ||
    (payload["message-id"] as string | undefined) ||
    `${Date.now()}@mailgun`;

  // Parse from/to addresses (may not be available for all event types)
  const parseEmailAddress = (emailStr: string): EmailAddress => {
    if (!emailStr) return { email: "" };
    const match = emailStr.match(/^(.+?)\s*<(.+?)>$/i);
    if (match) {
      return { name: match[1].trim(), email: match[2].trim() };
    }
    return { email: emailStr.trim() };
  };

  const fromStr =
    messageHeaders.from ||
    payload.From ||
    payload.from ||
    payload.sender ||
    messageHeadersFromEvent.from ||
    "";
  const toStr =
    messageHeaders.to ||
    payload.To ||
    payload.recipient ||
    messageHeadersFromEvent.to ||
    "";
  const ccStr =
    messageHeaders.cc || payload.Cc || messageHeadersFromEvent.cc || "";
  const bccStr =
    messageHeaders.bcc || payload.Bcc || messageHeadersFromEvent.bcc || "";
  const replyToStr =
    messageHeaders["reply-to"] ||
    payload["Reply-To"] ||
    messageHeadersFromEvent["reply-to"] ||
    "";

  const from = parseEmailAddress(fromStr);
  const to = toStr
    ? toStr.split(",").map((addr: string) => parseEmailAddress(addr.trim()))
    : [];
  const cc = ccStr
    ? ccStr.split(",").map((addr: string) => parseEmailAddress(addr.trim()))
    : [];
  const bcc = bccStr
    ? bccStr.split(",").map((addr: string) => parseEmailAddress(addr.trim()))
    : [];
  const replyTo = replyToStr ? parseEmailAddress(replyToStr) : undefined;

  const subject =
    messageHeaders.subject ||
    payload.Subject ||
    payload.subject ||
    messageHeadersFromEvent.subject ||
    "";

  // Determine if this is an inbound email
  // Inbound emails come as POST requests from routes (not webhook events)
  // They have body-plain/body-html fields but no event field
  // OR they come as stored messages with a storage URL
  const isInboundEmail =
    // Route-forwarded inbound emails have these fields
    (payload["body-plain"] !== undefined ||
      payload["body-html"] !== undefined ||
      payload["From"] !== undefined ||
      payload.from !== undefined ||
      payload.sender !== undefined) &&
    // But NOT an event field (that's for outbound webhooks)
    payload.event === undefined &&
    payload["event-data"] === undefined;

  const storageLocation = resolveMailgunStorageLocation(payload);
  const isStoredMessage =
    storageLocation !== undefined &&
    (payload["event-data"] === undefined ||
      event === "stored" ||
      payload["event-data"].event === undefined);

  if (isInboundEmail || isStoredMessage) {
    const storageUrl = storageLocation?.url;

    let bodyPlain = firstString(payload["body-plain"]);
    let bodyHtml = firstString(payload["body-html"]);
    let strippedText =
      (payload["stripped-text"] as string | undefined) ||
      (messageHeaders["stripped-text"] as string | undefined) ||
      undefined;
    let strippedHtml =
      (payload["stripped-html"] as string | undefined) ||
      (messageHeaders["stripped-html"] as string | undefined) ||
      undefined;
    let storedMessage: MailgunStoredMessage | null = null;

    if (
      storageUrl &&
      apiKey &&
      (!bodyPlain || !bodyHtml || !strippedText || !strippedHtml)
    ) {
      storedMessage = await fetchMailgunStoredMessage({
        storageUrl,
        apiKey,
      });
      if (storedMessage) {
        if (!bodyPlain && typeof storedMessage["body-plain"] === "string") {
          bodyPlain = storedMessage["body-plain"];
        }
        if (!bodyHtml && typeof storedMessage["body-html"] === "string") {
          bodyHtml = storedMessage["body-html"];
        }
        if (
          !strippedText &&
          typeof storedMessage["stripped-text"] === "string"
        ) {
          strippedText = storedMessage["stripped-text"];
        }
        if (
          !strippedHtml &&
          typeof storedMessage["stripped-html"] === "string"
        ) {
          strippedHtml = storedMessage["stripped-html"];
        }
      }
    }

    // Parse attachments based on handling mode - combine into single array
    let allAttachments: Attachment[] = [];
    let storedAttachmentMetadata: Attachment[] = [];

    if (attachmentHandling === "stored" || storageUrl) {
      // Attachments are stored - fetch them automatically if we have a storage URL and API key
      storedAttachmentMetadata = parseStoredAttachments(payload);

      // Always include metadata attachments (at minimum)
      allAttachments = storedAttachmentMetadata;

      // If we have a storage URL and API key, try to fetch attachment content
      if (
        autoFetchAttachments &&
        storageUrl &&
        apiKey &&
        storedAttachmentMetadata.length > 0
      ) {
        // Automatically fetch stored attachments
        // Pass metadata so we can fetch directly from URLs if available
        try {
          const {
            attachments: fetchedAttachments,
            storedMessage: messageFromFetch,
          } = await retrieveStoredAttachments({
            storageUrl,
            apiKey,
            attachmentMetadata: storedAttachmentMetadata,
            storedMessage,
          });
          // Only replace if we successfully fetched at least one attachment with content
          if (fetchedAttachments.length > 0) {
            allAttachments = fetchedAttachments;
          }
          if (!storedMessage && messageFromFetch) {
            storedMessage = messageFromFetch;
          }
        } catch (error) {
          console.error(
            "Failed to fetch stored attachments, using metadata only:",
            error,
          );
          // Already have metadata-only attachments as fallback
        }
      }
    } else {
      // Inline attachments - parse from webhook body
      // Mailgun sends attachments as attachment-1, attachment-2, etc. fields
      // or as file uploads in multipart form data
      allAttachments = parseInlineAttachments(payload);
    }

    if (!bodyPlain && storedMessage?.["body-plain"]) {
      bodyPlain = storedMessage["body-plain"];
    }
    if (!bodyHtml && storedMessage?.["body-html"]) {
      bodyHtml = storedMessage["body-html"];
    }
    if (!strippedText && storedMessage?.["stripped-text"]) {
      strippedText = storedMessage["stripped-text"];
    }
    if (!strippedHtml && storedMessage?.["stripped-html"]) {
      strippedHtml = storedMessage["stripped-html"];
    }

    // Extract providerId from storage URL if available
    const providerId = storageUrl
      ? extractProviderIdFromUrl(storageUrl)
      : undefined;

    // Parse reply information from headers
    const inReplyTo =
      messageHeaders["in-reply-to"] ||
      payload["In-Reply-To"] ||
      messageHeadersFromEvent["in-reply-to"] ||
      "";
    const referencesStr =
      messageHeaders.references ||
      payload.References ||
      messageHeadersFromEvent.references ||
      "";

    // Parse references header (space-separated Message-IDs)
    const references = referencesStr
      ? referencesStr.split(/\s+/).filter((ref) => ref.length > 0)
      : [];

    const reply = buildReplyContext({
      addresses: replyTo ? [replyTo] : undefined,
      messageId: inReplyTo,
      references,
    });
    const inboundEvent: InboundEmailEvent = {
      schemaVersion: "1",
      eventId: `${messageId}:inbound:${timestamp.getTime()}`,
      messageId,
      providerId,
      from,
      to,
      subject,
      text: bodyPlain || strippedText,
      html: bodyHtml || strippedHtml,
      strippedText,
      strippedHtml,
      attachments: allAttachments.length > 0 ? allAttachments : undefined,
      headers: messageHeaders as Record<string, string>,
      timestamp,
      raw: payload,
      reply,
    };

    // Only include cc or bcc if they exist
    if (cc.length > 0) {
      inboundEvent.cc = cc;
    }
    if (bcc.length > 0) {
      inboundEvent.bcc = bcc;
    }

    return inboundEvent;
  }

  // Outbound event
  const statusMap: Record<string, OutboundEmailEvent["status"]> = {
    accepted: "sent",
    delivered: "delivered",
    opened: "opened",
    clicked: "clicked",
    bounced: "bounced",
    failed: "bounced",
    permanent_fail: "bounced",
    temporary_fail: "bounced",
    complained: "complained",
    rejected: "rejected",
    unsubscribed: "complained",
  };

  // Extract recipient (always available in Mailgun events)
  const recipient =
    (eventData.recipient as string | undefined) ||
    (to.length > 0 ? to[0].email : "") ||
    "";

  // Extract providerId from event-data.message.storage.key if available
  const messageStorage =
    eventData.message &&
    typeof eventData.message === "object" &&
    "storage" in eventData.message
      ? (eventData.message.storage as { key?: string; url?: string })
      : undefined;
  const outboundStorage = resolveMailgunStorageLocation(payload);
  const providerId =
    messageStorage?.key ||
    (messageStorage?.url
      ? extractProviderIdFromUrl(messageStorage.url)
      : undefined) ||
    outboundStorage?.key ||
    (outboundStorage?.url
      ? extractProviderIdFromUrl(outboundStorage.url)
      : undefined);

  // Build event - only include optional fields if they're actually available
  const outboundEvent: OutboundEmailEvent = {
    schemaVersion: "1",
    eventId:
      typeof eventData.id === "string"
        ? eventData.id
        : `${event}:${messageId}:${timestamp.getTime()}`,
    messageId,
    providerId,
    recipient,
    status: statusMap[event] || "sent",
    timestamp,
    metadata:
      eventData["user-variables"] &&
      typeof eventData["user-variables"] === "object"
        ? (eventData["user-variables"] as Record<string, string>)
        : undefined,
    recipientDomain:
      (eventData["recipient-domain"] as string | undefined) || undefined,
    raw: payload,
  };

  // Only include from/to/subject if they're actually available (not empty)
  if (fromStr && from.email) {
    outboundEvent.from = from;
  }
  if (to.length > 0 && toStr) {
    outboundEvent.to = to;
  }
  if (subject) {
    outboundEvent.subject = subject;
  }

  return outboundEvent;
};

const findMailgunStoredAttachment = (
  attachments: MailgunStoredAttachment[],
  metadataAttachment: Attachment,
): MailgunStoredAttachment => {
  const metadata = mailgunAttachmentProviderMetadata(
    metadataAttachment.provider,
  );
  const filename = metadata?.filename || metadataAttachment.filename;
  const contentId = cleanContentId(
    metadata?.contentId || metadataAttachment.contentId,
  );

  const byName = filename
    ? attachments.find((attachment) => {
        const attachmentName = attachment.filename || attachment.name;
        return attachmentName === filename;
      })
    : undefined;
  if (byName) return byName;

  const byIndex =
    metadata?.index !== undefined ? attachments[metadata.index] : undefined;
  if (byIndex) return byIndex;

  const byContentId = contentId
    ? attachments.find(
        (attachment) => cleanContentId(attachment["content-id"]) === contentId,
      )
    : undefined;
  if (byContentId) return byContentId;

  return {};
};

/**
 * Internal helper: Retrieve stored attachments from Mailgun
 * This is called automatically by transformMailgunEvent when attachmentHandling is 'stored'
 * and a storage URL is available. Users should not call this directly.
 *
 * Can fetch attachments in two ways:
 * 1. Directly from attachment URLs if provided in metadata
 * 2. By fetching the message from storage URL and then fetching attachments
 */
const retrieveStoredAttachments = async ({
  storageUrl,
  apiKey,
  attachmentMetadata,
  storedMessage,
}: {
  storageUrl: string;
  apiKey: string;
  attachmentMetadata: Attachment[];
  storedMessage?: MailgunStoredMessage | null;
}): Promise<{
  attachments: Attachment[];
  storedMessage?: MailgunStoredMessage | null;
}> => {
  const attachments: Attachment[] = [];
  let messageData: MailgunStoredMessage | null =
    storedMessage !== undefined ? storedMessage : null;

  // If attachment metadata already has URLs, fetch directly from those URLs
  // This is more efficient than fetching the message first
  const attachmentsWithUrls = attachmentMetadata
    .map((att) => {
      const metadata = mailgunAttachmentProviderMetadata(att.provider);
      const directUrl =
        metadata?.attachmentUrl ||
        (isDirectMailgunAttachmentUrl(att.url, storageUrl)
          ? att.url
          : undefined);
      return { attachment: att, directUrl };
    })
    .filter(
      (entry): entry is { attachment: Attachment; directUrl: string } =>
        entry.directUrl !== undefined,
    );

  if (attachmentsWithUrls.length > 0) {
    const basic = `Basic ${stringToBase64(`api:${apiKey}`)}`;
    for (const {
      attachment: attachmentMeta,
      directUrl,
    } of attachmentsWithUrls) {
      try {
        const res = await fetch(directUrl, {
          headers: { Authorization: basic },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = new Uint8Array(await res.arrayBuffer());

        attachments.push({
          ...attachmentMeta,
          content: buf,
          url: directUrl,
        });
      } catch (error) {
        console.error(
          `Failed to retrieve attachment ${attachmentMeta.filename}:`,
          error,
        );
        attachments.push(attachmentMeta);
      }
    }

    if (attachments.length > 0) {
      return { attachments, storedMessage: messageData };
    }
  }

  // Fallback: Try fetching from message storage URL
  // This handles cases where attachment URLs aren't directly available
  if (!messageData) {
    messageData = await fetchMailgunStoredMessage({ storageUrl, apiKey });
  }

  if (messageData?.attachments && Array.isArray(messageData.attachments)) {
    const basic = `Basic ${stringToBase64(`api:${apiKey}`)}`;
    for (const attachmentMeta of attachmentMetadata) {
      const attachment = findMailgunStoredAttachment(
        messageData.attachments,
        attachmentMeta,
      );
      const filename = attachment.filename || attachment.name;
      if (attachment.url && filename) {
        try {
          const ares = await fetch(attachment.url, {
            headers: { Authorization: basic },
          });
          if (!ares.ok) throw new Error(`HTTP ${ares.status}`);
          const buf = new Uint8Array(await ares.arrayBuffer());

          attachments.push({
            ...attachmentMeta,
            content: buf,
            contentType: attachment["content-type"],
            url: attachment.url,
            size: attachment.size,
          });
        } catch (error) {
          console.error(`Failed to retrieve attachment ${filename}:`, error);
          attachments.push(attachmentMeta);
        }
      } else {
        attachments.push(attachmentMeta);
      }
    }
  }

  return {
    attachments: attachments.length > 0 ? attachments : attachmentMetadata,
    storedMessage: messageData,
  };
};

/**
 * Mailgun email driver
 *
 * Supports both inline and stored attachment handling:
 * - 'inline': Attachments come directly in webhook (default, limited by server body size)
 * - 'stored': Messages stored, attachments are automatically fetched via API when handling webhooks (requires paid tier)
 *
 * When using 'stored' mode, attachments are automatically retrieved and included with content
 * in the transformed event data passed to hooks. No manual fetching required.
 */
/**
 * Extract domain from email address
 * Example: "sender@example.com" -> "example.com"
 */
const extractDomainFromEmail = (email: string): string => {
  const parts = email.split("@");
  if (parts.length !== 2) {
    throw new Error(`Invalid email address format: ${email}`);
  }
  return parts[1]!;
};

/**
 * Map Mailgun domain state to standardized DomainStatus
 */
const mapDomainStatus = (state: string | undefined): DomainStatus => {
  if (!state) return "unknown";
  const normalized = state.toLowerCase();
  switch (normalized) {
    case "active":
      return "verified";
    case "unverified":
      return "unverified";
    case "pending":
      return "pending";
    case "disabled":
      return "disabled";
    default:
      return "unknown";
  }
};

/**
 * Map Mailgun DNS record to standardized DomainDNSRecord
 */
const mapDnsRecord = (
  record: {
    record_type?: string;
    name?: string;
    value?: string;
    priority?: string | number;
    valid?: string | boolean;
    is_active?: boolean;
    cached?: string[];
  },
  purpose?: DomainRecordPurpose,
): DomainDNSRecord => {
  const type = (record.record_type?.toUpperCase() ||
    "TXT") as DomainDNSRecord["type"];
  const priority =
    record.priority !== undefined
      ? typeof record.priority === "string"
        ? parseInt(record.priority, 10)
        : record.priority
      : undefined;

  // Determine purpose from record type and name if not provided
  let recordPurpose = purpose;
  if (!recordPurpose) {
    const name = (record.name || "").toLowerCase();
    if (name.includes("dkim") || name.includes("selector")) {
      recordPurpose = "dkim";
    } else if (name.includes("dmarc")) {
      recordPurpose = "dmarc";
    } else if (name.includes("spf") || type === "TXT") {
      const value = (record.value || "").toLowerCase();
      if (value.includes("v=spf1")) {
        recordPurpose = "spf";
      } else if (value.includes("v=dkim1")) {
        recordPurpose = "dkim";
      } else if (value.includes("v=dmarc1")) {
        recordPurpose = "dmarc";
      }
    } else if (type === "MX") {
      recordPurpose = "mx";
    } else if (name.includes("return-path") || name.includes("bounce")) {
      recordPurpose = "returnPath";
    }
  }

  return {
    type,
    name: record.name || "",
    value: record.value || "",
    priority,
    purpose: recordPurpose,
    verified: record.valid === "valid" || record.valid === true,
    lastCheckedAt: undefined,
  };
};

/**
 * Parse Mailgun DNS records from domain response
 */
const parseDnsRecords = (
  sendingRecords?: Array<{
    record_type?: string;
    name?: string;
    value?: string;
    priority?: string | number;
    valid?: string | boolean;
    is_active?: boolean;
    cached?: string[];
  }>,
  receivingRecords?: Array<{
    record_type?: string;
    name?: string;
    value?: string;
    priority?: string | number;
    valid?: string | boolean;
    is_active?: boolean;
    cached?: string[];
  }>,
): DomainDNSRecord[] => {
  const records: DomainDNSRecord[] = [];

  // Map sending records (SPF, DKIM, etc.)
  if (Array.isArray(sendingRecords)) {
    for (const record of sendingRecords) {
      records.push(mapDnsRecord(record));
    }
  }

  // Map receiving records (MX records)
  if (Array.isArray(receivingRecords)) {
    for (const record of receivingRecords) {
      records.push(mapDnsRecord(record, "mx"));
    }
  }

  return records;
};

const MAILGUN_WEBHOOK_EVENTS = [
  "accepted",
  "clicked",
  "opened",
  "unsubscribed",
  "delivered",
  "permanent_fail",
  "temporary_fail",
  "complained",
] as const;

type MailgunWebhookEvent = (typeof MAILGUN_WEBHOOK_EVENTS)[number];

const DEFAULT_EMAILKIT_WEBHOOK_EVENTS: WebhookEventType[] = [
  "outbound",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
];

const ALL_EMAILKIT_WEBHOOK_EVENTS: WebhookEventType[] = [
  ...DEFAULT_EMAILKIT_WEBHOOK_EVENTS,
  "unsubscribed",
];

const isMailgunWebhookEvent = (event: string): event is MailgunWebhookEvent =>
  (MAILGUN_WEBHOOK_EVENTS as readonly string[]).includes(event);

const unique = <T extends string>(values: T[]): T[] =>
  Array.from(new Set(values));

const escapeRegexLiteral = (value: string): string =>
  value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

const mapWebhookEventToMailgun = (
  event: WebhookEventType,
): {
  providerEvents: MailgunWebhookEvent[];
  normalizedEvents: WebhookEventType[];
  inbound?: boolean;
} => {
  switch (event) {
    case "inbound":
      return {
        providerEvents: [],
        normalizedEvents: ["inbound"],
        inbound: true,
      };
    case "outbound":
    case "accepted":
      return { providerEvents: ["accepted"], normalizedEvents: ["outbound"] };
    case "delivered":
      return {
        providerEvents: ["delivered"],
        normalizedEvents: ["delivered"],
      };
    case "opened":
      return { providerEvents: ["opened"], normalizedEvents: ["opened"] };
    case "clicked":
      return { providerEvents: ["clicked"], normalizedEvents: ["clicked"] };
    case "bounced":
    case "failed":
      return {
        providerEvents: ["permanent_fail", "temporary_fail"],
        normalizedEvents: ["bounced"],
      };
    case "permanent_fail":
    case "temporary_fail":
      return {
        providerEvents: [event as MailgunWebhookEvent],
        normalizedEvents: ["bounced"],
      };
    case "complained":
      return {
        providerEvents: ["complained"],
        normalizedEvents: ["complained"],
      };
    case "unsubscribed":
      return {
        providerEvents: ["unsubscribed"],
        normalizedEvents: ["unsubscribed"],
      };
    default:
      if (isMailgunWebhookEvent(event)) {
        return { providerEvents: [event], normalizedEvents: [event] };
      }
      throw new EmailKitError(
        `Mailgun webhook event '${event}' is not supported by Mailgun's webhook management API`,
        "mailgun",
      );
  }
};

const resolveMailgunWebhookEvents = (
  events?: WebhookEventSelection,
  inbound?: WebhookInboundOptions,
): {
  providerEvents: MailgunWebhookEvent[];
  normalizedEvents: WebhookEventType[];
  wantsInbound: boolean;
} => {
  const wantsAll = events === "all";
  const requestedEvents = wantsAll
    ? ALL_EMAILKIT_WEBHOOK_EVENTS
    : events && events.length > 0
      ? events
      : DEFAULT_EMAILKIT_WEBHOOK_EVENTS;

  const providerEvents: MailgunWebhookEvent[] = [];
  const normalizedEvents: WebhookEventType[] = [];
  let wantsInbound = false;

  for (const event of requestedEvents) {
    const mapped = mapWebhookEventToMailgun(event);
    providerEvents.push(...mapped.providerEvents);
    normalizedEvents.push(...mapped.normalizedEvents);
    wantsInbound ||= mapped.inbound === true;
  }
  if (wantsAll && inbound) {
    normalizedEvents.push("inbound");
    wantsInbound = true;
  }

  return {
    providerEvents: unique(providerEvents),
    normalizedEvents: unique(normalizedEvents),
    wantsInbound,
  };
};

const normalizeMailgunEvents = (
  events: readonly string[] | undefined,
): WebhookEventType[] => {
  if (!events || events.length === 0) return [];

  const normalized: WebhookEventType[] = [];
  for (const event of events) {
    if (event === "accepted") {
      normalized.push("outbound");
    } else if (event === "permanent_fail" || event === "temporary_fail") {
      normalized.push("bounced");
    } else if (isMailgunWebhookEvent(event)) {
      normalized.push(event);
    }
  }
  return unique(normalized);
};

const readMailgunApiResponse = async (res: Response): Promise<unknown> => {
  if (res.status === 204) return undefined;

  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }

  const text = await res.text();
  if (!text) return undefined;
  return text;
};

const throwMailgunApiError = (
  body: unknown,
  status: number,
  fallback: string,
): never => {
  throw new EmailKitError(
    typeof (body as any)?.message === "string"
      ? (body as any).message
      : typeof (body as any)?.Description === "string"
        ? (body as any).Description
        : typeof body === "string"
          ? body
          : fallback,
    "mailgun",
    undefined,
    status,
    undefined,
    body,
  );
};

const fetchMailgunStoredAttachmentUrl = async ({
  url,
  apiKey,
  filename,
}: {
  url: string;
  apiKey: string;
  filename?: string;
}): Promise<Response> => {
  if (!apiKey) {
    throw new EmailKitError(
      "Mailgun attachment retrieval requires an API key",
      "mailgun",
      "MISSING_AUTH",
    );
  }

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${stringToBase64(`api:${apiKey}`)}` },
  });
  if (!res.ok) {
    const raw = await readMailgunApiResponse(res);
    throw new EmailKitError(
      `Failed to fetch Mailgun attachment${filename ? ` ${filename}` : ""}`,
      "mailgun",
      "ATTACHMENT_FETCH_FAILED",
      res.status,
      undefined,
      raw,
    );
  }
  return res;
};

const fetchMailgunAttachmentFromMetadata = async ({
  metadata,
  apiKey,
}: {
  metadata: MailgunAttachmentProviderMetadata;
  apiKey: string;
}): Promise<Response> => {
  if (metadata.attachmentUrl) {
    return fetchMailgunStoredAttachmentUrl({
      url: metadata.attachmentUrl,
      apiKey,
      filename: metadata.filename,
    });
  }

  if (!metadata.storageUrl) {
    throw new EmailKitError(
      "Mailgun attachment metadata does not include a storage URL",
      "mailgun",
      "ATTACHMENT_CONTENT_UNAVAILABLE",
      undefined,
      undefined,
      metadata,
    );
  }

  if (!apiKey) {
    throw new EmailKitError(
      "Mailgun stored message retrieval requires an API key",
      "mailgun",
      "MISSING_AUTH",
    );
  }

  const storageResponse = await fetch(metadata.storageUrl, {
    headers: { Authorization: `Basic ${stringToBase64(`api:${apiKey}`)}` },
  });
  const storedMessageBody = await readMailgunApiResponse(storageResponse);
  if (!storageResponse.ok) {
    throw new EmailKitError(
      "Failed to fetch Mailgun stored message for attachment",
      "mailgun",
      "STORED_MESSAGE_FETCH_FAILED",
      storageResponse.status,
      undefined,
      storedMessageBody,
    );
  }

  const storedMessage = storedMessageBody as MailgunStoredMessage;
  const storedAttachments = Array.isArray(storedMessage.attachments)
    ? storedMessage.attachments
    : [];
  const matchingAttachment = findMailgunStoredAttachment(storedAttachments, {
    filename: metadata.filename || "attachment",
    contentId: metadata.contentId,
    provider: { [MAILGUN_PROVIDER_METADATA_KEY]: metadata },
  });

  if (!matchingAttachment.url) {
    throw new EmailKitError(
      "Mailgun stored message did not include a matching attachment URL",
      "mailgun",
      "ATTACHMENT_NOT_FOUND",
      undefined,
      undefined,
      {
        metadata,
        attachments: storedAttachments.map((attachment) => ({
          filename: attachment.filename || attachment.name,
          contentId: attachment["content-id"],
          hasUrl: Boolean(attachment.url),
        })),
      },
    );
  }

  return fetchMailgunStoredAttachmentUrl({
    url: matchingAttachment.url,
    apiKey,
    filename: metadata.filename,
  });
};

const mailgunDate = (value: unknown): Date | undefined =>
  typeof value === "string" ? new Date(value) : undefined;

const normalizeMailgunAccountWebhook = (
  raw: unknown,
  fallback?: Partial<Webhook>,
): Webhook => {
  const data = (raw || {}) as {
    webhook_id?: string;
    url?: string;
    event_types?: string[];
    created_at?: string;
  };
  const id = data.webhook_id || fallback?.providerId || fallback?.id || "";
  const providerId = Object.prototype.hasOwnProperty.call(
    fallback || {},
    "providerId",
  )
    ? fallback?.providerId
    : id;

  return {
    id,
    scope: "account",
    url: data.url || fallback?.url || "",
    events:
      fallback?.events ||
      (data.event_types && data.event_types.length > 0
        ? normalizeMailgunEvents(data.event_types)
        : undefined),
    status: "active",
    providerId,
    createdAt: mailgunDate(data.created_at) || fallback?.createdAt,
    provider: fallback?.provider,
    raw,
  };
};

const normalizeMailgunDomainWebhook = (input: {
  domain: string;
  url: string;
  events?: WebhookEventType[];
  providerEvents?: MailgunWebhookEvent[];
  providerId?: string;
  routeId?: string;
  raw?: unknown;
  status?: Webhook["status"];
}): Webhook => {
  const providerId = input.providerId || `domain:${input.domain}:${input.url}`;

  return {
    id: providerId,
    scope: "domain",
    url: input.url,
    events: input.events,
    status: input.status || "active",
    providerId,
    provider: {
      domain: input.domain,
      deliveryEvents: input.providerEvents,
      routeId: input.routeId,
    },
    raw: input.raw,
  };
};

const resolveWebhookReferenceId = (input: {
  webhook?: Webhook;
  webhookId?: string;
  providerId?: string;
}): string =>
  input.providerId ||
  input.webhook?.providerId ||
  input.webhookId ||
  input.webhook?.id ||
  "";

const resolveMailgunRouteId = (input: {
  webhook?: Webhook;
  provider?: Record<string, unknown>;
}): string | undefined => {
  const routeId = input.provider?.routeId || input.webhook?.provider?.routeId;
  return typeof routeId === "string" && routeId.trim() ? routeId : undefined;
};

const resolveMailgunAccountWebhookId = (input: {
  webhook?: Webhook;
  webhookId?: string;
  providerId?: string;
  provider?: Record<string, unknown>;
}): string => {
  const webhookId = resolveWebhookReferenceId(input);
  const routeId = resolveMailgunRouteId(input);
  const deliveryEvents = input.webhook?.provider?.deliveryEvents;
  if (
    webhookId &&
    routeId &&
    Array.isArray(deliveryEvents) &&
    deliveryEvents.length === 0 &&
    (webhookId === input.webhook?.providerId || webhookId === input.webhook?.id)
  ) {
    return "";
  }
  return webhookId;
};

const resolveWebhookDomain = (input: {
  domain?: string;
  webhook?: Webhook;
  provider?: Record<string, unknown>;
}): string => {
  const fromProvider = input.provider?.domain;
  const fromWebhookProvider = input.webhook?.provider?.domain;
  if (input.domain) return input.domain;
  if (typeof fromProvider === "string") return fromProvider;
  if (typeof fromWebhookProvider === "string") return fromWebhookProvider;
  throw new EmailKitError(
    "Mailgun domain webhook operations require a domain",
    "mailgun",
  );
};

const extractDomainEventsForUrl = (
  raw: unknown,
  url: string,
): {
  providerEvents: MailgunWebhookEvent[];
  normalizedEvents: WebhookEventType[];
} => {
  const webhooks = (raw as any)?.webhooks;
  const providerEvents: MailgunWebhookEvent[] = [];

  if (webhooks && typeof webhooks === "object") {
    for (const [event, value] of Object.entries(webhooks)) {
      const urls = (value as any)?.urls;
      if (
        isMailgunWebhookEvent(event) &&
        Array.isArray(urls) &&
        urls.includes(url)
      ) {
        providerEvents.push(event);
      }
    }
  }

  return {
    providerEvents: unique(providerEvents),
    normalizedEvents: normalizeMailgunEvents(providerEvents),
  };
};

const escapeMailgunRouteString = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const requireMailgunWebhookUrl = (
  url: string | undefined,
  scope: "account" | "domain",
): string => {
  const normalizedUrl = url?.trim();
  if (!normalizedUrl) {
    throw new EmailKitError(
      `Mailgun ${scope} webhook setup requires a url`,
      "mailgun",
    );
  }
  return normalizedUrl;
};

const resolveMailgunRouteExpression = (input: {
  provider?: Record<string, unknown>;
  inbound?: WebhookInboundOptions;
}): string => {
  const inbound = input.inbound;
  if (
    typeof inbound?.routeExpression === "string" &&
    inbound.routeExpression.trim()
  ) {
    return inbound.routeExpression;
  }
  if (inbound?.recipients === "all") {
    return 'match_recipient(".*")';
  }
  if (typeof inbound?.recipients === "string" && inbound.recipients.trim()) {
    return `match_recipient("^(?:${escapeRegexLiteral(inbound.recipients)})$")`;
  }
  if (Array.isArray(inbound?.recipients) && inbound.recipients.length > 0) {
    const recipients = inbound.recipients
      .map((recipient) => recipient.trim())
      .filter(Boolean);
    if (recipients.length > 0) {
      return `match_recipient("^(?:${recipients
        .map(escapeRegexLiteral)
        .join("|")})$")`;
    }
  }

  const provider = input.provider || {};
  const expression = provider.routeExpression || provider.expression;
  if (typeof expression === "string" && expression.trim()) {
    return expression;
  }

  const recipient =
    provider.routeRecipient || provider.recipient || provider.address;
  if (typeof recipient === "string" && recipient.trim()) {
    return `match_recipient("${escapeMailgunRouteString(recipient)}")`;
  }

  throw new EmailKitError(
    "Mailgun inbound route setup requires inbound.recipients, inbound.routeExpression, provider.routeExpression, or provider.routeRecipient/provider.recipient/provider.address",
    "mailgun",
  );
};

const createMailgunInboundRoute = async (input: {
  url: string;
  provider?: Record<string, unknown>;
  inbound?: WebhookInboundOptions;
  defaultDescription: string;
  baseUrl: string;
  auth: string;
}): Promise<{ routeId?: string; raw: unknown }> => {
  const routeExpression = resolveMailgunRouteExpression(input);
  const body = new URLSearchParams();
  const provider = input.provider || {};
  const priority =
    typeof provider.routePriority === "number"
      ? provider.routePriority
      : typeof provider.priority === "number"
        ? provider.priority
        : 0;

  body.append("priority", String(priority));
  body.append(
    "description",
    typeof provider.routeDescription === "string"
      ? provider.routeDescription
      : input.defaultDescription,
  );
  body.append("expression", routeExpression);
  body.append("action", `forward("${escapeMailgunRouteString(input.url)}")`);

  const res = await fetch(`${input.baseUrl}/routes`, {
    method: "POST",
    headers: {
      Authorization: input.auth,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  const raw = await readMailgunApiResponse(res);
  if (!res.ok) {
    throwMailgunApiError(
      raw,
      res.status,
      `HTTP ${res.status}: Failed to create inbound route`,
    );
  }

  const routeId =
    typeof (raw as any)?.route?.id === "string"
      ? (raw as any).route.id
      : undefined;
  return { routeId, raw };
};

/**
 * Mailgun driver capabilities
 */
export const MAILGUN_CAPABILITIES = {
  cc: true,
  bcc: true,
  replyTo: true,
  replyHeaders: true,
  replyThreadId: false,
  attachments: true,
  customHeaders: true,
  tags: true,
  metadata: true,
  templates: true,
  personalizations: false, // Mailgun doesn't support per-recipient personalizations
  scheduling: true, // Mailgun supports scheduled sending
  unsubscribe: false,
  sendTracking: { opens: true, clicks: true },
  eventTracking: { opens: true, clicks: true },
  sandbox: true,
  sendIdempotency: false,
  tenantRouting: true,
  providerFetch: true,
  domains: {
    list: true,
    create: true,
    get: true,
    update: true,
    verify: true,
    delete: true,
    identifier: "domain" as const,
  },
  webhooks: { account: true, domain: true },
  publicRoutes: { webhook: true },
  requiresSecret: false,
} as const satisfies DriverCapabilities;

/**
 * Type helper for Mailgun capabilities
 */
export type MailgunCapabilities = typeof MAILGUN_CAPABILITIES;

export const MailgunDriver = <const TId extends string = "mailgun">(
  config: MailgunDriverConfig<TId>,
): EmailDriver<MailgunDriverConfig<TId>, typeof MAILGUN_CAPABILITIES, TId> => {
  const driverId = (config.id || "mailgun") as TId;
  // Determine region (default to 'us')
  const region = config.region || "us";

  // Get API base URL (use config override or default based on region)
  const apiBase = config.apiBase || MAILGUN_ENDPOINTS[region].apiBase;
  const baseUrl = `${apiBase}/v3`;
  const baseUrlV4 = `${apiBase}/v4`;

  // Basic auth header for API requests
  const auth = `Basic ${stringToBase64(`api:${config.apiKey}`)}`;
  const baseProviderFetch = createProviderFetch({
    baseUrl: apiBase,
    defaultHeaders: {
      Authorization: auth,
    },
  });

  return {
    id: driverId,
    name: "mailgun",
    capabilities: MAILGUN_CAPABILITIES,
    providerFetch: async (path, init) => {
      const attachmentMetadata = mailgunAttachmentProviderMetadata(
        init?.provider,
      );
      if (attachmentMetadata) {
        return fetchMailgunAttachmentFromMetadata({
          metadata: attachmentMetadata,
          apiKey: config.apiKey,
        });
      }

      return baseProviderFetch(path, init);
    },

    sendEmail: async (
      message: EmailMessage<typeof MAILGUN_CAPABILITIES, EmailTag>,
      options?: SendEmailOptions,
    ): Promise<SendEmailResult> => {
      // Extract domain from the 'from' email address
      // Mailgun requires the domain in the URL path to match the domain in the 'from' field
      const domain = extractDomainFromEmail(message.from.email);
      const formData = new FormData();

      // Required fields
      formData.append("from", formatEmailAddress(message.from));
      formData.append("to", formatEmailAddresses(message.to));
      formData.append("subject", message.subject);

      // Optional fields
      if (message.text) {
        formData.append("text", message.text);
      }
      if (message.html) {
        formData.append("html", message.html);
      }
      if (message.templateId) {
        formData.append("template", message.templateId);
      }
      if (message.templateData) {
        formData.append("t:variables", JSON.stringify(message.templateData));
      }
      if (message.cc) {
        formData.append("cc", formatEmailAddresses(message.cc));
      }
      if (message.bcc) {
        formData.append("bcc", formatEmailAddresses(message.bcc));
      }
      const reply = resolveMessageReplyContext(message);
      if (hasReplyData(reply)) {
        if (reply.threadId) {
          throw new EmailKitError(
            "Mailgun does not support provider thread IDs for replies. Use reply.messageId and reply.references for RFC threading.",
            "mailgun",
            "UNSUPPORTED_REPLY_THREAD_ID",
          );
        }
        if (
          reply.isReply &&
          !reply.messageId &&
          (!reply.references || reply.references.length === 0)
        ) {
          throw new EmailKitError(
            "Mailgun cannot send a reply from reply.isReply alone. Provide reply.messageId or reply.references.",
            "mailgun",
            "UNSUPPORTED_REPLY_FLAG",
          );
        }
        const replyAddresses = replyAddressesAsArray(reply);
        if (replyAddresses.length > 0) {
          const formattedReply =
            replyAddresses.length === 1
              ? formatEmailAddresses(replyAddresses[0])
              : formatEmailAddresses(replyAddresses);
          formData.append("h:Reply-To", formattedReply);
        }
        if (reply.messageId && !message.headers?.["In-Reply-To"]) {
          formData.append("h:In-Reply-To", reply.messageId);
        }
        if (
          reply.references &&
          reply.references.length > 0 &&
          !message.headers?.["References"]
        ) {
          formData.append("h:References", reply.references.join(" "));
        }
      }

      // Attachments
      if (message.attachments) {
        for (const attachment of message.attachments) {
          // Convert content to Uint8Array or string for File constructor
          const fileContent = await resolveMailgunAttachmentContent(attachment);

          // For inline attachments, use 'inline' instead of 'attachment'
          // Mailgun generates Content-ID automatically from the filename
          // Mailgun typically uses the filename (without extension) as the Content-ID
          // So we use contentId as the filename (without extension) for inline attachments
          let fileName = attachment.filename;
          if (attachment.isInline && attachment.contentId) {
            // For inline attachments, use contentId as filename (without extension)
            // so Mailgun generates Content-ID matching our cid: reference
            // Mailgun will wrap it in angle brackets: <apollo-logo>
            // and we reference it as cid:apollo-logo in HTML
            fileName = attachment.contentId;
          }

          // Use Blob + filename for Node/Edge portability
          const blob = new Blob([fileContent as any], {
            type: attachment.contentType || "application/octet-stream",
          });

          if (attachment.isInline) {
            formData.append("inline", blob, fileName);
          } else {
            formData.append("attachment", blob, fileName);
          }
        }
      }

      // Custom headers
      if (message.headers) {
        for (const [key, value] of Object.entries(message.headers)) {
          formData.append(`h:${key}`, String(value));
        }
      }

      // Tags
      if (message.tags) {
        for (const tag of message.tags) {
          formData.append("o:tag", formatMailgunTag(tag));
        }
      }

      // Tenant routing (capability)
      if ("tenantId" in message && message.tenantId) {
        formData.append("o:tag", `tenant:${message.tenantId}`);
      }

      // Tracking (new grouped config)
      if ("track" in message && message.track !== undefined) {
        const track = message.track;
        if (track.opens === false) {
          formData.append("o:tracking-opens", "no");
        } else if (track.opens === true) {
          formData.append("o:tracking-opens", "yes");
        }

        if (track.clicks === false) {
          formData.append("o:tracking-clicks", "no");
        } else if (track.clicks === true) {
          formData.append("o:tracking-clicks", "yes");
        }
      } else if (
        "trackingEnabled" in message &&
        message.trackingEnabled === false
      ) {
        // Legacy support: disable all tracking
        formData.append("o:tracking", "no");
      }

      // Scheduling
      if ("sendAt" in message && message.sendAt !== undefined) {
        const sendAt =
          typeof message.sendAt === "number"
            ? new Date(message.sendAt)
            : message.sendAt;
        // Mailgun expects RFC 2822/RFC 822 style delivery time.
        formData.append("o:deliverytime", formatMailgunDeliveryTime(sendAt));
      }

      // Unsubscribe configuration
      if ("unsubscribe" in message && message.unsubscribe !== undefined) {
        throw new EmailKitError(
          "Mailgun send does not support EmailKit's normalized unsubscribe options.",
          "mailgun",
          "UNSUPPORTED_UNSUBSCRIBE",
        );
      }

      if ("sandbox" in message && message.sandbox === true) {
        formData.append("o:testmode", "yes");
      }

      if ("idempotencyKey" in message) {
        throw new EmailKitError(
          "Mailgun does not support idempotency keys for sends.",
          "mailgun",
          "UNSUPPORTED_IDEMPOTENCY_KEY",
        );
      }

      if ("provider" in message && message.provider) {
        const providerOptions = message.provider as Record<string, unknown>;
        if ("idempotencyKey" in providerOptions) {
          throw new EmailKitError(
            "Mailgun does not support idempotency keys for sends.",
            "mailgun",
            "UNSUPPORTED_IDEMPOTENCY_KEY",
          );
        }
        // Pass through other provider-specific options
        for (const [key, value] of Object.entries(providerOptions)) {
          if (key !== "idempotencyKey" && value !== undefined) {
            formData.append(`o:${key}`, String(value));
          }
        }
      }

      // User variables (metadata)
      if (message.metadata) {
        for (const [key, value] of Object.entries(message.metadata)) {
          formData.append(`v:${key}`, String(value));
        }
      }

      try {
        const res = await fetch(`${baseUrl}/${domain}/messages`, {
          method: "POST",
          headers: {
            Authorization: auth,
          },
          body: formData,
          signal: options?.signal,
        });

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          const message =
            (typeof body === "object" && (body as any)?.message) ||
            (typeof body === "string" ? body : "Mailgun API error");
          throw new EmailKitError(
            message,
            "mailgun",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const data = body as { id?: string; message?: string } | string;
        const id =
          typeof data === "object" && data ? (data as any).id : undefined;
        return {
          messageId: id || `${Date.now()}@mailgun`,
          provider: driverId,
          providerId: id,
        };
      } catch (error) {
        if (error instanceof EmailKitError) {
          throw error;
        }
        throw new EmailKitError(
          error instanceof Error ? error.message : "Unknown error",
          "mailgun",
          undefined,
          undefined,
          error,
        );
      }
    },

    handleWebhook: async (request: WebhookRequest): Promise<WebhookEvent> => {
      const payload = request.body as MailgunWebhookPayload;
      const eventData = payload["event-data"] || payload;
      const event = eventData.event || payload.event || "unknown";

      // Get attachment handling mode from config
      const attachmentHandling = config.inboundAttachmentHandling || "inline";

      // Check if this is an inbound email FIRST (before checking event type)
      // Inbound emails come as form data with body-plain/body-html fields but no event field
      // OR they have a message-url (stored message) without event-data
      const isInboundEmailWebhook =
        // Has body content fields (typical inbound email)
        (payload["body-plain"] !== undefined ||
          payload["body-html"] !== undefined ||
          payload["From"] !== undefined ||
          payload.from !== undefined ||
          payload.sender !== undefined ||
          payload["X-Mailgun-Incoming"] === "Yes") &&
        // But NOT an event field (that's for outbound webhooks)
        payload.event === undefined &&
        payload["event-data"] === undefined;

      if (isInboundMailgunAcceptedEvent(payload)) {
        const storage = resolveMailgunStorageLocation(payload);
        const headers = parseMailgunMessageHeaders(
          payload["event-data"]?.message?.headers,
        );
        return {
          type: "unknown",
          data: {
            reason: "mailgun.inbound_accepted_lifecycle",
            event,
            eventId:
              typeof payload["event-data"]?.id === "string"
                ? payload["event-data"].id
                : undefined,
            messageId: headers["message-id"],
            providerId:
              storage?.key ||
              (storage?.url
                ? extractProviderIdFromUrl(storage.url)
                : undefined),
            raw: payload,
          },
        };
      }

      // Also check for stored messages with any Mailgun storage location.
      const isStoredMessageWebhook =
        resolveMailgunStorageLocation(payload) !== undefined &&
        (payload["event-data"] === undefined ||
          event === "stored" ||
          payload["event-data"].event === undefined) &&
        payload.event === undefined;

      if (isInboundEmailWebhook || isStoredMessageWebhook) {
        // Transform to standard format (async - handles stored attachments internally)
        const transformedEvent = await transformMailgunEvent({
          payload,
          attachmentHandling,
          apiKey: config.apiKey,
          autoFetchAttachments: config.autoFetchInboundAttachments ?? true,
        });
        return { type: "inbound", data: transformedEvent as InboundEmailEvent };
      }

      // Transform to standard format (async - handles stored attachments internally)
      const transformedEvent = await transformMailgunEvent({
        payload,
        attachmentHandling,
        apiKey: config.apiKey,
        autoFetchAttachments: config.autoFetchInboundAttachments ?? true,
      });

      // Map Mailgun events to our event types
      // According to Mailgun docs: https://documentation.mailgun.com/docs/mailgun/user-manual/events/webhooks
      // Supported webhook types: Accepted, Delivered, Clicks (opened/clicked), Spam Complaints, Unsubscribes, Permanent Failures, Temporary Failures
      switch (event) {
        case "stored":
          // Check if this is an inbound email (stored messages are always inbound)
          if (
            payload["body-plain"] !== undefined ||
            payload["body-html"] !== undefined ||
            resolveMailgunStorageLocation(payload) !== undefined
          ) {
            return {
              type: "inbound",
              data: transformedEvent as InboundEmailEvent,
            };
          }
          return {
            type: "outbound",
            data: transformedEvent as OutboundEmailEvent,
          };

        case "accepted":
          return {
            type: "outbound",
            data: transformedEvent as OutboundEmailEvent,
          };

        case "delivered":
          return {
            type: "delivered",
            data: transformedEvent as OutboundEmailEvent,
          };

        case "opened":
          // Mailgun "opened" event - email was opened (tracking pixel)
          // Extract IP and user agent from event-data
          const openedIp = (eventData.ip as string | undefined) || undefined;

          // Extract user-agent from client-info object
          const openedClientInfo = eventData["client-info"] as
            | { "user-agent"?: string }
            | undefined;
          const openedUserAgent = openedClientInfo?.["user-agent"] || undefined;

          return {
            type: "opened",
            data: {
              ...(transformedEvent as OutboundEmailEvent),
              ip: openedIp,
              userAgent: openedUserAgent,
            },
          } as WebhookEvent;

        case "clicked":
          // Extract URL, IP, and user agent from event-data
          // Mailgun provides these fields for clicked events
          const clickedUrl = (eventData.url as string | undefined) || undefined;
          const clickedIp = (eventData.ip as string | undefined) || undefined;

          // Extract user-agent from client-info object
          const clientInfo = eventData["client-info"] as
            | { "user-agent"?: string }
            | undefined;
          const clickedUserAgent = clientInfo?.["user-agent"] || undefined;

          return {
            type: "clicked",
            data: {
              ...(transformedEvent as OutboundEmailEvent),
              url: clickedUrl,
              ip: clickedIp,
              userAgent: clickedUserAgent,
            },
          } as WebhookEvent;

        case "bounced":
        case "failed":
        case "permanent_fail":
        case "temporary_fail":
          const deliveryStatus = eventData["delivery-status"] as
            | {
                message?: string;
                code?: number;
                "enhanced-code"?: string;
                description?: string;
              }
            | undefined;
          const bounceReason =
            deliveryStatus?.message ||
            (eventData.reason as string | undefined) ||
            (payload.reason as string | undefined) ||
            "Unknown error";

          // Determine severity based on event type or explicit severity field
          let severity: "permanent" | "temporary" | undefined;
          if (
            eventData.severity === "permanent" ||
            eventData.severity === "temporary"
          ) {
            severity = eventData.severity;
          } else if (event === "permanent_fail" || event === "failed") {
            severity = "permanent";
          } else if (event === "temporary_fail") {
            severity = "temporary";
          }

          // Extract error code from delivery-status
          const errorCode = deliveryStatus?.code || undefined;

          // Extract SMTP response (usually the delivery-status message)
          const smtpResponse = deliveryStatus?.message || undefined;

          return {
            type: "bounced",
            data: {
              ...(transformedEvent as OutboundEmailEvent),
              reason: bounceReason,
              severity,
              code: errorCode,
              smtpResponse,
            },
          } as WebhookEvent;

        case "complained":
        case "unsubscribed":
          return {
            type: "complained",
            data: transformedEvent as OutboundEmailEvent,
          };

        case "rejected":
          return {
            type: "rejected",
            data: {
              ...(transformedEvent as OutboundEmailEvent),
              reason: payload.reason || "Rejected by Mailgun",
            },
          } as WebhookEvent;

        default:
          return { type: "unknown", data: payload };
      }
    },

    verifyWebhook: async (request: WebhookRequest): Promise<boolean> => {
      // Mailgun webhook signature verification
      // Documentation: https://documentation.mailgun.com/docs/webhooks#webhook-signing

      // If no webhook signing key is provided, skip verification
      if (!config.webhookSigningKey) {
        return true;
      }

      const payload = request.body as MailgunWebhookPayload;

      // Get signature from headers (case-insensitive lookup)
      // Mailgun sends headers in lowercase: x-mailgun-signature, x-mailgun-timestamp, x-mailgun-token
      const getHeader = (name: string): string => {
        const lowerName = name.toLowerCase();
        // Try exact match first
        if (request.headers[lowerName]) {
          return request.headers[lowerName];
        }
        // Try case-insensitive match
        for (const [key, value] of Object.entries(request.headers)) {
          if (key.toLowerCase() === lowerName) {
            return value;
          }
        }
        return "";
      };

      // Mailgun sends signature in headers OR in nested signature object
      // According to docs: https://documentation.mailgun.com/docs/mailgun/user-manual/events/webhooks#securing-webhooks
      // Webhook events come as application/json with: { "signature": { "timestamp": "...", "token": "...", "signature": "..." } }
      // Inbound emails (route forwarding) come as form data with signature fields in form body

      // Check headers first (for webhook events)
      const headerSignature = getHeader("x-mailgun-signature");
      const headerTimestamp = getHeader("x-mailgun-timestamp");
      const headerToken = getHeader("x-mailgun-token");

      // Then check nested signature object (for JSON webhook events)
      let signatureObj: {
        timestamp?: string;
        token?: string;
        signature?: string;
      } | null = null;

      if (payload.signature) {
        if (
          typeof payload.signature === "object" &&
          payload.signature !== null
        ) {
          signatureObj = payload.signature as {
            timestamp?: string;
            token?: string;
            signature?: string;
          };
        } else if (typeof payload.signature === "string") {
          // Sometimes signature might be a JSON string in form data
          try {
            const parsed = JSON.parse(payload.signature);
            if (typeof parsed === "object" && parsed !== null) {
              signatureObj = parsed as {
                timestamp?: string;
                token?: string;
                signature?: string;
              };
            }
          } catch {
            // Not JSON, continue
          }
        }
      }

      // Extract signature fields (priority: headers > nested object > form fields)
      const signature =
        headerSignature ||
        signatureObj?.signature ||
        (typeof payload.signature === "string" && !signatureObj
          ? payload.signature
          : "") ||
        "";
      const timestamp =
        headerTimestamp ||
        signatureObj?.timestamp ||
        (payload.timestamp as unknown as string) ||
        "";
      const token =
        headerToken ||
        signatureObj?.token ||
        (payload.token as unknown as string) ||
        "";

      // If signature components are missing, verification fails
      if (!signature || !timestamp || !token) {
        if (process.env.NODE_ENV === "development") {
          console.error("Missing signature components:", {
            hasSignature: !!signature,
            hasTimestamp: !!timestamp,
            hasToken: !!token,
            signatureObj: !!signatureObj,
            payloadKeys:
              typeof payload === "object" && payload !== null
                ? Object.keys(payload)
                : [],
          });
        }
        return false;
      }

      // Use webhook signing key
      const signingKey = config.webhookSigningKey;

      // Ensure timestamp and token are strings (per Mailgun docs)
      const timestampStr = String(timestamp);
      const tokenStr = String(token);

      // Calculate HMAC-SHA256 signature
      // Per Mailgun docs: concatenate timestamp + token with no separator
      const hmac = createHmac("sha256", signingKey);
      hmac.update(timestampStr + tokenStr);
      const hash = hmac.digest("hex");

      // Compare signatures (constant-time comparison)
      if (hash.length !== signature.length) {
        return false;
      }

      let result = 0;
      for (let i = 0; i < hash.length; i++) {
        result |= hash.charCodeAt(i) ^ signature.charCodeAt(i);
      }

      return result === 0;
    },

    webhookResponse: async (
      request: WebhookRequest,
      handled: boolean,
    ): Promise<WebhookResponse> => {
      // Mailgun expects a 200 OK response
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
          const url = requireMailgunWebhookUrl(input.url, "account");

          const { providerEvents, normalizedEvents, wantsInbound } =
            resolveMailgunWebhookEvents(input.events, input.inbound);
          if (wantsInbound) {
            resolveMailgunRouteExpression(input);
          }

          const raw: Record<string, unknown> = {};
          let providerId = "";
          let routeId: string | undefined;

          if (providerEvents.length > 0) {
            const formData = new FormData();
            formData.append(
              "description",
              typeof input.provider?.description === "string"
                ? input.provider.description
                : "EmailKit account webhook",
            );
            for (const event of providerEvents) {
              formData.append("event_types", event);
            }
            formData.append("url", url);

            const res = await fetch(`${apiBase}/v1/webhooks`, {
              method: "POST",
              headers: { Authorization: auth },
              body: formData,
            });
            const body = await readMailgunApiResponse(res);
            if (!res.ok) {
              throwMailgunApiError(
                body,
                res.status,
                `HTTP ${res.status}: Failed to create account webhook`,
              );
            }
            raw.delivery = body;
            providerId = String((body as any)?.webhook_id || "");
          }

          if (wantsInbound) {
            const route = await createMailgunInboundRoute({
              url,
              provider: input.provider,
              inbound: input.inbound,
              defaultDescription: "EmailKit account inbound webhook",
              baseUrl,
              auth,
            });
            routeId = route.routeId;
            raw.route = route.raw;
          }

          const id = providerId || routeId || `account:${url}`;
          const webhook = normalizeMailgunAccountWebhook(
            {
              webhook_id: id,
              url,
              event_types: providerEvents,
            },
            {
              id,
              url,
              events: normalizedEvents,
              providerId: providerId || undefined,
              provider: {
                deliveryEvents: providerEvents,
                routeId,
              },
            },
          );

          return { webhook: { ...webhook, raw }, raw };
        },

        refresh: async (
          input: AccountWebhookRefreshInput,
        ): Promise<AccountWebhookRefreshResult> => {
          const webhookId = resolveMailgunAccountWebhookId(input);
          const routeId = resolveMailgunRouteId(input);
          if (!webhookId && !routeId) {
            throw new EmailKitError(
              "Mailgun account webhook refresh requires a webhookId, providerId, or inbound routeId",
              "mailgun",
            );
          }

          const raw: Record<string, unknown> = {};
          let accountBody: unknown;
          let normalizedEvents = input.webhook?.events;
          let deliveryEvents = input.webhook?.provider?.deliveryEvents as
            | MailgunWebhookEvent[]
            | undefined;

          if (webhookId) {
            const res = await fetch(
              `${apiBase}/v1/webhooks/${encodeURIComponent(webhookId)}`,
              { headers: { Authorization: auth } },
            );
            accountBody = await readMailgunApiResponse(res);
            if (!res.ok) {
              throwMailgunApiError(
                accountBody,
                res.status,
                `HTTP ${res.status}: Failed to refresh account webhook`,
              );
            }
            raw.delivery = accountBody;
            const accountEventTypes = (accountBody as any)?.event_types;
            if (Array.isArray(accountEventTypes)) {
              deliveryEvents = accountEventTypes.filter(
                (event): event is MailgunWebhookEvent =>
                  typeof event === "string" && isMailgunWebhookEvent(event),
              );
              normalizedEvents = normalizeMailgunEvents(deliveryEvents);
            }
          }

          if (routeId) {
            const res = await fetch(
              `${baseUrl}/routes/${encodeURIComponent(routeId)}`,
              { headers: { Authorization: auth } },
            );
            const body = await readMailgunApiResponse(res);
            if (!res.ok) {
              throwMailgunApiError(
                body,
                res.status,
                `HTTP ${res.status}: Failed to refresh inbound route`,
              );
            }
            raw.route = body;
            normalizedEvents = unique([...(normalizedEvents || []), "inbound"]);
          }

          const webhook = normalizeMailgunAccountWebhook(accountBody, {
            ...input.webhook,
            id: input.webhook?.id || webhookId || routeId,
            providerId: input.webhook?.providerId || webhookId || undefined,
            events: normalizedEvents,
            provider: {
              ...(input.webhook?.provider || {}),
              deliveryEvents,
              routeId,
            },
          });

          return {
            webhook: { ...webhook, raw },
            raw,
          };
        },

        delete: async (
          input: AccountWebhookDeleteInput,
        ): Promise<AccountWebhookDeleteResult> => {
          const webhookId = resolveMailgunAccountWebhookId(input);
          const routeId = resolveMailgunRouteId(input);
          if (!webhookId && !routeId) {
            throw new EmailKitError(
              "Mailgun account webhook delete requires a webhookId, providerId, or inbound routeId",
              "mailgun",
            );
          }

          const raw: Record<string, unknown> = {};

          if (webhookId) {
            const res = await fetch(
              `${apiBase}/v1/webhooks/${encodeURIComponent(webhookId)}`,
              { method: "DELETE", headers: { Authorization: auth } },
            );
            const body = await readMailgunApiResponse(res);
            if (!res.ok) {
              throwMailgunApiError(
                body,
                res.status,
                `HTTP ${res.status}: Failed to delete account webhook`,
              );
            }
            raw.delivery = body;
          }

          if (routeId) {
            const res = await fetch(
              `${baseUrl}/routes/${encodeURIComponent(routeId)}`,
              { method: "DELETE", headers: { Authorization: auth } },
            );
            const body = await readMailgunApiResponse(res);
            if (!res.ok) {
              throwMailgunApiError(
                body,
                res.status,
                `HTTP ${res.status}: Failed to delete inbound route`,
              );
            }
            raw.route = body;
          }

          return {
            deleted: true,
            webhook: {
              id: input.webhook?.id || webhookId || routeId || "",
              providerId: input.webhook?.providerId || webhookId || undefined,
              scope: "account",
              url: input.webhook?.url || "",
              events: input.webhook?.events,
              status: "deleted",
              provider: {
                ...(input.webhook?.provider || {}),
                routeId,
              },
              raw,
            },
            raw,
          };
        },
      },

      domain: {
        setup: async (
          input: DomainWebhookSetupInput,
        ): Promise<DomainWebhookSetupResult> => {
          const url = requireMailgunWebhookUrl(input.url, "domain");

          const domain = resolveWebhookDomain(input);
          const { providerEvents, normalizedEvents, wantsInbound } =
            resolveMailgunWebhookEvents(input.events, input.inbound);
          if (wantsInbound) {
            resolveMailgunRouteExpression(input);
          }

          let routeId: string | undefined;
          const raw: Record<string, unknown> = {};

          if (providerEvents.length > 0) {
            const body = new URLSearchParams();
            body.append("url", url);
            for (const event of providerEvents) {
              body.append("event_types", event);
            }

            const res = await fetch(
              `${baseUrlV4}/domains/${encodeURIComponent(domain)}/webhooks`,
              {
                method: "POST",
                headers: {
                  Authorization: auth,
                  "Content-Type": "application/x-www-form-urlencoded",
                },
                body,
              },
            );
            const responseBody = await readMailgunApiResponse(res);
            if (!res.ok) {
              throwMailgunApiError(
                responseBody,
                res.status,
                `HTTP ${res.status}: Failed to create domain webhook`,
              );
            }
            raw.delivery = responseBody;
          }

          if (wantsInbound) {
            const route = await createMailgunInboundRoute({
              url,
              provider: input.provider,
              inbound: input.inbound,
              defaultDescription: `EmailKit inbound webhook for ${domain}`,
              baseUrl,
              auth,
            });
            routeId = route.routeId;
            raw.route = route.raw;
          }

          const webhook = normalizeMailgunDomainWebhook({
            domain,
            url,
            events: normalizedEvents,
            providerEvents,
            routeId,
            raw,
          });

          return { webhook, raw };
        },

        refresh: async (
          input: DomainWebhookRefreshInput,
        ): Promise<DomainWebhookRefreshResult> => {
          const domain = resolveWebhookDomain(input);
          const url = input.webhook?.url;
          const routeId = resolveMailgunRouteId(input);
          const raw: Record<string, unknown> = {};
          let deliveryEvents = input.webhook?.provider?.deliveryEvents as
            | MailgunWebhookEvent[]
            | undefined;
          let normalizedEvents = input.webhook?.events;

          if (url) {
            const res = await fetch(
              `${baseUrl}/domains/${encodeURIComponent(domain)}/webhooks`,
              { headers: { Authorization: auth } },
            );
            const body = await readMailgunApiResponse(res);
            if (!res.ok) {
              throwMailgunApiError(
                body,
                res.status,
                `HTTP ${res.status}: Failed to refresh domain webhooks`,
              );
            }
            raw.delivery = body;
            const found = extractDomainEventsForUrl(body, url);
            deliveryEvents = found.providerEvents;
            normalizedEvents = unique([
              ...found.normalizedEvents,
              ...(normalizedEvents?.includes("inbound")
                ? (["inbound"] as WebhookEventType[])
                : []),
            ]);
          }

          if (routeId) {
            const res = await fetch(
              `${baseUrl}/routes/${encodeURIComponent(routeId)}`,
              { headers: { Authorization: auth } },
            );
            const body = await readMailgunApiResponse(res);
            if (!res.ok) {
              throwMailgunApiError(
                body,
                res.status,
                `HTTP ${res.status}: Failed to refresh inbound route`,
              );
            }
            raw.route = body;
            normalizedEvents = unique([...(normalizedEvents || []), "inbound"]);
          }

          const webhook = normalizeMailgunDomainWebhook({
            domain,
            url: url || "",
            events: normalizedEvents,
            providerEvents: deliveryEvents,
            providerId: resolveWebhookReferenceId(input),
            routeId,
            raw,
          });

          return { webhook, raw };
        },

        delete: async (
          input: DomainWebhookDeleteInput,
        ): Promise<DomainWebhookDeleteResult> => {
          const domain = resolveWebhookDomain(input);
          const url = input.webhook?.url;
          const routeId = resolveMailgunRouteId(input);
          const raw: Record<string, unknown> = {};

          if (!url && !routeId) {
            throw new EmailKitError(
              "Mailgun domain webhook delete requires a webhook url or inbound routeId",
              "mailgun",
            );
          }

          if (url) {
            const params = new URLSearchParams({ url });
            const res = await fetch(
              `${baseUrlV4}/domains/${encodeURIComponent(
                domain,
              )}/webhooks?${params.toString()}`,
              { method: "DELETE", headers: { Authorization: auth } },
            );
            const body = await readMailgunApiResponse(res);
            if (!res.ok) {
              throwMailgunApiError(
                body,
                res.status,
                `HTTP ${res.status}: Failed to delete domain webhook`,
              );
            }
            raw.delivery = body;
          }

          if (routeId) {
            const res = await fetch(
              `${baseUrl}/routes/${encodeURIComponent(routeId)}`,
              { method: "DELETE", headers: { Authorization: auth } },
            );
            const body = await readMailgunApiResponse(res);
            if (!res.ok) {
              throwMailgunApiError(
                body,
                res.status,
                `HTTP ${res.status}: Failed to delete inbound route`,
              );
            }
            raw.route = body;
          }

          return {
            deleted: true,
            webhook: {
              id: input.webhook?.id || resolveWebhookReferenceId(input) || "",
              providerId:
                input.webhook?.providerId || resolveWebhookReferenceId(input),
              scope: "domain",
              url: input.webhook?.url || url || "",
              events: input.webhook?.events,
              status: "deleted",
              provider: {
                ...(input.webhook?.provider || {}),
                domain,
                routeId,
              },
              raw,
            },
            raw,
          };
        },
      },
    },

    domains: {
      list: async (opts?: ListDomainsOptions): Promise<Domain[]> => {
        const searchParams = new URLSearchParams();
        if (opts?.limit !== undefined || opts?.pageSize !== undefined) {
          searchParams.set("limit", String(opts.limit ?? opts.pageSize));
        }
        if (opts?.page !== undefined && (opts?.limit || opts?.pageSize)) {
          const limit = opts.limit ?? opts.pageSize ?? 100;
          searchParams.set("skip", String(Math.max(0, opts.page - 1) * limit));
        }
        if (opts?.status) {
          const state = opts.status === "verified" ? "active" : opts.status;
          searchParams.set("state", state);
        }
        if (opts?.provider) {
          for (const [key, value] of Object.entries(opts.provider)) {
            if (value !== undefined && value !== null) {
              searchParams.set(key, String(value));
            }
          }
        }

        const query = searchParams.toString();
        const url = `${baseUrlV4}/domains${query ? `?${query}` : ""}`;
        const res = await fetch(url, {
          headers: { Authorization: auth },
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
            "mailgun",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const domains = ((body as any)?.items || []) as any[];
        return domains.map((d) => {
          const status = mapDomainStatus(d.state);
          const records = parseDnsRecords(
            d.sending_dns_records,
            d.receiving_dns_records,
          );

          const domain: Domain = {
            id: d.id || d.name,
            domain: d.name,
            status,
            createdAt: d.created_at ? new Date(d.created_at) : undefined,
            verification:
              records.length > 0
                ? { status, records, checkedAt: undefined }
                : undefined,
            raw: d,
          };

          return domain;
        });
      },

      create: async (input: CreateDomainInput): Promise<Domain> => {
        const formData = new FormData();
        formData.append("name", input.domain);

        // Add optional parameters from input
        if (input.dkimSelector) {
          formData.append("dkim_selector", input.dkimSelector);
        }

        if (input.returnPathSubdomain) {
          // Mailgun uses mailfrom_host for return-path subdomain
          formData.append("mailfrom_host", input.returnPathSubdomain);
        }

        // Add provider-specific options
        if (input.provider) {
          for (const [key, value] of Object.entries(input.provider)) {
            if (value !== undefined && value !== null) {
              formData.append(key, String(value));
            }
          }
        }

        const url = `${baseUrlV4}/domains`;
        const res = await fetch(url, {
          method: "POST",
          headers: { Authorization: auth },
          body: formData,
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
            "mailgun",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const domainData = (body as any)?.domain as any;
        const status = mapDomainStatus(domainData?.state);
        const records = parseDnsRecords(
          (body as any)?.sending_dns_records,
          (body as any)?.receiving_dns_records,
        );

        const domain: Domain = {
          id: domainData?.id || input.domain,
          domain: domainData?.name || input.domain,
          status,
          createdAt: domainData?.created_at
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
        const url = `${baseUrlV4}/domains/${encodeURIComponent(idOrName)}`;
        const res = await fetch(url, {
          headers: { Authorization: auth },
        });

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to get domain`,
            "mailgun",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const domainData = (body as any)?.domain as any;
        const status = mapDomainStatus(domainData?.state);
        const records = parseDnsRecords(
          (body as any)?.sending_dns_records,
          (body as any)?.receiving_dns_records,
        );

        const domain: Domain = {
          id: domainData?.id || domainData?.name || idOrName,
          domain: domainData?.name || idOrName,
          status,
          createdAt: domainData?.created_at
            ? new Date(domainData.created_at)
            : undefined,
          verification:
            records.length > 0
              ? { status, records, checkedAt: undefined }
              : undefined,
          raw: body,
        };

        return domain;
      },

      update: async (
        idOrName: string,
        patch: UpdateDomainInput,
      ): Promise<Domain> => {
        const formData = new FormData();

        // Add optional parameters from patch
        if (patch.returnPathSubdomain) {
          formData.append("mailfrom_host", patch.returnPathSubdomain);
        }

        // Add provider-specific options
        if (patch.provider) {
          for (const [key, value] of Object.entries(patch.provider)) {
            if (value !== undefined && value !== null) {
              formData.append(key, String(value));
            }
          }
        }

        const url = `${baseUrlV4}/domains/${encodeURIComponent(idOrName)}`;
        const res = await fetch(url, {
          method: "PUT",
          headers: { Authorization: auth },
          body: formData,
        });

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to update domain`,
            "mailgun",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const domainData = (body as any)?.domain as any;
        const status = mapDomainStatus(domainData?.state);
        const records = parseDnsRecords(
          (body as any)?.sending_dns_records,
          (body as any)?.receiving_dns_records,
        );

        const domain: Domain = {
          id: domainData?.id || domainData?.name || idOrName,
          domain: domainData?.name || idOrName,
          status,
          createdAt: domainData?.created_at
            ? new Date(domainData.created_at)
            : undefined,
          verification:
            records.length > 0
              ? { status, records, checkedAt: undefined }
              : undefined,
          raw: body,
        };

        return domain;
      },

      verify: async (idOrName: string): Promise<DomainVerification> => {
        const url = `${baseUrlV4}/domains/${encodeURIComponent(idOrName)}/verify`;
        const res = await fetch(url, {
          method: "PUT",
          headers: { Authorization: auth },
        });

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to verify domain`,
            "mailgun",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const domainData = (body as any)?.domain as any;
        const status = mapDomainStatus(domainData?.state);
        const records = parseDnsRecords(
          (body as any)?.sending_dns_records,
          (body as any)?.receiving_dns_records,
        );

        const verification: DomainVerification = {
          status,
          records,
          checkedAt: new Date(),
          raw: body,
        };

        return verification;
      },

      delete: async (idOrName: string): Promise<DomainDeleteResult> => {
        const url = `${baseUrl}/domains/${encodeURIComponent(idOrName)}`;
        const res = await fetch(url, {
          method: "DELETE",
          headers: { Authorization: auth },
        });

        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();

        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to delete domain`,
            "mailgun",
            undefined,
            res.status,
            undefined,
            body,
          );
        }

        const deleted = res.ok && res.status === 200;
        return {
          deleted,
        };
      },
    },
  };
};

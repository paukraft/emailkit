/**
 * Mailgun email driver
 *
 * Implements the Mailgun API for sending emails and handling webhooks.
 * Documentation: https://documentation.mailgun.com/docs/mailgun/quickstart
 */

import { createHmac } from "crypto";
import type { EmailDriver, EmailDriverConfig } from "../driver";
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
  InboundEmailEvent,
  ListDomainsOptions,
  OutboundEmailEvent,
  SendEmailResult,
  UpdateDomainInput,
  WebhookEvent,
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
export interface MailgunDriverConfig extends EmailDriverConfig {
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
  addresses: EmailAddress | EmailAddress[]
): string => {
  if (Array.isArray(addresses)) {
    return addresses.map(formatEmailAddress).join(", ");
  }
  return formatEmailAddress(addresses);
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
        size?: number;
        "content-type"?: string;
        "content-id"?: string;
      }>;
      storage?: {
        url?: string;
        key?: string;
      };
    };
    "user-variables"?: Record<string, string>;
    "recipient-domain"?: string;
    recipient?: string;
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
  // For legacy webhook format (when message is stored)
  storage?: {
    url?: string;
    key?: string;
  };
  "message-url"?: string; // URL to retrieve stored message (for inbound emails)
  "attachment-count"?: string;
  // Legacy webhook fields
  event?: string;
  timestamp?: string;
  "message-headers"?: string;
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
  payload: MailgunWebhookPayload
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
  payload: MailgunWebhookPayload
): Attachment[] => {
  const attachments: Attachment[] = [];
  const eventData = payload["event-data"];
  const message = eventData?.message;

  // Parse content-id-map to identify inline attachments
  // Format: "{\"<cid>\":\"url\",...}"
  const contentIdMap: Record<string, string> = {};
  if (payload["content-id-map"]) {
    try {
      const mapData =
        typeof payload["content-id-map"] === "string"
          ? JSON.parse(payload["content-id-map"])
          : payload["content-id-map"];
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
    for (const attachment of message.attachments) {
      if (attachment.filename) {
        attachments.push(
          enrichAttachment({
            filename: attachment.filename,
            url: "", // Will be populated when retrieving from stored message
            contentType: attachment["content-type"],
            size: attachment.size,
            contentId: attachment["content-id"],
          })
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
        for (const attachment of attachmentData) {
          if (
            attachment &&
            typeof attachment === "object" &&
            "name" in attachment
          ) {
            const att = attachment as {
              name?: string;
              "content-type"?: string;
              size?: number;
              url?: string;
              "content-id"?: string;
            };

            if (att.name) {
              attachments.push(
                enrichAttachment({
                  filename: att.name,
                  url: att.url || "",
                  contentType: att["content-type"],
                  size: att.size,
                  contentId: att["content-id"],
                })
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

  if (attachmentCount > 0 && payload["storage"]?.url) {
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
            filename,
            url: payload["storage"]?.url || "",
            contentType,
            size,
          })
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

  const messageHeadersFromEvent =
    eventData.message &&
    typeof eventData.message === "object" &&
    "headers" in eventData.message
      ? (eventData.message.headers as Record<string, string>)
      : ({} as Record<string, string>);
  const messageHeaders = messageHeadersFromEvent;
  const messageId =
    messageHeaders["message-id"] ||
    payload["Message-Id"] ||
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
    messageHeaders.from || payload.From || messageHeadersFromEvent.from || "";
  const toStr =
    messageHeaders.to || payload.To || messageHeadersFromEvent.to || "";
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
      payload["From"] !== undefined) &&
    // But NOT an event field (that's for outbound webhooks)
    payload.event === undefined &&
    payload["event-data"] === undefined;

  const isStoredMessage =
    (payload["storage"] as { url?: string } | undefined) !== undefined ||
    (payload["message-url"] as string | undefined) !== undefined ||
    (eventData.message &&
      typeof eventData.message === "object" &&
      "storage" in eventData.message &&
      eventData.message.storage !== undefined);

  if (isInboundEmail || isStoredMessage) {
    const messageStorage =
      eventData.message &&
      typeof eventData.message === "object" &&
      "storage" in eventData.message
        ? (eventData.message.storage as { url?: string })
        : undefined;

    const storageUrl =
      messageStorage?.url ||
      (payload["storage"] as { url?: string } | undefined)?.url ||
      (payload["message-url"] as string | undefined) ||
      undefined;

    let bodyPlain = payload["body-plain"] as string | undefined;
    let bodyHtml = payload["body-html"] as string | undefined;
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
            error
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
  const providerId =
    messageStorage?.key ||
    (messageStorage?.url
      ? extractProviderIdFromUrl(messageStorage.url)
      : undefined);

  // Build event - only include optional fields if they're actually available
  const outboundEvent: OutboundEmailEvent = {
    schemaVersion: "1",
    eventId: `${event}:${messageId}:${timestamp.getTime()}`,
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
  const attachmentsWithUrls = attachmentMetadata.filter((att) => att.url);

  if (attachmentsWithUrls.length > 0) {
    const basic = `Basic ${stringToBase64(`api:${apiKey}`)}`;
    for (const attachmentMeta of attachmentsWithUrls) {
      if (attachmentMeta.url) {
        try {
          const res = await fetch(attachmentMeta.url, {
            headers: { Authorization: basic },
          });
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
            `Failed to retrieve attachment ${attachmentMeta.filename}:`,
            error
          );
          attachments.push(attachmentMeta);
        }
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
    for (const attachment of messageData.attachments) {
      const filename = attachment.filename || attachment.name;
      if (attachment.url && filename) {
        try {
          const ares = await fetch(attachment.url, {
            headers: { Authorization: basic },
          });
          if (!ares.ok) throw new Error(`HTTP ${ares.status}`);
          const buf = new Uint8Array(await ares.arrayBuffer());

          const matchingMeta = attachmentMetadata.find(
            (m) => m.filename === filename
          );

          attachments.push({
            filename,
            content: buf,
            contentType: attachment["content-type"],
            url: attachment.url,
            size: attachment.size,
            contentId: matchingMeta?.contentId,
            isInline: matchingMeta?.isInline,
          });
        } catch (error) {
          console.error(`Failed to retrieve attachment ${filename}:`, error);
        }
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
  purpose?: DomainRecordPurpose
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
  }>
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

/**
 * Mailgun driver capabilities
 */
export const MAILGUN_CAPABILITIES = {
  templates: false, // Mailgun doesn't have built-in templates like SendGrid
  personalizations: false, // Mailgun doesn't support per-recipient personalizations
  scheduling: true, // Mailgun supports scheduled sending
  unsubscribe: true, // Mailgun supports unsubscribe management
  trackOpens: true, // Mailgun supports granular open tracking
  trackClicks: true, // Mailgun supports granular click tracking
  sandbox: false, // Mailgun doesn't have a sandbox mode
  sendIdempotency: false,
  tenantRouting: true,
  domains: true, // Mailgun supports domain management API
  domainIdentifier: "domain" as const, // Mailgun requires domain name
} as const satisfies DriverCapabilities;

/**
 * Type helper for Mailgun capabilities
 */
export type MailgunCapabilities = typeof MAILGUN_CAPABILITIES;

export const MailgunDriver = (
  config: MailgunDriverConfig
): EmailDriver<MailgunDriverConfig, typeof MAILGUN_CAPABILITIES> => {
  // Determine region (default to 'us')
  const region = config.region || "us";

  // Get API base URL (use config override or default based on region)
  const apiBase = config.apiBase || MAILGUN_ENDPOINTS[region].apiBase;
  const baseUrl = `${apiBase}/v3`;
  const baseUrlV4 = `${apiBase}/v4`;

  // Basic auth header for API requests
  const auth = `Basic ${stringToBase64(`api:${config.apiKey}`)}`;

  return {
    name: "mailgun",
    capabilities: MAILGUN_CAPABILITIES,
    providerFetch: createProviderFetch({
      baseUrl: apiBase,
      defaultHeaders: {
        Authorization: auth,
      },
    }),

    sendEmail: async (
      message: EmailMessage<typeof MAILGUN_CAPABILITIES>,
      options?: { signal?: AbortSignal }
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
      if (message.cc) {
        formData.append("cc", formatEmailAddresses(message.cc));
      }
      if (message.bcc) {
        formData.append("bcc", formatEmailAddresses(message.bcc));
      }
      const reply = resolveMessageReplyContext(message);
      if (hasReplyData(reply)) {
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
          const fileContent: Uint8Array | string =
            typeof attachment.content === "string"
              ? attachment.content
              : (attachment.content as Uint8Array);

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
          formData.append("o:tag", tag);
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
        // If opens is undefined, use default (enabled)

        if (track.clicks === false) {
          formData.append("o:tracking-clicks", "no");
        } else if (track.clicks === true) {
          formData.append("o:tracking-clicks", "yes");
        }
        // If clicks is undefined, use default (enabled)
      } else if (
        "trackingEnabled" in message &&
        message.trackingEnabled === false
      ) {
        // Legacy support: disable all tracking
        formData.append("o:tracking", "no");
      } else {
        // Default: enable tracking
        formData.append("o:tracking-opens", "yes");
        formData.append("o:tracking-clicks", "yes");
      }

      // Scheduling
      if ("sendAt" in message && message.sendAt !== undefined) {
        const sendAt =
          typeof message.sendAt === "number"
            ? new Date(message.sendAt)
            : message.sendAt;
        // Mailgun expects RFC 2822 format or Unix timestamp
        formData.append("o:deliverytime", sendAt.toISOString());
      }

      // Unsubscribe configuration
      if ("unsubscribe" in message && message.unsubscribe !== undefined) {
        const unsubscribe = message.unsubscribe;
        if (unsubscribe.global === true) {
          formData.append("o:require-tls", "false"); // Not directly related but Mailgun uses h:List-Unsubscribe
        }
        if (unsubscribe.listId) {
          formData.append("o:tag", `list:${unsubscribe.listId}`);
        }
        if (unsubscribe.groupId) {
          formData.append("o:tag", `group:${unsubscribe.groupId}`);
        }
      }

      // Idempotency key (if provided)
      if ("provider" in message && message.provider) {
        const providerOptions = message.provider as Record<string, unknown>;
        if (providerOptions.idempotencyKey) {
          formData.append("o:require-tls", "false"); // Mailgun doesn't have native idempotency, but we can use tags
          formData.append(
            "o:tag",
            `idempotency:${String(providerOptions.idempotencyKey)}`
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
            body
          );
        }

        const data = body as { id?: string; message?: string } | string;
        const id =
          typeof data === "object" && data ? (data as any).id : undefined;
        return {
          messageId: id || `${Date.now()}@mailgun`,
          provider: "mailgun",
          providerId: id,
        };
      } catch (error) {
        throw new EmailKitError(
          error instanceof Error ? error.message : "Unknown error",
          "mailgun",
          undefined,
          undefined,
          error
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
          payload["X-Mailgun-Incoming"] === "Yes") &&
        // But NOT an event field (that's for outbound webhooks)
        payload.event === undefined &&
        payload["event-data"] === undefined;

      // Also check for stored messages with message-url
      const isStoredMessageWebhook =
        (payload["message-url"] as string | undefined) !== undefined &&
        payload["event-data"] === undefined &&
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
            (payload["storage"] as { url?: string } | undefined) !==
              undefined ||
            (eventData.message &&
              typeof eventData.message === "object" &&
              "storage" in eventData.message &&
              eventData.message.storage !== undefined)
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
      handled: boolean
    ): Promise<WebhookResponse> => {
      // Mailgun expects a 200 OK response
      return {
        status: 200,
        body: { success: true },
      };
    },

    domains: {
      list: async (opts?: ListDomainsOptions): Promise<Domain[]> => {
        const url = `${baseUrl}/domains`;
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
            body
          );
        }

        const domains = ((body as any)?.items || []) as any[];
        return domains.map((d) => {
          const status = mapDomainStatus(d.state);
          const records = parseDnsRecords(
            d.sending_dns_records,
            d.receiving_dns_records
          );

          const domain: Domain = {
            id: d.id || d.name,
            name: d.name,
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
        formData.append("name", input.name);

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
            body
          );
        }

        const domainData = (body as any)?.domain as any;
        const status = mapDomainStatus(domainData?.state);
        const records = parseDnsRecords(
          (body as any)?.sending_dns_records,
          (body as any)?.receiving_dns_records
        );

        const domain: Domain = {
          id: domainData?.id || input.name,
          name: domainData?.name || input.name,
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
        // Include DNS records by default
        const url = `${baseUrlV4}/domains/${encodeURIComponent(idOrName)}?h:with_dns=true`;
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
            body
          );
        }

        const domainData = (body as any)?.domain as any;
        const status = mapDomainStatus(domainData?.state);
        const records = parseDnsRecords(
          (body as any)?.sending_dns_records,
          (body as any)?.receiving_dns_records
        );

        const domain: Domain = {
          id: domainData?.id || domainData?.name || idOrName,
          name: domainData?.name || idOrName,
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
        patch: UpdateDomainInput
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
            body
          );
        }

        const domainData = (body as any)?.domain as any;
        const status = mapDomainStatus(domainData?.state);
        const records = parseDnsRecords(
          (body as any)?.sending_dns_records,
          (body as any)?.receiving_dns_records
        );

        const domain: Domain = {
          id: domainData?.id || domainData?.name || idOrName,
          name: domainData?.name || idOrName,
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
            body
          );
        }

        const domainData = (body as any)?.domain as any;
        const status = mapDomainStatus(domainData?.state);
        const records = parseDnsRecords(
          (body as any)?.sending_dns_records,
          (body as any)?.receiving_dns_records
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
            body
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

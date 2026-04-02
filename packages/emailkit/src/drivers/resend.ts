/**
 * Resend email driver
 *
 * Implements the Resend API for sending emails and handling webhooks.
 * Documentation: https://resend.com/docs
 */

import { Webhook } from "svix";
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
export interface ResendDriverConfig extends EmailDriverConfig {
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
  addresses: EmailAddress | EmailAddress[]
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
    | "email.complained"
    | "email.bounced"
    | "email.opened"
    | "email.clicked"
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
  templates: true, // Resend supports templates via template.id and template.variables
  personalizations: false, // Resend does not support per-recipient personalizations
  scheduling: true, // Resend supports scheduled_at for scheduling
  unsubscribe: false, // Resend does not support unsubscribe management in send API
  trackOpens: true, // Resend tracks opens via webhooks (automatic)
  trackClicks: true, // Resend tracks clicks via webhooks (automatic)
  sandbox: false, // Resend does not have a sandbox mode
  sendIdempotency: true,
  tenantRouting: true,
  domains: true, // Resend supports domain management API
  domainIdentifier: "domainId" as const, // Resend requires domainId
} as const satisfies DriverCapabilities;

/**
 * Type helper for Resend capabilities
 */
export type ResendCapabilities = typeof RESEND_CAPABILITIES;

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
      return "pending";
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

/**
 * Retrieve attachment content from Resend download URLs
 */
const retrieveResendAttachments = async (
  attachmentMetadata: Attachment[]
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
          error
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
  autoFetchAttachments: boolean
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
      "MISSING_EMAIL_ID"
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
      emailRes.status
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
      attRes.status
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
  rawPayload: ResendWebhookEvent
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
    "email.delivery_delayed": "delivered",
    "email.opened": "opened",
    "email.clicked": "clicked",
    "email.bounced": "bounced",
    "email.complained": "complained",
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

  // Extract event-specific fields
  switch (eventType) {
    case "email.delivered": {
      return {
        ...baseEvent,
        responseTime: data["processing_time_ms"] as number | undefined,
      } as OutboundEmailEvent & { responseTime?: number };
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

    default:
      return baseEvent;
  }
};

export const ResendDriver = (
  config: ResendDriverConfig
): EmailDriver<ResendDriverConfig, typeof RESEND_CAPABILITIES> => {
  const apiBase = config.apiBase || "https://api.resend.com";
  const baseUrl = `${apiBase}`;

  // Helper to get domain details
  const getDomainDetails = async (idOrName: string): Promise<Domain> => {
    const res = await fetch(
      `${baseUrl}/domains/${encodeURIComponent(idOrName)}`,
      {
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      }
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
        body
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
      name: domainData.name || idOrName,
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
    name: "resend",
    capabilities: RESEND_CAPABILITIES,
    providerFetch: createProviderFetch({
      baseUrl: apiBase,
      defaultHeaders: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    }),

    sendEmail: async (
      message: EmailMessage<typeof RESEND_CAPABILITIES>,
      options?: { signal?: AbortSignal }
    ): Promise<SendEmailResult> => {
      // Resend requires either html or text, or template
      if (!message.html && !message.text && !message.templateId) {
        throw new EmailKitError(
          "Either html, text, or templateId must be provided",
          "resend",
          "MISSING_REQUIRED_FIELD"
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

      // Add html or text (or both)
      if (message.html) {
        requestBody.html = message.html;
      }
      if (message.text) {
        requestBody.text = message.text;
      }

      // Add template if provided
      if (message.templateId) {
        requestBody.template = {
          id: message.templateId,
          variables: message.templateData || {},
        };
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
              "INVALID_ATTACHMENT"
            );
          }
        });
      }

      // Add tags
      if (message.tags && message.tags.length > 0) {
        requestBody.tags = message.tags.map((tag) => {
          // Resend tags can be strings or objects with name/value
          if (typeof tag === "string") {
            return { name: tag };
          }
          return tag;
        });
      }

      // Tenant routing (capability)
      if ("tenantId" in message && message.tenantId) {
        headers["X-Tenant-Id"] = message.tenantId;
        // Also add as a tag for searchability
        if (Array.isArray(requestBody.tags)) {
          (
            requestBody.tags as unknown as Array<{
              name: string;
              value?: string;
            }>
          ).push({ name: `tenant:${message.tenantId}` });
        } else {
          requestBody.tags = [{ name: `tenant:${message.tenantId}` }];
        }
      }

      // Add scheduling
      if (message.sendAt) {
        const sendAtDate =
          message.sendAt instanceof Date
            ? message.sendAt
            : new Date(message.sendAt);
        requestBody.scheduled_at = sendAtDate.toISOString();
      }

      // Add metadata (if supported)
      if (message.metadata) {
        // Resend doesn't have explicit metadata field, but we can use headers
        for (const [key, value] of Object.entries(message.metadata)) {
          headers[`X-Metadata-${key}`] = value;
        }
      }
      if (Object.keys(headers).length > 0) {
        requestBody.headers = headers;
      }

      // Tracking configuration - Resend tracks automatically via webhooks
      // No explicit control in send API
      if ("track" in message && message.track !== undefined) {
        if (message.track.opens === false || message.track.clicks === false) {
          console.warn(
            "Resend API does not support disabling tracking in the send endpoint. Tracking is enabled by default via webhooks."
          );
        }
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
            body
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
            body
          );
        }

        return {
          messageId: emailId,
          provider: "resend",
          providerId: emailId,
        };
      } catch (error) {
        throw new EmailKitError(
          `Failed to send email: ${error instanceof Error ? error.message : String(error)}`,
          "resend",
          undefined,
          undefined,
          error
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
          config.autoFetchInboundAttachments ?? true
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
        "email.opened",
        "email.clicked",
        "email.bounced",
        "email.complained",
        "email.unsubscribed",
      ] as const;

      if (outboundEventTypes.includes(eventType as any)) {
        const outboundEvent = transformOutboundEvent(
          eventType,
          outboundPayload.data,
          outboundPayload.created_at,
          outboundPayload
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
        > = {
          "email.sent": "sent",
          "email.delivered": "delivered",
          "email.delivery_delayed": "delivered",
          "email.opened": "opened",
          "email.clicked": "clicked",
          "email.bounced": "bounced",
          "email.complained": "complained",
          "email.unsubscribed": "complained",
        };

        const mappedType = eventTypeMap[eventType];
        if (mappedType === "sent") {
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
      handled: boolean
    ): Promise<WebhookResponse> => {
      return {
        status: 200,
        body: { success: true },
      };
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
            body
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
            name: d.name || "",
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
          name: input.name,
        };

        if (input.region) {
          requestBody.region = input.region;
        }

        if (input.returnPathSubdomain) {
          requestBody.custom_return_path = input.returnPathSubdomain;
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
            body
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
          id: domainData.id || input.name,
          name: domainData.name || input.name,
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
        patch: UpdateDomainInput
      ): Promise<Domain> => {
        // Resend doesn't support updating domains via API
        // According to docs, domain settings are immutable after creation
        // So we'll just return the current domain state
        return getDomainDetails(idOrName);
      },

      verify: async (idOrName: string): Promise<DomainVerification> => {
        const res = await fetch(
          `${baseUrl}/domains/${encodeURIComponent(idOrName)}/verify`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
            },
          }
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
            body
          );
        }

        // After verification, fetch the domain to get updated records
        const domain = await getDomainDetails(idOrName);

        const verification: DomainVerification = {
          status: domain.status,
          records: domain.verification?.records || [],
          checkedAt: new Date(),
          raw: body,
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
          }
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

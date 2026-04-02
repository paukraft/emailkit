/**
 * AIInbx email driver
 *
 * Implements the AIInbx API for sending emails and handling webhooks.
 * Documentation: https://docs.aiinbx.com/api-reference
 * OpenAPI Spec: https://app.stainless.com/api/spec/documented/ai-inbx/openapi.documented.yml
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { EmailDriver, EmailDriverConfig } from "../driver";
import type { DriverDomainsAPI } from "../driver";
import type {
  Attachment,
  DriverCapabilities,
  EmailAddress,
  EmailMessage,
  DomainDNSRecord,
  Domain,
  DomainVerification,
  InboundEmailEvent,
  OutboundEmailEvent,
  SendEmailResult,
  WebhookEvent,
  WebhookRequest,
  WebhookResponse,
} from "../types";
import { EmailKitError } from "../types";
import { bytesToBase64, stringToBase64 } from "../utils/base64";
import {
  buildReplyContext,
  hasReplyData,
  replyAddressesAsArray,
  resolveMessageReplyContext,
} from "../utils/reply";
import { createProviderFetch } from "../utils/provider-fetch";

/**
 * AIInbx-specific configuration
 */
export interface AIInbxDriverConfig extends EmailDriverConfig {
  apiKey: string;
  /**
   * Optional API base URL (defaults to https://api.aiinbx.com)
   */
  apiBase?: string;
  /**
   * Optional webhook signing secret for webhook verification
   */
  webhookSecret?: string;
  /**
   * Automatically fetch inbound attachments from signed URLs.
   * If false, attachments will include metadata and URL only.
   * App code can still retrieve content later via `emailkit.attachments.getContent(...)`.
   * Default: true
   */
  autoFetchInboundAttachments?: boolean;
}

// (removed unused format helpers)

/**
 * Parse email address string into EmailAddress object
 */
const parseEmailAddress = (emailStr: string, name?: string): EmailAddress => {
  if (!emailStr) return { email: "" };
  const match = emailStr.match(/^(.+?)\s*<(.+?)>$/i);
  if (match) {
    return { name: match[1].trim(), email: match[2].trim() };
  }
  return { email: emailStr.trim(), name: name || undefined };
};

/**
 * AIInbx Email schema (from OpenAPI spec)
 */
interface AIInbxEmail {
  id: string;
  createdAt: string;
  messageId: string;
  inReplyToId: string | null;
  references: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  strippedText: string | null;
  strippedHtml: string | null;
  snippet: string | null;
  fromName: string | null;
  fromAddress: string;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  replyToAddresses: string[];
  sentAt: string | null;
  receivedAt: string | null;
  direction: "INBOUND" | "OUTBOUND";
  status:
    | "DRAFT"
    | "QUEUED"
    | "ACCEPTED"
    | "SENT"
    | "RECEIVED"
    | "FAILED"
    | "BOUNCED"
    | "COMPLAINED"
    | "REJECTED"
    | "READ"
    | "ARCHIVED";
  threadId: string;
  attachments: Array<{
    id: string;
    createdAt: string;
    fileName: string;
    contentType: string;
    sizeInBytes: number;
    cid: string | null;
    disposition: string | null;
    signedUrl: string;
    expiresAt: string;
  }>;
}

/**
 * AIInbx webhook event payload structure (from OpenAPI spec)
 */
interface AIInbxWebhookEvent {
  event:
    | "inbound.email.received"
    | "outbound.email.delivered"
    | "outbound.email.bounced"
    | "outbound.email.complained"
    | "outbound.email.rejected"
    | "outbound.email.opened"
    | "outbound.email.clicked";
  data: unknown;
  attempt: number;
  timestamp: number;
}

/**
 * Inbound email received event data
 */
interface InboundEmailReceivedData {
  email: AIInbxEmail;
  organization: {
    id: string;
    slug: string;
  };
}

/**
 * Outbound delivered event data
 */
interface OutboundDeliveredData {
  emailId: string;
  messageId: string;
  deliveredAt: string;
  recipients: string[];
  remoteMtaIp: string;
  smtpResponse: string;
  processingTimeMs: number;
}

/**
 * Outbound bounced event data
 */
interface OutboundBouncedData {
  emailId: string;
  messageId: string;
  bouncedAt: string;
  bounceType: "Permanent" | "Transient" | "Undetermined";
  bounceSubType: string;
  recipients: Array<{
    emailAddress: string;
    action: string;
    status: string;
    diagnosticCode: string;
  }>;
}

/**
 * Outbound complained event data
 */
interface OutboundComplainedData {
  emailId: string;
  messageId: string;
  complainedAt: string;
  complaintFeedbackType: string;
  recipients: string[];
  userAgent: string;
  feedbackId: string;
}

/**
 * Outbound rejected event data
 */
interface OutboundRejectedData {
  emailId: string;
  messageId: string;
  rejectedAt: string;
  reason: string;
}

/**
 * Outbound opened event data
 */
interface OutboundOpenedData {
  emailId: string;
  messageId: string;
  openedAt: string;
  ipAddress: string;
  userAgent: string;
}

/**
 * Outbound clicked event data
 */
interface OutboundClickedData {
  emailId: string;
  messageId: string;
  clickedAt: string;
  link: string;
  linkDomain: string;
  ipAddress: string;
  userAgent: string;
}

/**
 * AIInbx driver capabilities
 */
export const AIINBX_CAPABILITIES = {
  templates: false,
  personalizations: false,
  scheduling: false,
  unsubscribe: false,
  trackOpens: true, // AIInbx supports open tracking via webhooks
  trackClicks: true, // AIInbx supports click tracking via webhooks
  sandbox: false,
  sendIdempotency: false,
  tenantRouting: false,
  domains: true, // AIInbx supports domain management API
  domainIdentifier: 'domainId' as const, // AIInbx requires domainId for API calls
} as const satisfies DriverCapabilities;

/**
 * Type helper for AIInbx capabilities
 */
export type AIInbxCapabilities = typeof AIINBX_CAPABILITIES;

/**
 * Retrieve attachment content from AIInbx signed URLs
 * AIInbx provides signed S3 URLs that are publicly accessible
 */
const retrieveAIInbxAttachments = async (
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
          `Failed to retrieve AIInbx attachment ${attachmentMeta.filename}:`,
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
 * Transform AIInbx Email schema to InboundEmailEvent
 * Automatically downloads attachment content from signed URLs
 */
const transformInboundEmail = async (
  email: AIInbxEmail,
  timestamp: number,
  rawPayload: AIInbxWebhookEvent,
  autoFetchAttachments: boolean
): Promise<InboundEmailEvent> => {
  const parseEmailAddressList = (addresses: string[]): EmailAddress[] => {
    return addresses.map((addr) => parseEmailAddress(addr));
  };

  const from = parseEmailAddress(
    email.fromAddress,
    email.fromName || undefined
  );
  const to = parseEmailAddressList(email.toAddresses);
  const cc =
    email.ccAddresses.length > 0
      ? parseEmailAddressList(email.ccAddresses)
      : undefined;
  const bcc =
    email.bccAddresses.length > 0
      ? parseEmailAddressList(email.bccAddresses)
      : undefined;
  const replyAddresses =
    email.replyToAddresses.length > 0
      ? parseEmailAddressList(email.replyToAddresses)
      : undefined;

  const reply = buildReplyContext({
    addresses: replyAddresses,
    messageId: email.inReplyToId,
    references: email.references,
    threadId: email.threadId,
  });

  // Parse attachment metadata - AIInbx provides signed URLs
  const attachmentMetadata: Attachment[] = email.attachments.map((att) => ({
    filename: att.fileName,
    contentType: att.contentType,
    size: att.sizeInBytes,
    contentId: att.cid || undefined,
    isInline: att.disposition === "inline",
    url: att.signedUrl, // AIInbx provides signed URLs for attachments
  }));

  // Optionally fetch attachment content from signed URLs
  const attachments = autoFetchAttachments
    ? await retrieveAIInbxAttachments(attachmentMetadata)
    : attachmentMetadata;

  const event: InboundEmailEvent = {
    schemaVersion: "1",
    eventId: `${email.id}:inbound:${timestamp}`,
    messageId: email.messageId,
    providerId: email.id,
    from,
    to,
    cc,
    bcc,
    reply,
    subject: email.subject || "",
    text: email.text || email.strippedText || undefined,
    html: email.html || email.strippedHtml || undefined,
    strippedText: email.strippedText || undefined,
    strippedHtml: email.strippedHtml || undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    headers: {}, // Headers not provided in Email schema
    timestamp: new Date(timestamp * 1000),
    raw: rawPayload, // Store the full webhook payload
  };

  return event;
};

/**
 * Transform outbound event data to OutboundEmailEvent
 */
const transformOutboundEvent = (
  eventType: string,
  data: unknown,
  timestamp: number,
  rawPayload: AIInbxWebhookEvent
): OutboundEmailEvent => {
  const baseEvent: OutboundEmailEvent = {
    schemaVersion: "1",
    messageId: "",
    recipient: "",
    status: "sent",
    timestamp: new Date(timestamp * 1000),
    raw: rawPayload, // Store the full webhook payload
  };

  // Map event types to status
  const statusMap: Record<string, OutboundEmailEvent["status"]> = {
    "outbound.email.delivered": "delivered",
    "outbound.email.opened": "opened",
    "outbound.email.clicked": "clicked",
    "outbound.email.bounced": "bounced",
    "outbound.email.complained": "complained",
    "outbound.email.rejected": "rejected",
  };

  baseEvent.status = statusMap[eventType] || "sent";

  // Extract data based on event type
  switch (eventType) {
    case "outbound.email.delivered": {
      const d = data as OutboundDeliveredData;
      baseEvent.messageId = d.messageId;
      baseEvent.providerId = d.emailId;
      baseEvent.recipient = d.recipients[0] || "";
      baseEvent.recipientDomain = d.recipients[0]?.split("@")[1];
      return {
        ...baseEvent,
        eventId: `${d.emailId}:delivered:${timestamp}`,
        responseTime: d.processingTimeMs,
      } as OutboundEmailEvent & { responseTime?: number };
    }

    case "outbound.email.bounced": {
      const d = data as OutboundBouncedData;
      baseEvent.messageId = d.messageId;
      baseEvent.providerId = d.emailId;
      baseEvent.recipient = d.recipients[0]?.emailAddress || "";
      return {
        ...baseEvent,
        eventId: `${d.emailId}:bounced:${timestamp}`,
        severity: d.bounceType === "Permanent" ? "permanent" : "temporary",
        reason: d.bounceSubType,
        code: d.recipients[0]?.status,
        smtpResponse: d.recipients[0]?.diagnosticCode,
      } as OutboundEmailEvent & {
        severity?: "permanent" | "temporary";
        reason?: string;
        code?: string | number;
        smtpResponse?: string;
      };
    }

    case "outbound.email.complained": {
      const d = data as OutboundComplainedData;
      baseEvent.messageId = d.messageId;
      baseEvent.providerId = d.emailId;
      baseEvent.recipient = d.recipients[0] || "";
      return {
        ...baseEvent,
        eventId: `${d.emailId}:complained:${timestamp}`,
        feedbackType: d.complaintFeedbackType,
        feedback: d.feedbackId,
      } as OutboundEmailEvent & {
        feedbackType?: string;
        feedback?: string;
      };
    }

    case "outbound.email.rejected": {
      const d = data as OutboundRejectedData;
      baseEvent.messageId = d.messageId;
      baseEvent.providerId = d.emailId;
      baseEvent.recipient = ""; // Not provided in rejected event
      return {
        ...baseEvent,
        eventId: `${d.emailId}:rejected:${timestamp}`,
        reason: d.reason,
      } as OutboundEmailEvent & { reason?: string };
    }

    case "outbound.email.opened": {
      const d = data as OutboundOpenedData;
      baseEvent.messageId = d.messageId;
      baseEvent.providerId = d.emailId;
      baseEvent.recipient = ""; // Not provided directly
      return {
        ...baseEvent,
        eventId: `${d.emailId}:opened:${timestamp}`,
        ip: d.ipAddress,
        userAgent: d.userAgent,
      } as OutboundEmailEvent & {
        ip?: string;
        userAgent?: string;
      };
    }

    case "outbound.email.clicked": {
      const d = data as OutboundClickedData;
      baseEvent.messageId = d.messageId;
      baseEvent.providerId = d.emailId;
      baseEvent.recipient = ""; // Not provided directly
      return {
        ...baseEvent,
        eventId: `${d.emailId}:clicked:${timestamp}`,
        url: d.link,
        ip: d.ipAddress,
        userAgent: d.userAgent,
      } as OutboundEmailEvent & {
        url?: string;
        ip?: string;
        userAgent?: string;
      };
    }

    default:
      return baseEvent;
  }
};

export const AIInbxDriver = (
  config: AIInbxDriverConfig
): EmailDriver<AIInbxDriverConfig, typeof AIINBX_CAPABILITIES> & {
  domains: Partial<DriverDomainsAPI>;
} => {
  const apiBase = config.apiBase || "https://api.aiinbx.com";
  const baseUrl = `${apiBase}/api/v1`;

  const mapDomainStatus = (
    status: "VERIFIED" | "PENDING_VERIFICATION" | "NOT_REGISTERED" | string
  ): Domain["status"] => {
    switch (status) {
      case "VERIFIED":
        return "verified";
      case "PENDING_VERIFICATION":
        return "pending";
      case "NOT_REGISTERED":
        return "unverified";
      default:
        return "unknown";
    }
  };

  const mapDnsRecord = (rec: any): DomainDNSRecord => {
    const r: any = {
      type: rec.type,
      name: rec.name,
      value: rec.value,
    };
    if (typeof rec.priority === "number") r.priority = rec.priority;
    if (typeof rec.isVerified === "boolean") r.verified = rec.isVerified;
    if (typeof rec.lastCheckedAt === "string")
      r.lastCheckedAt = new Date(rec.lastCheckedAt);
    return r as DomainDNSRecord;
  };

  const authHeader = { Authorization: `Bearer ${config.apiKey}` } as const;

  return {
    name: "aiinbx",
    capabilities: AIINBX_CAPABILITIES,
    providerFetch: createProviderFetch({
      baseUrl: apiBase,
      defaultHeaders: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    }),

    sendEmail: async (
      message: EmailMessage<typeof AIINBX_CAPABILITIES>,
      options?: { signal?: AbortSignal }
    ): Promise<SendEmailResult> => {
      // AIInbx API requires html, but we'll provide text as fallback if html is missing
      const html = message.html || message.text || "";
      if (!html) {
        throw new EmailKitError(
          "Either html or text must be provided",
          "aiinbx",
          "MISSING_REQUIRED_FIELD"
        );
      }

      const requestBody: Record<string, unknown> = {
        from: message.from.email,
        to: Array.isArray(message.to)
          ? message.to.map((addr) => addr.email)
          : message.to.email,
        subject: message.subject,
        html: html,
      };

      // Optional from name
      if (message.from.name) {
        requestBody.from_name = message.from.name;
      }

      // Optional text (if both provided)
      if (message.text && message.html) {
        requestBody.text = message.text;
      }

      // Optional CC/BCC/Reply-To (can be string or array)
      if (message.cc) {
        requestBody.cc = Array.isArray(message.cc)
          ? message.cc.map((addr) => addr.email)
          : message.cc.email;
      }
      if (message.bcc) {
        requestBody.bcc = Array.isArray(message.bcc)
          ? message.bcc.map((addr) => addr.email)
          : message.bcc.email;
      }
      const reply = resolveMessageReplyContext(message);
      if (hasReplyData(reply)) {
        const replyAddresses = replyAddressesAsArray(reply);
        if (replyAddresses.length === 1) {
          requestBody.reply_to = replyAddresses[0].email;
        } else if (replyAddresses.length > 1) {
          requestBody.reply_to = replyAddresses.map((addr) => addr.email);
        }
        if (reply.messageId) {
          requestBody.in_reply_to = reply.messageId;
        }
        if (reply.references && reply.references.length > 0) {
          requestBody.references = reply.references;
        }
        if (reply.threadId) {
          requestBody.threadId = reply.threadId;
        }
      }

      const headerInReplyTo = message.headers?.["In-Reply-To"];
      if (headerInReplyTo && !requestBody.in_reply_to) {
        requestBody.in_reply_to = headerInReplyTo;
      }
      const headerReferences = message.headers?.["References"];
      if (headerReferences && !requestBody.references) {
        const headerRefs = headerReferences.split(/\s+/).filter(Boolean);
        if (headerRefs.length > 0) {
          requestBody.references = headerRefs;
        }
      }

      // Handle attachments
      if (message.attachments && message.attachments.length > 0) {
        requestBody.attachments = await Promise.all(
          message.attachments.map(async (att) => {
            // AIInbx requires content as base64 string
            let content: string;

            if (att.content) {
              // Content is available - encode as base64
              content =
                typeof att.content === "string"
                  ? stringToBase64(att.content)
                  : bytesToBase64(att.content);
            } else if (att.url) {
              // URL is provided - fetch content first
              try {
                const res = await fetch(att.url);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const buf = new Uint8Array(await res.arrayBuffer());
                content = bytesToBase64(buf);
              } catch (error) {
                throw new EmailKitError(
                  `Failed to fetch attachment ${att.filename} from URL: ${att.url}`,
                  "aiinbx",
                  "ATTACHMENT_FETCH_FAILED",
                  undefined,
                  error
                );
              }
            } else {
              throw new EmailKitError(
                `Attachment ${att.filename} must have either content or url`,
                "aiinbx",
                "INVALID_ATTACHMENT"
              );
            }

            const attachment: Record<string, unknown> = {
              file_name: att.filename,
              content,
            };

            // Optional content type
            if (att.contentType) {
              attachment.content_type = att.contentType;
            }

            // Set disposition: "inline" for inline attachments, "attachment" for regular attachments
            if (att.isInline) {
              attachment.disposition = "inline";
              // Add CID for inline attachments if provided
              if (att.contentId) {
                attachment.cid = att.contentId;
              }
            } else {
              attachment.disposition = "attachment";
            }

            return attachment;
          })
        );
      }

      // Custom headers - AIInbx doesn't support custom headers in send endpoint
      // Note: Some headers like In-Reply-To and References are handled above
      if (message.headers) {
        const unsupportedHeaders = Object.keys(message.headers).filter(
          (key) => !["In-Reply-To", "References"].includes(key)
        );
        if (unsupportedHeaders.length > 0) {
          // Log warning but don't fail - just skip unsupported headers
          console.warn(
            `AIInbx API does not support custom headers: ${unsupportedHeaders.join(", ")}`
          );
        }
      }

      // Tracking configuration - AIInbx doesn't have explicit tracking controls in send endpoint
      // Tracking is likely enabled by default via webhooks
      if ("track" in message && message.track !== undefined) {
        if (message.track.opens === false || message.track.clicks === false) {
          console.warn(
            "AIInbx API does not support disabling tracking in the send endpoint. Tracking is enabled by default."
          );
        }
      }

      const url = `${baseUrl}/emails/send`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "Content-Type": "application/json",
          },
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
            errorMessage = `Endpoint not found: POST ${url}. Please check the AIInbx API documentation for the correct endpoint.`;
          } else if (res.status === 401) {
            errorMessage = `Unauthorized: Invalid API key. Please check your AI_INBX_API_KEY.`;
          } else if (res.status === 400) {
            errorMessage = `Bad Request: ${errorMessage}. Request body: ${JSON.stringify(requestBody, null, 2)}`;
          } else if (res.status === 403) {
            errorMessage = `Forbidden: ${errorMessage}. You may not have permission to send emails from this address.`;
          } else if (res.status) {
            errorMessage = `HTTP ${res.status}: ${errorMessage} (POST ${url})`;
          }

          throw new EmailKitError(
            errorMessage,
            "aiinbx",
            undefined,
            res.status,
            undefined,
            body
          );
        }

        const emailId = (body as any)?.emailId;
        const messageId = (body as any)?.messageId;
        // const threadId = (body as any)?.threadId; // unused

        if (!emailId || !messageId) {
          throw new EmailKitError(
            `Invalid response from AIInbx API. Expected emailId and messageId. Response: ${typeof body === "string" ? body : JSON.stringify(body)}`,
            "aiinbx",
            undefined,
            res.status,
            undefined,
            body
          );
        }

        return {
          messageId,
          provider: "aiinbx",
          providerId: emailId,
        };
      } catch (error) {
        throw new EmailKitError(
          `Failed to send email: ${error instanceof Error ? error.message : String(error)}`,
          "aiinbx",
          undefined,
          undefined,
          error
        );
      }
    },

    handleWebhook: async (request: WebhookRequest): Promise<WebhookEvent> => {
      const payload = request.body as AIInbxWebhookEvent;

      // Determine event type from payload
      const eventType = payload.event;

      // Handle inbound email event
      if (eventType === "inbound.email.received") {
        const data = payload.data as InboundEmailReceivedData;
        const inboundEvent = await transformInboundEmail(
          data.email,
          payload.timestamp,
          payload, // Pass full webhook payload
          config.autoFetchInboundAttachments ?? true
        );
        return { type: "inbound", data: inboundEvent };
      }

      // Handle outbound events
      const outboundEventTypes = [
        "outbound.email.delivered",
        "outbound.email.bounced",
        "outbound.email.complained",
        "outbound.email.rejected",
        "outbound.email.opened",
        "outbound.email.clicked",
      ] as const;

      if (outboundEventTypes.includes(eventType as any)) {
        const outboundEvent = transformOutboundEvent(
          eventType,
          payload.data,
          payload.timestamp,
          payload // Pass full webhook payload
        );

        // Map to specific event type
        const eventTypeMap: Record<
          typeof eventType,
          | "delivered"
          | "opened"
          | "clicked"
          | "bounced"
          | "complained"
          | "rejected"
        > = {
          "outbound.email.delivered": "delivered",
          "outbound.email.opened": "opened",
          "outbound.email.clicked": "clicked",
          "outbound.email.bounced": "bounced",
          "outbound.email.complained": "complained",
          "outbound.email.rejected": "rejected",
        };

        return {
          type: eventTypeMap[eventType],
          data: outboundEvent,
        } as WebhookEvent;
      }

      return { type: "unknown", data: payload };
    },

    verifyWebhook: config.webhookSecret
      ? async (request: WebhookRequest): Promise<boolean> => {
          // AIInbx uses HMAC SHA-256 signature verification
          // Signature format: sha256=HMAC_SHA256(timestamp.body, webhookSecret)
          // Note: Uses a dot (.) between timestamp and body, not concatenation
          const signatureHeader =
            request.headers["x-aiinbx-signature"] ||
            request.headers["X-AiInbx-Signature"];
          const timestampHeader =
            request.headers["x-aiinbx-timestamp"] ||
            request.headers["X-AiInbx-Timestamp"];

          if (!signatureHeader || !timestampHeader) {
            return false;
          }

          try {
            // Use rawBody if available (for signature verification), otherwise fallback to stringified body
            // The rawBody is the original string before JSON parsing, which is what we need for verification
            const bodyString = request.rawBody || JSON.stringify(request.body);

            // Create expected signature: sha256=HMAC_SHA256(timestamp.body, secret)
            // Note the dot between timestamp and body
            const payload = `${timestampHeader}.${bodyString}`;
            const expectedSignature =
              "sha256=" +
              createHmac("sha256", config.webhookSecret!)
                .update(payload)
                .digest("hex");

            // Compare signatures using timing-safe comparison
            // The signature header already includes the sha256= prefix
            const receivedSignature = signatureHeader;

            // Use timing-safe comparison to prevent timing attacks
            if (receivedSignature.length !== expectedSignature.length) {
              return false;
            }

            return timingSafeEqual(
              Buffer.from(receivedSignature, "utf8"),
              Buffer.from(expectedSignature, "utf8")
            );
          } catch {
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

    // Domains API (partial)
    domains: {
      list: async (): Promise<Domain[]> => {
        const url = `${baseUrl}/domains`;
        const res = await fetch(url, { headers: authHeader });
        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();
        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to list domains`,
            "aiinbx",
            undefined,
            res.status,
            undefined,
            body
          );
        }
        const domains = ((body as any)?.domains || []) as any[];
        return domains.map((d) => {
          const status = mapDomainStatus(d.status);
          const records = Array.isArray(d.dnsRecords)
            ? d.dnsRecords.map(mapDnsRecord)
            : undefined;
          const domain: Domain = {
            id: d.id,
            name: d.domain,
            status,
            createdAt: d.createdAt ? new Date(d.createdAt) : undefined,
            updatedAt: d.updatedAt ? new Date(d.updatedAt) : undefined,
            verification: records
              ? { status, records, checkedAt: undefined }
              : undefined,
            raw: d,
          };
          return domain;
        });
      },

      create: async (input): Promise<Domain> => {
        const url = `${baseUrl}/domains`;
        const res = await fetch(url, {
          method: "POST",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ domain: input.name }),
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
            "aiinbx",
            undefined,
            res.status,
            undefined,
            body
          );
        }
        const domainId = (body as any)?.domainId as string;
        const recs = ((body as any)?.records || []) as any[];
        const records = recs.map(mapDnsRecord);
        const status: Domain["status"] = "pending";
        const domain: Domain = {
          id: domainId,
          name: input.name,
          status,
          verification: { status, records },
          raw: body,
        };
        return domain;
      },

      get: async (idOrName: string): Promise<Domain> => {
        const resolveId = async (): Promise<string> => {
          if (idOrName.includes(".")) {
            const resList = await fetch(`${baseUrl}/domains`, { headers: authHeader });
            const bodyList = await resList.json();
            const domains = ((bodyList as any)?.domains || []) as any[];
            const match = domains.find(
              (d: any) => String(d.domain).toLowerCase() === idOrName.toLowerCase()
            );
            if (!match) {
              throw new EmailKitError(
                `Domain not found: ${idOrName}`,
                "aiinbx",
                "NOT_FOUND",
                404
              );
            }
            return match.id as string;
          }
          return idOrName;
        };
        const id = await resolveId();
        const url = `${baseUrl}/domains/${id}`;
        const res = await fetch(url, { headers: authHeader });
        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();
        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to get domain`,
            "aiinbx",
            undefined,
            res.status,
            undefined,
            body
          );
        }
        const d = body as any;
        const status = mapDomainStatus(d.status);
        const records = Array.isArray(d.dnsRecords)
          ? d.dnsRecords.map(mapDnsRecord)
          : undefined;
        const domain: Domain = {
          id: d.id,
          name: d.domain,
          status,
          createdAt: d.createdAt ? new Date(d.createdAt) : undefined,
          updatedAt: d.updatedAt ? new Date(d.updatedAt) : undefined,
          verification: records
            ? { status, records, checkedAt: undefined }
            : undefined,
          raw: d,
        };
        return domain;
      },

      verify: async (idOrName: string): Promise<DomainVerification> => {
        const resolveId = async (): Promise<string> => {
          if (idOrName.includes(".")) {
            const resList = await fetch(`${baseUrl}/domains`, { headers: authHeader });
            const bodyList = await resList.json();
            const domains = ((bodyList as any)?.domains || []) as any[];
            const match = domains.find(
              (d: any) => String(d.domain).toLowerCase() === idOrName.toLowerCase()
            );
            if (!match) {
              throw new EmailKitError(
                `Domain not found: ${idOrName}`,
                "aiinbx",
                "NOT_FOUND",
                404
              );
            }
            return match.id as string;
          }
          return idOrName;
        };
        const id = await resolveId();
        const url = `${baseUrl}/domains/${id}/verify`;
        const res = await fetch(url, {
          method: "POST",
          headers: { ...authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({}),
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
            "aiinbx",
            undefined,
            res.status,
            undefined,
            body
          );
        }
        const domainObj = (body as any)?.domain as any;
        const status = mapDomainStatus(domainObj?.status);
        const recs = Array.isArray(domainObj?.dnsRecords)
          ? domainObj.dnsRecords.map(mapDnsRecord)
          : [];
        const verification: DomainVerification = {
          status,
          records: recs,
          checkedAt: new Date(),
          raw: body,
        };
        return verification;
      },

      delete: async (idOrName: string): Promise<{ deleted: boolean }> => {
        const resolveId = async (): Promise<string> => {
          if (idOrName.includes(".")) {
            const resList = await fetch(`${baseUrl}/domains`, { headers: authHeader });
            const bodyList = await resList.json();
            const domains = ((bodyList as any)?.domains || []) as any[];
            const match = domains.find(
              (d: any) => String(d.domain).toLowerCase() === idOrName.toLowerCase()
            );
            if (!match) {
              throw new EmailKitError(
                `Domain not found: ${idOrName}`,
                "aiinbx",
                "NOT_FOUND",
                404
              );
            }
            return match.id as string;
          }
          return idOrName;
        };
        const id = await resolveId();
        const url = `${baseUrl}/domains/${id}`;
        const res = await fetch(url, { method: "DELETE", headers: authHeader });
        const contentType = res.headers.get("content-type") || "";
        const body = contentType.includes("application/json")
          ? await res.json()
          : await res.text();
        if (!res.ok) {
          throw new EmailKitError(
            typeof (body as any)?.message === "string"
              ? (body as any).message
              : `HTTP ${res.status}: Failed to delete domain`,
            "aiinbx",
            undefined,
            res.status,
            undefined,
            body
          );
        }
        const success = Boolean((body as any)?.success === true || res.ok);
        return { deleted: success };
      },
    },
  };
};

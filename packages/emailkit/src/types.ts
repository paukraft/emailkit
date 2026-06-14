/**
 * Core types for EmailKit SDK
 */

/**
 * Normalized error class for EmailKit SDK
 */
export class EmailKitError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly code?: string | number,
    public readonly httpStatus?: number,
    public readonly cause?: unknown,
    public readonly raw?: unknown,
  ) {
    super(message);
    this.name = "EmailKitError";
  }
}

/**
 * Error thrown when a sync run fails after events may already have been
 * dispatched. Resume by calling sync again with
 * `since: lastEventTimestamp ?? originalSince` — events are yielded
 * oldest-first, dispatch is at-least-once, dedup by messageId.
 */
export class EmailKitSyncError extends EmailKitError {
  constructor(
    message: string,
    provider: string,
    /** Number of driver events dispatched through hooks before the failure. */
    public readonly dispatched: number,
    /** Timestamp of the last dispatched event, when the driver provided one. */
    public readonly lastEventTimestamp?: Date,
    cause?: unknown,
  ) {
    super(message, provider, "SYNC_FAILED", undefined, cause);
    this.name = "EmailKitSyncError";
  }
}

/**
 * Email address with optional name
 */
export interface EmailAddress {
  email: string;
  name?: string;
}

/**
 * Reply configuration for outbound emails
 */
export type ReplyContext = {
  /**
   * Email address(es) that respondants should target.
   */
  addresses?: EmailAddress[];
  /**
   * RFC 5322 Message-ID being responded to (maps to `In-Reply-To`).
   */
  messageId?: string;
  /**
   * Message-ID chain for thread context (maps to `References`).
   */
  references?: string[];
  /**
   * Provider-specific thread identifier (if supported).
   */
  threadId?: string;
  /**
   * Whether the email is part of an existing thread.
   * Automatically inferred when `messageId` or `references` are set.
   */
  isReply?: boolean;
};

export type EmailTag = string | { name: string; value: string };

/**
 * Unified email attachment type
 *
 * This represents an attachment that can either:
 * - Have content directly available (sent in webhook body)
 * - Be stored by the provider and need to be fetched from a URL
 * - Have both (content available but also stored at a URL)
 *
 * @example
 * ```ts
 * // Handle attachment with content
 * if (attachment.content) {
 *   await fs.writeFile(attachment.filename, attachment.content)
 * }
 *
 * // Handle stored attachment through EmailKit
 * const content = attachment.content ?? await emailkit.attachments.getContent(attachment)
 * await fs.writeFile(attachment.filename, content)
 *
 * // For inline attachments, replace CID references in HTML
 * if (attachment.isInline && attachment.contentId) {
 *   html = html.replace(
 *     `cid:${attachment.contentId}`,
 *     attachment.url || attachment.content // Use URL if available, otherwise content
 *   )
 * }
 * ```
 */
export interface Attachment {
  /**
   * EmailKit driver id that owns this attachment.
   * Inbound webhook attachments are stamped by the EmailKit client so
   * `emailkit.attachments.getContent(attachment)` can self-route later.
   */
  emailDriver?: string;
  /** Filename of the attachment */
  filename: string;
  /**
   * Attachment content (Uint8Array for binary, string for text).
   * Present when attachment is sent directly in webhook body.
   */
  content?: string | Uint8Array;
  /**
   * URL to fetch the attachment content (requires authentication with provider).
   * Present when attachment is stored separately by the provider.
   */
  url?: string;
  /** MIME content type (e.g., "image/png", "application/pdf") */
  contentType?: string;
  /** Size of the attachment in bytes */
  size?: number;
  /**
   * Content-ID (CID) for inline attachments referenced in HTML.
   * This is the value used in HTML to reference the attachment (e.g., "ii_mheuh73y1").
   * In HTML, it's referenced as `cid:ii_mheuh73y1` or `<img src="cid:ii_mheuh73y1">`.
   *
   * Only present for inline attachments (when `isInline` is true).
   */
  contentId?: string;
  /**
   * Whether this attachment is referenced inline in the HTML body.
   *
   * - `true`: Attachment is embedded in HTML (e.g., `<img src="cid:...">`)
   * - `false` or `undefined`: Regular attachment (not inline)
   *
   * When `true`, you should replace `cid:${contentId}` references in the HTML
   * with the actual attachment URL or a proxied version.
   */
  isInline?: boolean;
  /** Provider-specific metadata needed for later attachment retrieval. */
  provider?: Record<string, unknown>;
}

/**
 * Tracking configuration
 */
export interface TrackConfig {
  /** Track email opens (default: true if track is provided) */
  opens?: boolean;
  /** Track link clicks (default: true if track is provided) */
  clicks?: boolean;
}

/**
 * Unsubscribe configuration
 */
export interface UnsubscribeConfig {
  /** Enable global unsubscribe header */
  global?: boolean;
  /** Unsubscribe list ID */
  listId?: string;
  /** Unsubscribe group ID */
  groupId?: string;
}

/**
 * Personalization for per-recipient customization
 */
export interface Personalization {
  /** Recipient email address */
  to: EmailAddress;
  /** CC recipients specific to this personalization */
  cc?: EmailAddress | EmailAddress[];
  /** BCC recipients specific to this personalization */
  bcc?: EmailAddress | EmailAddress[];
  /** Template variable substitutions */
  substitutions?: Record<string, string | number | boolean>;
  /** Custom headers for this recipient */
  headers?: Record<string, string>;
  /** Tags for this recipient */
  tags?: EmailTag[];
  /** Metadata for this recipient */
  metadata?: Record<string, string>;
}

/**
 * Domain identifier type preference for drivers
 */
export type DomainIdentifierType = "domain" | "domainId" | "both";

/**
 * Webhook capability scopes supported by drivers.
 */
export interface DriverWebhookMethodCapabilities {
  /** Create/register webhooks */
  setup?: true;
  /** Refresh/renew webhooks */
  refresh?: true;
  /** Delete/unregister webhooks */
  delete?: true;
}

export type DriverWebhookScopeCapability =
  | true
  | DriverWebhookMethodCapabilities;

export interface DriverWebhookCapabilities {
  /** Account/provider-level webhook management */
  account?: DriverWebhookScopeCapability;
  /** Mailbox-scoped webhook management */
  mailbox?: DriverWebhookScopeCapability;
  /** Domain-scoped webhook management */
  domain?: DriverWebhookScopeCapability;
}

/**
 * Sync (replay of missed events) scopes supported by drivers.
 */
export interface DriverSyncCapabilities {
  /** Account/provider-level sync */
  account?: true;
  /** Mailbox-scoped sync */
  mailbox?: true;
  /** Domain-scoped sync */
  domain?: true;
}

/**
 * Send-time tracking controls supported by drivers.
 */
export interface DriverSendTrackingCapabilities {
  /** Supports enabling/disabling open tracking on send */
  opens?: boolean;
  /** Supports enabling/disabling click tracking on send */
  clicks?: boolean;
}

/**
 * Outbound tracking webhook event types a driver can emit.
 */
export interface DriverEventTrackingCapabilities {
  /** Can emit opened webhook events */
  opens?: true;
  /** Can emit clicked webhook events */
  clicks?: true;
}

/**
 * Method-level domain management capabilities.
 */
export interface DriverDomainCapabilities {
  /** List domains */
  list?: true;
  /** Create domains */
  create?: true;
  /** Fetch a domain */
  get?: true;
  /** Update mutable domain settings */
  update?: true;
  /** Trigger/check domain verification */
  verify?: true;
  /** Delete domains */
  delete?: true;
  /** Provider-native domain identifier type. */
  identifier?: DomainIdentifierType;
}

/**
 * Public URL routes a driver can consume from EmailKit.
 */
export interface DriverPublicRouteCapabilities {
  /** Provider webhook notification URL */
  webhook?: true;
  /** Provider lifecycle/renewal webhook notification URL */
  lifecycleWebhook?: true;
  /** OAuth/mailbox connection callback URL */
  connectCallback?: true;
  /** Success/failure landing URLs after a connection callback */
  connectLanding?: true;
}

/**
 * Driver capabilities
 */
export interface DriverCapabilities {
  /** Supports CC recipients on send */
  cc?: boolean;
  /** Supports BCC recipients on send */
  bcc?: boolean;
  /** Supports Reply-To addresses on send */
  replyTo?: boolean;
  /** Supports RFC reply headers (`In-Reply-To` / `References`) on send */
  replyHeaders?: boolean;
  /**
   * Supports provider-native reply threading on send: the provider threads
   * the outgoing message onto the conversation identified by `reply.messageId`
   * itself instead of accepting raw RFC reply headers.
   */
  nativeReplyThreading?: boolean;
  /** Supports provider-native thread identifiers or reply flags on send */
  replyThreadId?: boolean;
  /** Supports outbound attachments */
  attachments?: boolean;
  /** Supports outbound custom headers */
  customHeaders?: boolean;
  /** Supports outbound provider tags */
  tags?: boolean;
  /** Supports outbound provider metadata */
  metadata?: boolean;
  /** Supports email templates */
  templates?: boolean;
  /** Supports per-recipient personalizations */
  personalizations?: boolean;
  /** Supports scheduled sending */
  scheduling?: boolean;
  /** Supports unsubscribe management */
  unsubscribe?: boolean;
  /** Supports send-time tracking controls */
  sendTracking?: DriverSendTrackingCapabilities;
  /** Can emit tracking webhook events */
  eventTracking?: DriverEventTrackingCapabilities;
  /** Supports sandbox/test mode */
  sandbox?: boolean;
  /** Supports idempotency key on send */
  sendIdempotency?: boolean;
  /** Supports tenant routing/tagging */
  tenantRouting?: boolean;
  /** Supports client/provider escape-hatch fetches */
  providerFetch?: boolean;
  /** Supports send-time provider/mailbox auth via `sender.auth` */
  senderAuth?: boolean;
  /** Supports send-time mailbox identity via `sender.mailbox` */
  senderMailbox?: boolean;
  /** Supports domain management APIs by method. */
  domains?: DriverDomainCapabilities;
  /** Supports webhook management APIs by scope */
  webhooks?: DriverWebhookCapabilities;
  /** Supports sync (replay of missed events) APIs by scope */
  sync?: DriverSyncCapabilities;
  /** Public URL routes this driver consumes from EmailKit */
  publicRoutes?: DriverPublicRouteCapabilities;
  /** Driver requires a configured EmailKit secret for signed callback state or OAuth flows */
  requiresSecret?: boolean;
  /** Driver supports OAuth-like mailbox connection flows */
  mailboxConnect?: boolean;
  /** Driver supports mailbox provisioning */
  mailboxCreate?: boolean;
  /** Driver supports listing mailboxes */
  mailboxList?: boolean;
  /** Driver supports fetching a mailbox */
  mailboxGet?: boolean;
  /** Driver supports deleting mailboxes */
  mailboxDelete?: boolean;
}

/**
 * Driver selector used when an operation can target more than one configured
 * email driver.
 */
export interface EmailDriverSelector<TDriverId extends string = string> {
  emailDriver: TDriverId;
}

type MailboxIdentityBase = Partial<
  Omit<Mailbox, "id" | "email" | "auth" | "raw">
> & {
  auth?: never;
  raw?: never;
};

/**
 * Stable mailbox identity for auth lifecycle hooks. Includes at least one
 * persistence identifier and intentionally excludes auth material.
 */
export type MailboxIdentity = MailboxIdentityBase &
  (
    | { id: string; email?: string }
    | { id?: string; email: string }
    | { id: string; email: string }
  );

/**
 * Optional sender override for outbound mail.
 */
type IsBroadDriverCapabilities<TCapabilities extends DriverCapabilities> =
  keyof TCapabilities extends never
    ? false
    : DriverCapabilities extends TCapabilities
      ? true
      : false;

type SenderAuthOverride<TCapabilities extends DriverCapabilities> =
  IsBroadDriverCapabilities<TCapabilities> extends true
    ? {
        /** Provider/mailbox auth material for this send, when supported by the driver. */
        auth?: unknown;
        /** Mailbox identity for refreshable mailbox sends. */
        mailbox?: MailboxIdentity | Mailbox;
      }
    : (TCapabilities["senderAuth"] extends true
        ? {
            /** Provider/mailbox auth material for this send, when supported by the driver. */
            auth?: unknown;
          }
        : { auth?: never }) &
        (TCapabilities["senderMailbox"] extends true
          ? {
              /** Mailbox identity for refreshable mailbox sends. */
              mailbox?: MailboxIdentity | Mailbox;
            }
          : { mailbox?: never });

export type EmailSenderOverride<
  TDriverId extends string = string,
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> = EmailDriverSelector<TDriverId> &
  SenderAuthOverride<TCapabilities> & {
    /** User round-trip data surfaced in lifecycle hooks. */
    context?: unknown;
  };

/**
 * Base email message structure
 * This is the minimal interface that all drivers must support
 */
export interface BaseEmailMessage {
  from: EmailAddress;
  to: EmailAddress | EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  /** Provider-specific options (escape hatch) */
  provider?: Record<string, unknown>;
}

type SupportsReplyHeaders<TCapabilities extends DriverCapabilities> =
  TCapabilities["replyHeaders"] extends true ? true : false;

type SupportsNativeReplyThreading<TCapabilities extends DriverCapabilities> =
  TCapabilities["nativeReplyThreading"] extends true ? true : false;

type SupportsReplyThreadId<TCapabilities extends DriverCapabilities> =
  TCapabilities["replyThreadId"] extends true ? true : false;

type SupportsAnyReply<TCapabilities extends DriverCapabilities> =
  TCapabilities["replyTo"] extends true
    ? true
    : SupportsReplyHeaders<TCapabilities> extends true
      ? true
      : SupportsNativeReplyThreading<TCapabilities> extends true
        ? true
        : SupportsReplyThreadId<TCapabilities> extends true
          ? true
          : false;

type ReplyContextForCapabilities<TCapabilities extends DriverCapabilities> =
  (TCapabilities["replyTo"] extends true
    ? Pick<ReplyContext, "addresses">
    : {}) &
    (SupportsReplyHeaders<TCapabilities> extends true
      ? Pick<ReplyContext, "messageId" | "references" | "isReply">
      : {}) &
    (SupportsNativeReplyThreading<TCapabilities> extends true
      ? Pick<ReplyContext, "messageId" | "isReply">
      : {}) &
    (SupportsReplyThreadId<TCapabilities> extends true
      ? Pick<ReplyContext, "threadId" | "isReply">
      : {});

type SupportsSendTrackingKind<
  TCapabilities extends DriverCapabilities,
  TKind extends keyof DriverSendTrackingCapabilities,
> = TCapabilities["sendTracking"] extends DriverSendTrackingCapabilities
  ? TCapabilities["sendTracking"][TKind] extends true
    ? true
    : false
  : false;

type SupportsAnySendTracking<TCapabilities extends DriverCapabilities> =
  SupportsSendTrackingKind<TCapabilities, "opens"> extends true
    ? true
    : SupportsSendTrackingKind<TCapabilities, "clicks"> extends true
      ? true
      : false;

/**
 * Email message with optional features based on driver capabilities
 */
export type EmailMessage<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
  TTag extends EmailTag = string,
> = BaseEmailMessage & {
  /**
   * Override the configured sender resolution for this message.
   */
  sender?: EmailSenderOverride<string, TCapabilities>;
} & (TCapabilities["cc"] extends true
    ? {
        cc?: EmailAddress | EmailAddress[];
      }
    : {}) &
  (TCapabilities["bcc"] extends true
    ? {
        bcc?: EmailAddress | EmailAddress[];
      }
    : {}) &
  (SupportsAnyReply<TCapabilities> extends true
    ? {
        /** Reply-To, RFC reply headers, and/or provider thread settings. */
        reply?: ReplyContextForCapabilities<TCapabilities>;
      }
    : {}) &
  (TCapabilities["attachments"] extends true
    ? {
        attachments?: Attachment[];
      }
    : {}) &
  (TCapabilities["customHeaders"] extends true
    ? {
        headers?: Record<string, string>;
      }
    : {}) &
  (TCapabilities["tags"] extends true
    ? {
        tags?: TTag[];
      }
    : {}) &
  (TCapabilities["metadata"] extends true
    ? {
        metadata?: Record<string, string>;
      }
    : {}) &
  (TCapabilities["templates"] extends true
    ? {
        templateId?: string;
        templateData?: Record<string, unknown>;
      }
    : {}) &
  (TCapabilities["personalizations"] extends true
    ? {
        personalizations?: Personalization[];
      }
    : {}) &
  (TCapabilities["scheduling"] extends true
    ? {
        sendAt?: Date | number;
      }
    : {}) &
  (TCapabilities["unsubscribe"] extends true
    ? {
        unsubscribe?: UnsubscribeConfig;
      }
    : {}) &
  (SupportsAnySendTracking<TCapabilities> extends true
    ? {
        track?: TrackConfig;
      }
    : {}) &
  (TCapabilities["sandbox"] extends true
    ? {
        sandbox?: boolean;
      }
    : {}) &
  (TCapabilities["sendIdempotency"] extends true
    ? {
        /** Prevent duplicate sends on retries */
        idempotencyKey?: string;
      }
    : {}) &
  (TCapabilities["tenantRouting"] extends true
    ? {
        /** Your tenant/customer label for routing/observability */
        tenantId?: string;
      }
    : {});

/**
 * Result of sending an email
 */
export interface SendEmailResult {
  messageId: string;
  provider: string;
  /** Provider/native thread identifier, when returned by the driver. */
  threadId?: string;
  /** Request identifier for tracing (if provided by driver) */
  requestId?: string;
  /**
   * Provider-specific email identifier (in addition to messageId).
   * This is the provider's internal ID for this email, separate from the RFC Message-ID.
   * Useful for provider-specific operations or tracking.
   */
  providerId?: string;
  /**
   * How `reply.messageId` threading was honored by drivers with the
   * `nativeReplyThreading` capability.
   *
   * - "applied": the provider created a native reply to `reply.messageId`,
   *   so the outgoing message carries proper reply headers and threading.
   * - "skipped": `reply.messageId` was provided but the source message was
   *   not found in the mailbox; the message was sent unthreaded.
   *
   * Absent for drivers that emit RFC reply headers directly (the
   * `replyHeaders` capability) and for sends without `reply.messageId`.
   */
  replyThreading?: "applied" | "skipped";
  accepted?: string[];
  rejected?: string[];
}

/**
 * Inbound email event data
 *
 * This is a generic abstraction that works across all email providers.
 * Each driver implementation transforms provider-specific webhook payloads into this format.
 *
 * @example
 * ```ts
 * hooks: {
 *   email: {
 *     onInbound: async (event) => {
 *       // Handle attachments (can have content, url, or both)
 *       if (event.attachments) {
 *         for (const attachment of event.attachments) {
 *           const content = await emailkit.attachments.getContent(attachment)
 *           await saveFile(attachment.filename, content)
 *         }
 *       }
 *     }
 *   }
 * }
 * ```
 */
export interface InboundEmailEvent {
  /** EmailKit driver id that produced this event, attached by the EmailKit client. */
  emailDriver?: string;
  /** Schema version for forward-compat */
  schemaVersion?: "1";
  /** Unique event identifier for dedupe */
  eventId?: string;
  /** Unique message identifier from the email provider */
  messageId: string;
  /**
   * Provider-specific message identifier (in addition to messageId).
   * This is the provider's internal ID for this message, separate from the RFC Message-ID.
   * Useful for provider-specific operations or tracking.
   */
  providerId?: string;
  /** Sender email address */
  from: EmailAddress;
  /** Recipient email addresses */
  to: EmailAddress[];
  /** Carbon copy recipients (if available) */
  cc?: EmailAddress[];
  /** Blind carbon copy recipients (if available) */
  bcc?: EmailAddress[];
  /**
   * Thread metadata, mirroring the outbound `reply` shape.
   */
  reply: ReplyContext;
  /** Email subject */
  subject: string;
  /** Plain text body (if available) */
  text?: string;
  /** HTML body (if available) */
  html?: string;
  /** Plain text body stripped of quoted content (if provided) */
  strippedText?: string;
  /** HTML body stripped of quoted content (if provided) */
  strippedHtml?: string;
  /**
   * Unified attachments array.
   * Each attachment can have:
   * - `content`: Attachment content available directly (sent in webhook body)
   * - `url`: URL to fetch attachment (stored separately by provider)
   * - Both: Content available but also stored at URL
   *
   * Inline attachments (referenced in HTML with CID) will have:
   * - `isInline: true`
   * - `contentId` set to the CID value (e.g., "ii_mheuh73y1")
   *
   * Regular attachments will have:
   * - `isInline: false` or undefined
   * - `contentId` may be undefined
   */
  attachments?: Attachment[];
  /** Email headers as key-value pairs */
  headers: Record<string, string>;
  /** Timestamp when the email was received */
  timestamp: Date;
  /** Provider-specific raw data (for debugging or advanced use cases) */
  raw?: unknown;
}

/**
 * Outbound email event data
 *
 * This is a generic abstraction that works across all email providers.
 * Each driver implementation transforms provider-specific webhook payloads into this format.
 *
 * Note: Not all fields are available for all event types:
 * - "sent"/"accepted" events: Usually have from, to, subject
 * - "opened"/"clicked" events: Usually only have messageId and recipient
 * - "bounced"/"rejected" events: Usually have messageId, recipient, and reason
 *
 * @example
 * ```ts
 * hooks: {
 *   email: {
 *     onDelivered: async (event) => {
 *       console.log(`Email delivered to ${event.recipient}`)
 *     },
 *     onBounced: async (event) => {
 *       console.log(`Bounce: ${event.reason}`)
 *     },
 *   }
 * }
 * ```
 */
export interface OutboundEmailEvent {
  /** EmailKit driver id that produced this event, attached by the EmailKit client. */
  emailDriver?: string;
  /** Schema version for forward-compat */
  schemaVersion?: "1";
  /** Unique event identifier for dedupe */
  eventId?: string;
  /** Unique message identifier from the email provider */
  messageId: string;
  /**
   * Provider-specific message identifier (in addition to messageId).
   * This is the provider's internal ID for this message, separate from the RFC Message-ID.
   * Useful for provider-specific operations or tracking.
   */
  providerId?: string;
  /** Email address of the recipient (always available) */
  recipient: string;
  /** Event status/type */
  status:
    | "sent"
    | "delivered"
    | "opened"
    | "clicked"
    | "bounced"
    | "complained"
    | "rejected";
  /** Timestamp when the event occurred */
  timestamp: Date;

  // Common email fields (available in sent/accepted events)
  /** Sender email address (available in sent/accepted events) */
  from?: EmailAddress;
  /** Recipient email addresses (available in sent/accepted events) */
  to?: EmailAddress[];
  /** Email subject (available in sent/accepted events) */
  subject?: string;

  // Tracking and metadata
  /** Custom metadata/tags associated with the email */
  tags?: EmailTag[];
  /** Custom metadata key-value pairs */
  metadata?: Record<string, string>;
  /** Campaign or tracking identifier */
  campaignId?: string;

  // Delivery information
  /** Domain of the recipient (e.g., "gmail.com") */
  recipientDomain?: string;
  /** Receiving server information */
  server?: string;

  /** Provider-specific raw data (for debugging or advanced use cases) */
  raw?: unknown;
}

/**
 * Webhook request (generic, provider-specific implementations will extend)
 */
export interface WebhookRequest {
  method: string;
  headers: Record<string, string>;
  body: unknown;
  /**
   * Raw body string (before JSON parsing).
   * Required for signature verification in some providers (e.g., AIInbx).
   */
  rawBody?: string;
  query?: Record<string, string>;
  raw?: unknown;
}

/**
 * Webhook response
 */
export interface WebhookResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Standardized webhook event union returned by drivers
 */
export type WebhookEvent =
  | { type: "inbound"; data: InboundEmailEvent }
  | { type: "outbound"; data: OutboundEmailEvent }
  | { type: "delivered"; data: OutboundEmailEvent & { responseTime?: number } }
  | {
      type: "opened";
      data: OutboundEmailEvent & {
        ip?: string;
        userAgent?: string;
        timeSinceSendMs?: number;
        location?: {
          city?: string;
          country?: string;
          region?: string;
          timezone?: string;
        };
        deviceType?: string;
        clientType?: string;
        os?: string;
        botDetection?: { isBot: boolean; reason: string };
      };
    }
  | {
      type: "clicked";
      data: OutboundEmailEvent & {
        url?: string;
        ip?: string;
        userAgent?: string;
        location?: {
          city?: string;
          country?: string;
          region?: string;
          timezone?: string;
        };
        deviceType?: string;
        clientType?: string;
        os?: string;
        botDetection?: { isBot: boolean; reason: string };
      };
    }
  | {
      type: "bounced";
      data: OutboundEmailEvent & {
        reason?: string;
        severity?: "permanent" | "temporary";
        code?: string | number;
        smtpResponse?: string;
      };
    }
  | {
      type: "complained";
      data: OutboundEmailEvent & {
        feedbackType?: string;
        feedback?: string;
        source?: string;
      };
    }
  | {
      type: "rejected";
      data: OutboundEmailEvent & {
        reason?: string;
        code?: string | number;
        smtpResponse?: string;
        category?: string;
      };
    }
  | { type: "unknown"; data: unknown };

export type WebhookLifecycleDriverEvent = {
  type: "webhook.lifecycle";
  data: WebhookLifecycleEvent;
};

export type WebhookDriverEvent = WebhookEvent | WebhookLifecycleDriverEvent;

export type WebhookEventResult = WebhookDriverEvent | WebhookDriverEvent[];

export type WebhookScope = "account" | "mailbox" | "domain";

export type WebhookEventType =
  | "inbound"
  | "outbound"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "rejected"
  | "unknown"
  | (string & {});

export type WebhookEventSelection = "all" | WebhookEventType[];

export interface WebhookInboundOptions {
  /**
   * Recipients to route for inbound-capable providers. Use "all" only when
   * you intentionally want a catch-all inbound route.
   */
  recipients?: "all" | string | string[];
  /**
   * Provider-native route/filter expression for providers that expose one.
   */
  routeExpression?: string;
}

export type WebhookStatus =
  | "active"
  | "pending"
  | "disabled"
  | "deleted"
  | "expired"
  | "unknown";

export interface Webhook {
  id: string;
  /** EmailKit driver id that owns this webhook, attached by the EmailKit client when known. */
  emailDriver?: string;
  scope: WebhookScope;
  url: string;
  events?: WebhookEventType[];
  status: WebhookStatus;
  providerId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  expiresAt?: Date;
  renewAfter?: Date;
  provider?: Record<string, unknown>;
  raw?: unknown;
}

export interface WebhookSetupInput {
  url?: string;
  events?: WebhookEventSelection;
  inbound?: WebhookInboundOptions;
  secret?: string;
  context?: unknown;
  provider?: Record<string, unknown>;
}

export type WebhookReference =
  | { webhook: Webhook; webhookId?: string }
  | { webhook?: Webhook; webhookId: string }
  | { webhook?: Webhook; providerId: string; webhookId?: string };

export type WebhookRefreshInput = WebhookReference & {
  context?: unknown;
  provider?: Record<string, unknown>;
};

export type WebhookDeleteInput = WebhookReference & {
  context?: unknown;
  provider?: Record<string, unknown>;
};

export interface WebhookSetupResult {
  webhook: Webhook;
  context?: unknown;
  raw?: unknown;
}

export interface WebhookRefreshResult {
  webhook: Webhook;
  context?: unknown;
  raw?: unknown;
}

export interface WebhookDeleteResult {
  deleted: boolean;
  webhook?: Webhook;
  context?: unknown;
  raw?: unknown;
}

export type AccountWebhookSetupInput = WebhookSetupInput;
export type AccountWebhookRefreshInput = WebhookRefreshInput;
export type AccountWebhookDeleteInput = WebhookDeleteInput;
export type AccountWebhookSetupResult = WebhookSetupResult;
export type AccountWebhookRefreshResult = WebhookRefreshResult;
export type AccountWebhookDeleteResult = WebhookDeleteResult;

export type MaybePromise<T> = T | Promise<T>;
export type HookResult = MaybePromise<void>;

/**
 * Hook function types
 */
export type InboundEmailHook = (event: InboundEmailEvent) => HookResult;
export type OutboundEmailHook = (event: OutboundEmailEvent) => HookResult;
/**
 * Hook for delivered email events
 */
export type OutboundEmailDeliveredHook = (
  event: OutboundEmailEvent & {
    /** Response time in milliseconds (if available) */
    responseTime?: number;
  },
) => HookResult;

/**
 * Hook for email opened events
 */
export type OutboundEmailOpenedHook = (
  event: OutboundEmailEvent & {
    /** IP address of the user who opened the email */
    ip?: string;
    /** User agent string of the browser/client */
    userAgent?: string;
    /** Milliseconds since send (or delivery), if available */
    timeSinceSendMs?: number;
    /** Geolocation information */
    location?: {
      /** City name */
      city?: string;
      /** Country code or name */
      country?: string;
      /** Region/state */
      region?: string;
      /** Timezone */
      timezone?: string;
    };
    /** Device type (mobile, desktop, tablet, etc.) */
    deviceType?: string;
    /** Email client name (Gmail, Outlook, etc.) */
    clientType?: string;
    /** Operating system */
    os?: string;
    /** Bot detection result */
    botDetection?: {
      /** Whether this is detected as a bot */
      isBot: boolean;
      /** Reason for the bot detection decision */
      reason: string;
    };
  },
) => HookResult;

/**
 * Hook for email link clicked events
 */
export type OutboundEmailClickedHook = (
  event: OutboundEmailEvent & {
    /** URL that was clicked */
    url?: string;
    /** IP address of the user who clicked */
    ip?: string;
    /** User agent string of the browser/client */
    userAgent?: string;
    /** Geolocation information */
    location?: {
      /** City name */
      city?: string;
      /** Country code or name */
      country?: string;
      /** Region/state */
      region?: string;
      /** Timezone */
      timezone?: string;
    };
    /** Device type (mobile, desktop, tablet, etc.) */
    deviceType?: string;
    /** Email client name (Gmail, Outlook, etc.) */
    clientType?: string;
    /** Operating system */
    os?: string;
    /** Bot detection result */
    botDetection?: {
      /** Whether this is detected as a bot */
      isBot: boolean;
      /** Reason for the bot detection decision */
      reason: string;
    };
  },
) => HookResult;

/**
 * Hook for bounced email events
 */
export type OutboundEmailBouncedHook = (
  event: OutboundEmailEvent & {
    /** Human-readable bounce reason/message */
    reason?: string;
    /** Bounce severity: permanent (hard bounce) or temporary (soft bounce) */
    severity?: "permanent" | "temporary";
    /** Error code from the email provider */
    code?: string | number;
    /** SMTP response code and message */
    smtpResponse?: string;
    /** Bounce category/type */
    category?: string;
  },
) => HookResult;

/**
 * Hook for spam complaint events
 */
export type OutboundEmailComplainedHook = (
  event: OutboundEmailEvent & {
    /** Type of complaint (spam, abuse, etc.) */
    feedbackType?: string;
    /** Feedback loop message */
    feedback?: string;
    /** Complaint source (ESP, ISP, etc.) */
    source?: string;
  },
) => HookResult;

/**
 * Hook for rejected email events
 */
export type OutboundEmailRejectedHook = (
  event: OutboundEmailEvent & {
    /** Human-readable rejection reason */
    reason?: string;
    /** Error code from the email provider */
    code?: string | number;
    /** SMTP response code and message */
    smtpResponse?: string;
    /** Rejection category/type */
    category?: string;
  },
) => HookResult;

/**
 * Hook for unknown/unrecognized events
 */
export type UnknownEventHook = (event: {
  emailDriver?: string;
  type: "unknown";
  data: unknown;
  raw?: unknown;
}) => HookResult;

/**
 * Hook that receives all events (runs before specific hooks)
 */
export type AllEventsHook = (event: {
  emailDriver?: string;
  type:
    | "inbound"
    | "outbound"
    | "delivered"
    | "opened"
    | "clicked"
    | "bounced"
    | "complained"
    | "rejected"
    | "unknown";
  data: unknown;
  raw?: unknown;
  /** User round-trip data from `SyncInput.context`, set only for sync-replayed events. */
  context?: unknown;
}) => HookResult;

export interface MailboxHookEvent {
  emailDriver: string;
  mailbox: Mailbox;
  context?: unknown;
}

export interface MailboxConnectedHookEvent extends MailboxHookEvent {
  auth?: unknown;
}

export interface MailboxAuthUpdatedHookEvent {
  emailDriver: string;
  mailbox: MailboxIdentity;
  auth: unknown;
  context?: unknown;
  raw?: unknown;
}

export interface DomainHookEvent {
  emailDriver: string;
  domain: Domain;
  context?: unknown;
}

export type WebhookLifecycleAction =
  | "created"
  | "updated"
  | "deleted"
  | "action_required"
  | "sync_required";

export type WebhookLifecycleSource = "api" | "provider" | "system";

export type WebhookLifecycleReason =
  | "created"
  | "renewed"
  | "refreshed"
  | "status_changed"
  | "endpoint_updated"
  | "events_updated"
  | "deleted"
  | "subscription_removed"
  | "expired"
  | "expiring"
  | "reauthorization_required"
  | "auth_revoked"
  | "endpoint_unreachable"
  | "delivery_failing"
  | "notifications_missed"
  | "history_gap"
  | "provider_disabled"
  | "not_found"
  | "unknown"
  | (string & {});

export type WebhookRecommendedAction =
  | "persist"
  | "renew"
  | "reauthorize"
  | "recreate"
  | "sync"
  | "delete_local"
  | "fix_endpoint"
  | "inspect"
  | (string & {});

export interface WebhookLifecycleTarget {
  mailboxEmail?: string;
  mailboxId?: string;
  domain?: string;
}

export interface WebhookLifecycleEventBase {
  id?: string;
  emailDriver: string;
  action: WebhookLifecycleAction;
  source: WebhookLifecycleSource;
  reason: WebhookLifecycleReason;
  recommendedActions?: WebhookRecommendedAction[];
  scope: WebhookScope;
  webhook?: Webhook;
  previousWebhook?: Webhook;
  webhookId?: string;
  providerId?: string;
  subscriptionId?: string;
  target?: WebhookLifecycleTarget;
  status?: WebhookStatus;
  previousStatus?: WebhookStatus;
  expiresAt?: Date;
  renewAfter?: Date;
  receivedAt?: Date;
  severity?: "info" | "warning" | "critical";
  context?: unknown;
  raw?: unknown;
}

export type WebhookLifecycleHookEvent =
  | (WebhookLifecycleEventBase & { action: "created"; webhook: Webhook })
  | (WebhookLifecycleEventBase & { action: "updated"; webhook: Webhook })
  | (WebhookLifecycleEventBase & { action: "deleted" })
  | (WebhookLifecycleEventBase & { action: "action_required" })
  | (WebhookLifecycleEventBase & { action: "sync_required" });

export type WebhookLifecycleEvent = WebhookLifecycleHookEvent;

export interface EmailHookEvent<TEvent = unknown> {
  emailDriver: string;
  event: TEvent;
  raw?: unknown;
}

/**
 * Hooks configuration grouped by EmailKit resource area.
 */
export interface EmailKitHooks {
  mailbox?: {
    onConnected?: (event: MailboxConnectedHookEvent) => HookResult;
    onCreated?: (event: MailboxHookEvent) => HookResult;
    onDeleted?: (event: MailboxHookEvent) => HookResult;
    onAuthUpdated?: (event: MailboxAuthUpdatedHookEvent) => HookResult;
  };
  domain?: {
    onCreated?: (event: DomainHookEvent) => HookResult;
    onVerified?: (event: DomainHookEvent) => HookResult;
    onDeleted?: (event: DomainHookEvent) => HookResult;
  };
  webhook?: {
    onCreated?: (
      event: Extract<WebhookLifecycleEvent, { action: "created" }>,
    ) => HookResult;
    onUpdated?: (
      event: Extract<WebhookLifecycleEvent, { action: "updated" }>,
    ) => HookResult;
    onDeleted?: (
      event: Extract<WebhookLifecycleEvent, { action: "deleted" }>,
    ) => HookResult;
    onActionRequired?: (
      event: Extract<WebhookLifecycleEvent, { action: "action_required" }>,
    ) => HookResult;
    onSyncRequired?: (
      event: Extract<WebhookLifecycleEvent, { action: "sync_required" }>,
    ) => HookResult;
    onAll?: (event: WebhookLifecycleEvent) => HookResult;
  };
  email?: {
    onInbound?: InboundEmailHook;
    onOutbound?: OutboundEmailHook;
    onDelivered?: OutboundEmailDeliveredHook;
    onOpened?: OutboundEmailOpenedHook;
    onClicked?: OutboundEmailClickedHook;
    onBounced?: OutboundEmailBouncedHook;
    onComplained?: OutboundEmailComplainedHook;
    onRejected?: OutboundEmailRejectedHook;
    onUnknown?: UnknownEventHook;
    onAll?: AllEventsHook;
  };
}

/**
 * Domain & DNS Management Types (unified across providers)
 */

/**
 * DNS record types we commonly encounter for email sending
 * Extended with A/AAAA for potential tracking/click domains
 */
export type DNSRecordType = "TXT" | "CNAME" | "MX" | "A" | "AAAA";

/**
 * Purpose/category of a DNS record in email domain setup
 */
export type DomainRecordPurpose =
  | "spf"
  | "dkim"
  | "dmarc"
  | "mx"
  | "returnPath"
  | "tracking"
  | "custom";

/**
 * High-level domain verification status
 */
export type DomainStatus =
  | "unverified"
  | "pending"
  | "verified"
  | "disabled"
  | "unknown";

/**
 * Normalized DNS record definition for domain verification
 */
export interface DomainDNSRecord {
  /** DNS record type */
  type: DNSRecordType;
  /** Host/name for the record (relative like "_dmarc" or FQDN) */
  name: string;
  /** Record value (TXT content, CNAME target, MX host, etc.) */
  value: string;
  /** TTL in seconds or 'auto' when provider returns automatic TTL */
  ttl?: number | "auto";
  /** MX priority if applicable */
  priority?: number;
  /** Purpose of this record within email setup */
  purpose?: DomainRecordPurpose;
  /** Whether the provider reports this record as verified/present */
  verified?: boolean;
  /** Last time the provider checked this record */
  lastCheckedAt?: Date;
}

/**
 * Verification state and instructions for a domain
 */
export interface DomainVerification {
  /** Overall verification status for the domain */
  status: DomainStatus;
  /** Required and relevant DNS records */
  records: DomainDNSRecord[];
  /** When the verification state was last checked */
  checkedAt?: Date;
  /** When to check again (if provider hints) */
  nextCheckAfter?: Date;
  /** Provider-specific raw data (for debugging or advanced use cases) */
  raw?: unknown;
}

/**
 * Unified domain object
 */
export interface Domain {
  /** Provider identifier if available; falls back to domain */
  id: string;
  /** The domain name (e.g., example.com) */
  domain: string;
  /** Current provider-reported status */
  status: DomainStatus;
  /** Optional sending region (e.g., us-east-1) */
  region?: string;
  /** Timestamps if the provider exposes them */
  createdAt?: Date;
  updatedAt?: Date;
  /** DKIM selector if explicit/known */
  dkimSelector?: string;
  /** Return-Path subdomain (a.k.a. mail-from/bounce) */
  returnPathSubdomain?: string;
  /** Verification data including required DNS records */
  verification?: DomainVerification;
  /** Provider-specific raw data (for debugging or advanced use cases) */
  raw?: unknown;
}

/**
 * List domains filter/pagination
 */
export interface ListDomainsOptions {
  /** Filter by verification status */
  status?: Extract<DomainStatus, "verified" | "unverified" | "pending">;
  /** Page index (1-based unless provider defines otherwise) */
  page?: number;
  /** Page size */
  pageSize?: number;
  /** Number of results to retrieve (provider-specific pagination) */
  limit?: number;
  /** Provider-specific filters */
  provider?: Record<string, unknown>;
}

/**
 * Create a new sending domain
 */
export interface CreateDomainInput {
  /** Domain name to create (e.g., example.com) */
  domain: string;
  /** User round-trip data surfaced in hooks. */
  context?: unknown;
  /** Explicit DKIM selector if supported */
  dkimSelector?: string;
  /** Custom Return-Path subdomain (e.g., send, bounce) */
  returnPathSubdomain?: string;
  /** Sending region if the provider supports it (e.g., us-east-1) */
  region?: string;
  /** Tracking defaults at domain level if supported */
  tracking?: { opens?: boolean; clicks?: boolean };
  /** Provider-specific creation options */
  provider?: Record<string, unknown>;
}

/**
 * Update mutable domain settings
 */
export interface UpdateDomainInput {
  /** Update tracking defaults (if provider supports it) */
  tracking?: { opens?: boolean; clicks?: boolean };
  /** Change DKIM selector (regenerate or switch if supported) */
  dkimSelector?: string;
  /** Change Return-Path subdomain if supported */
  returnPathSubdomain?: string;
  /** Provider-specific update options */
  provider?: Record<string, unknown>;
}

/**
 * Result for delete/remove domain operations
 */
export interface DomainDeleteResult {
  deleted: boolean;
}

/**
 * Result of an idempotent domain provisioning call.
 */
export interface DomainEnsureResult {
  domain: Domain;
  created: boolean;
}

/**
 * Normalized mailbox identity for drivers that support mailbox connection or
 * provisioning. Auth material is returned and passed separately.
 */
export interface Mailbox {
  id: string;
  email: string;
  displayName?: string;
  status?: "connected" | "pending" | "disabled" | "unknown";
  createdAt?: Date;
  updatedAt?: Date;
  raw?: unknown;
}

type ConnectMailboxRouteInput<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> = (SupportsPublicRoute<TCapabilities, "connectCallback"> extends true
  ? { callbackUrl?: string }
  : { callbackUrl?: never }) &
  (SupportsPublicRoute<TCapabilities, "connectLanding"> extends true
    ? {
        landingUrl?: string;
        failureUrl?: string;
      }
    : {
        landingUrl?: never;
        failureUrl?: never;
      });

export type ConnectMailboxInput<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> = {
  email?: string;
  scopes?: string[];
  context?: unknown;
  provider?: Record<string, unknown>;
} & ConnectMailboxRouteInput<TCapabilities>;

export interface CreateMailboxInput {
  email: string;
  displayName?: string;
  auth?: unknown;
  context?: unknown;
  provider?: Record<string, unknown>;
}

export interface ListMailboxesOptions {
  status?: Mailbox["status"];
  page?: number;
  pageSize?: number;
  limit?: number;
  provider?: Record<string, unknown>;
}

export interface MailboxConnectionResult {
  mailbox?: Mailbox;
  auth?: unknown;
  /**
   * Webhooks created as part of the mailbox connection lifecycle.
   * Drivers use this when connection can implicitly provision subscriptions,
   * such as OAuth callback auto-subscribe flows.
   */
  webhooks?: Webhook[];
  redirectUrl?: string;
  landingUrl?: string;
  failureUrl?: string;
  state?: string;
  context?: unknown;
  raw?: unknown;
}

export type PublicRouteTemplate = string;

export type PublicRouteDriverConfig =
  | PublicRouteTemplate
  | {
      route?: PublicRouteTemplate;
      lifecycle?: PublicRouteTemplate;
    };

export interface PublicRouteGroup {
  route?: PublicRouteTemplate;
  drivers?: Record<string, PublicRouteDriverConfig>;
}

export interface PublicRoutesConfig {
  baseUrl?: string;
  route?: PublicRouteTemplate;
  webhookRoutes?: PublicRouteGroup;
  connectCallbackRoutes?: PublicRouteGroup;
  connectLandingRoutes?: {
    success?: string;
    failure?: string;
  };
  allowedLandingOrigins?: string[];
}

type SupportsPublicRoute<
  TCapabilities extends DriverCapabilities,
  TRoute extends keyof DriverPublicRouteCapabilities,
> =
  IsBroadDriverCapabilities<TCapabilities> extends true
    ? true
    : TCapabilities["publicRoutes"] extends DriverPublicRouteCapabilities
      ? TCapabilities["publicRoutes"][TRoute] extends true
        ? true
        : false
      : false;

export type DriverPublicRoutes<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> = (SupportsPublicRoute<TCapabilities, "webhook"> extends true
  ? { webhookUrl?: string }
  : {}) &
  (SupportsPublicRoute<TCapabilities, "lifecycleWebhook"> extends true
    ? { lifecycleWebhookUrl?: string }
    : {}) &
  (SupportsPublicRoute<TCapabilities, "connectCallback"> extends true
    ? { connectCallbackUrl?: string }
    : {}) &
  (SupportsPublicRoute<TCapabilities, "connectLanding"> extends true
    ? {
        connectLandingUrl?: string;
        connectFailureUrl?: string;
      }
    : {});

export interface MailboxDeleteResult {
  deleted: boolean;
}

/**
 * Domain identifier for domain operations.
 * The exact shape depends on the driver's `domains.identifier` capability:
 * - 'domain': requires domain, domainId is optional
 * - 'domainId': requires domainId, domain is optional
 * - 'both' or undefined: requires at least one of domain or domainId
 */
export type DomainIdentifier<
  TIdentifierType extends DomainIdentifierType = "both",
> = TIdentifierType extends "domain"
  ? { domain: string; domainId?: string }
  : TIdentifierType extends "domainId"
    ? { domain?: string; domainId: string }
    : { domain?: string; domainId?: string } & (
        | { domain: string }
        | { domainId: string }
        | { domain: string; domainId: string }
      );

export type DomainOperationInput<
  TIdentifierType extends DomainIdentifierType = "both",
> = DomainIdentifier<TIdentifierType> & {
  /** User round-trip data surfaced in hooks. */
  context?: unknown;
};

export type MailboxWebhookTarget =
  | {
      mailbox: MailboxIdentity | Mailbox;
      auth?: unknown;
      mailboxId?: string;
      email?: string;
    }
  | {
      mailbox?: MailboxIdentity | Mailbox;
      auth?: unknown;
      mailboxId: string;
      email?: string;
    }
  | {
      mailbox?: MailboxIdentity | Mailbox;
      auth?: unknown;
      mailboxId?: string;
      email: string;
    };

export type MailboxWebhookSetupInput = WebhookSetupInput & MailboxWebhookTarget;
export type MailboxWebhookRefreshInput = WebhookRefreshInput &
  Partial<MailboxWebhookTarget>;
export type MailboxWebhookDeleteInput = WebhookDeleteInput &
  Partial<MailboxWebhookTarget>;
export type MailboxWebhookSetupResult = WebhookSetupResult;
export type MailboxWebhookRefreshResult = WebhookRefreshResult;
export type MailboxWebhookDeleteResult = WebhookDeleteResult;

export type DomainWebhookSetupInput = WebhookSetupInput & DomainIdentifier;
export type DomainWebhookRefreshInput = WebhookRefreshInput &
  Partial<DomainIdentifier>;
export type DomainWebhookDeleteInput = WebhookDeleteInput &
  Partial<DomainIdentifier>;
export type DomainWebhookSetupResult = WebhookSetupResult;
export type DomainWebhookRefreshResult = WebhookRefreshResult;
export type DomainWebhookDeleteResult = WebhookDeleteResult;

/**
 * Input for sync (replay of missed events) operations.
 */
export interface SyncInput {
  /** Replay events received at or after this time. */
  since: Date;
  /** Optional exclusive upper bound; defaults to now. */
  until?: Date;
  /** Abort long-running syncs. */
  signal?: AbortSignal;
  /** User round-trip data surfaced on the email onAll hook envelope for replayed events. */
  context?: unknown;
  /** Provider-specific options (escape hatch) */
  provider?: Record<string, unknown>;
}

export type AccountSyncInput = SyncInput;
export type MailboxSyncInput = SyncInput & MailboxWebhookTarget;
export type DomainSyncInput = SyncInput & DomainIdentifier;

/**
 * Result of a completed sync run.
 */
export interface SyncResult {
  /** Number of driver events dispatched through hooks. */
  dispatched: number;
  /**
   * Earliest time the provider data actually covered. Greater than `since`
   * when provider retention cut the window short.
   */
  syncedFrom: Date;
}

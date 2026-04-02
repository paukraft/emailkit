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
    super(message)
    this.name = 'EmailKitError'
  }
}

/**
 * Email address with optional name
 */
export interface EmailAddress {
  email: string
  name?: string
}

/**
 * Reply configuration for outbound emails
 */
export type ReplyContext = {
  /**
   * Email address(es) that respondants should target.
   */
  addresses?: EmailAddress[]
  /**
   * RFC 5322 Message-ID being responded to (maps to `In-Reply-To`).
   */
  messageId?: string
  /**
   * Message-ID chain for thread context (maps to `References`).
   */
  references?: string[]
  /**
   * Provider-specific thread identifier (if supported).
   */
  threadId?: string
  /**
   * Whether the email is part of an existing thread.
   * Automatically inferred when `messageId` or `references` are set.
   */
  isReply?: boolean
}

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
  /** Filename of the attachment */
  filename: string
  /**
   * Attachment content (Uint8Array for binary, string for text).
   * Present when attachment is sent directly in webhook body.
   */
  content?: string | Uint8Array
  /**
   * URL to fetch the attachment content (requires authentication with provider).
   * Present when attachment is stored separately by the provider.
   */
  url?: string
  /** MIME content type (e.g., "image/png", "application/pdf") */
  contentType?: string
  /** Size of the attachment in bytes */
  size?: number
  /**
   * Content-ID (CID) for inline attachments referenced in HTML.
   * This is the value used in HTML to reference the attachment (e.g., "ii_mheuh73y1").
   * In HTML, it's referenced as `cid:ii_mheuh73y1` or `<img src="cid:ii_mheuh73y1">`.
   *
   * Only present for inline attachments (when `isInline` is true).
   */
  contentId?: string
  /**
   * Whether this attachment is referenced inline in the HTML body.
   *
   * - `true`: Attachment is embedded in HTML (e.g., `<img src="cid:...">`)
   * - `false` or `undefined`: Regular attachment (not inline)
   *
   * When `true`, you should replace `cid:${contentId}` references in the HTML
   * with the actual attachment URL or a proxied version.
   */
  isInline?: boolean
}

/**
 * Tracking configuration
 */
export interface TrackConfig {
  /** Track email opens (default: true if track is provided) */
  opens?: boolean
  /** Track link clicks (default: true if track is provided) */
  clicks?: boolean
}

/**
 * Unsubscribe configuration
 */
export interface UnsubscribeConfig {
  /** Enable global unsubscribe header */
  global?: boolean
  /** Unsubscribe list ID */
  listId?: string
  /** Unsubscribe group ID */
  groupId?: string
}

/**
 * Personalization for per-recipient customization
 */
export interface Personalization {
  /** Recipient email address */
  to: EmailAddress
  /** CC recipients specific to this personalization */
  cc?: EmailAddress | EmailAddress[]
  /** BCC recipients specific to this personalization */
  bcc?: EmailAddress | EmailAddress[]
  /** Template variable substitutions */
  substitutions?: Record<string, string | number | boolean>
  /** Custom headers for this recipient */
  headers?: Record<string, string>
  /** Tags for this recipient */
  tags?: string[]
  /** Metadata for this recipient */
  metadata?: Record<string, string>
}

/**
 * Domain identifier type preference for drivers
 */
export type DomainIdentifierType = 'domain' | 'domainId' | 'both'

/**
 * Driver capabilities
 */
export interface DriverCapabilities {
  /** Supports email templates */
  templates?: boolean
  /** Supports per-recipient personalizations */
  personalizations?: boolean
  /** Supports scheduled sending */
  scheduling?: boolean
  /** Supports unsubscribe management */
  unsubscribe?: boolean
  /** Supports granular open tracking */
  trackOpens?: boolean
  /** Supports granular click tracking */
  trackClicks?: boolean
  /** Supports sandbox/test mode */
  sandbox?: boolean
  /** Supports idempotency key on send */
  sendIdempotency?: boolean
  /** Supports tenant routing/tagging */
  tenantRouting?: boolean
  /** Supports domain management API */
  domains?: boolean
  /** Domain identifier type preference: 'domain' (requires domain), 'domainId' (requires domainId), or 'both' (accepts either) */
  domainIdentifier?: DomainIdentifierType
}

/**
 * Base email message structure
 * This is the minimal interface that all drivers must support
 */
export interface BaseEmailMessage {
  from: EmailAddress
  to: EmailAddress | EmailAddress[]
  cc?: EmailAddress | EmailAddress[]
  bcc?: EmailAddress | EmailAddress[]
  /**
   * Reply/Thread settings for the outbound email.
   */
  reply?: ReplyContext
  subject: string
  text?: string
  html?: string
  attachments?: Attachment[]
  headers?: Record<string, string>
  tags?: string[]
  metadata?: Record<string, string>
  /** Provider-specific options (escape hatch) */
  provider?: Record<string, unknown>
}

/**
 * Email message with optional features based on driver capabilities
 */
export type EmailMessage<TCapabilities extends DriverCapabilities = DriverCapabilities> =
  BaseEmailMessage &
  (TCapabilities['templates'] extends true
    ? {
        templateId?: string
        templateData?: Record<string, unknown>
      }
    : {}) &
  (TCapabilities['personalizations'] extends true
    ? {
        personalizations?: Personalization[]
      }
    : {}) &
  (TCapabilities['scheduling'] extends true
    ? {
        sendAt?: Date | number
      }
    : {}) &
  (TCapabilities['unsubscribe'] extends true
    ? {
        unsubscribe?: UnsubscribeConfig
      }
    : {}) &
  (TCapabilities['trackOpens'] extends true
    ? {
        track?: TrackConfig
      }
    : TCapabilities['trackClicks'] extends true
      ? {
          track?: TrackConfig
        }
      : {}) &
  (TCapabilities['sandbox'] extends true
    ? {
        sandbox?: boolean
      }
    : {}) &
  (TCapabilities['sendIdempotency'] extends true
    ? {
        /** Prevent duplicate sends on retries */
        idempotencyKey?: string
      }
    : {}) &
  (TCapabilities['tenantRouting'] extends true
    ? {
        /** Your tenant/customer label for routing/observability */
        tenantId?: string
      }
    : {})

/**
 * Result of sending an email
 */
export interface SendEmailResult {
  messageId: string
  provider: string
  /** Request identifier for tracing (if provided by driver) */
  requestId?: string
  /**
   * Provider-specific email identifier (in addition to messageId).
   * This is the provider's internal ID for this email, separate from the RFC Message-ID.
   * Useful for provider-specific operations or tracking.
   */
  providerId?: string
  accepted?: string[]
  rejected?: string[]
}

/**
 * Inbound email event data
 *
 * This is a generic abstraction that works across all email providers.
 * Each driver implementation transforms provider-specific webhook payloads into this format.
 *
 * @example
 * ```ts
 * onInboundEmail: async (event) => {
 *   // Handle attachments (can have content, url, or both)
 *   if (event.attachments) {
 *     for (const attachment of event.attachments) {
 *       const content = await emailkit.attachments.getContent(attachment)
 *       await saveFile(attachment.filename, content)
 *
 *       // Handle inline attachments (referenced in HTML with CID)
 *       if (attachment.isInline && attachment.contentId) {
 *         // Replace cid: references in HTML
 *         event.html = event.html?.replace(
 *           `cid:${attachment.contentId}`,
 *           attachment.url || attachment.content
 *         )
 *       }
 *     }
 *   }
 * }
 * ```
 */
export interface InboundEmailEvent {
  /** Schema version for forward-compat */
  schemaVersion?: '1'
  /** Unique event identifier for dedupe */
  eventId?: string
  /** Unique message identifier from the email provider */
  messageId: string
  /**
   * Provider-specific message identifier (in addition to messageId).
   * This is the provider's internal ID for this message, separate from the RFC Message-ID.
   * Useful for provider-specific operations or tracking.
   */
  providerId?: string
  /** Sender email address */
  from: EmailAddress
  /** Recipient email addresses */
  to: EmailAddress[]
  /** Carbon copy recipients (if available) */
  cc?: EmailAddress[]
  /** Blind carbon copy recipients (if available) */
  bcc?: EmailAddress[]
  /**
   * Thread metadata, mirroring the outbound `reply` shape.
   */
  reply: ReplyContext
  /** Email subject */
  subject: string
  /** Plain text body (if available) */
  text?: string
  /** HTML body (if available) */
  html?: string
  /** Plain text body stripped of quoted content (if provided) */
  strippedText?: string
  /** HTML body stripped of quoted content (if provided) */
  strippedHtml?: string
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
  attachments?: Attachment[]
  /** Email headers as key-value pairs */
  headers: Record<string, string>
  /** Timestamp when the email was received */
  timestamp: Date
  /** Provider-specific raw data (for debugging or advanced use cases) */
  raw?: unknown
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
 * onOutboundEmailDelivered: async (event) => {
 *   console.log(`Email delivered to ${event.recipient}`)
 *   if (event.recipientDomain) {
 *     console.log(`Domain: ${event.recipientDomain}`)
 *   }
 * }
 *
 * onOutboundEmailBounced: async (event) => {
 *   console.log(`Bounce: ${event.reason}`)
 *   if (event.severity === 'permanent') {
 *     // Remove from mailing list
 *   } else if (event.severity === 'temporary') {
 *     // Retry later
 *   }
 * }
 * ```
 */
export interface OutboundEmailEvent {
  /** Schema version for forward-compat */
  schemaVersion?: '1'
  /** Unique event identifier for dedupe */
  eventId?: string
  /** Unique message identifier from the email provider */
  messageId: string
  /**
   * Provider-specific message identifier (in addition to messageId).
   * This is the provider's internal ID for this message, separate from the RFC Message-ID.
   * Useful for provider-specific operations or tracking.
   */
  providerId?: string
  /** Email address of the recipient (always available) */
  recipient: string
  /** Event status/type */
  status:
    | 'sent'
    | 'delivered'
    | 'opened'
    | 'clicked'
    | 'bounced'
    | 'complained'
    | 'rejected'
  /** Timestamp when the event occurred */
  timestamp: Date

  // Common email fields (available in sent/accepted events)
  /** Sender email address (available in sent/accepted events) */
  from?: EmailAddress
  /** Recipient email addresses (available in sent/accepted events) */
  to?: EmailAddress[]
  /** Email subject (available in sent/accepted events) */
  subject?: string

  // Tracking and metadata
  /** Custom metadata/tags associated with the email */
  tags?: string[]
  /** Custom metadata key-value pairs */
  metadata?: Record<string, string>
  /** Campaign or tracking identifier */
  campaignId?: string

  // Delivery information
  /** Domain of the recipient (e.g., "gmail.com") */
  recipientDomain?: string
  /** Receiving server information */
  server?: string

  /** Provider-specific raw data (for debugging or advanced use cases) */
  raw?: unknown
}

/**
 * Webhook request (generic, provider-specific implementations will extend)
 */
export interface WebhookRequest {
  method: string
  headers: Record<string, string>
  body: unknown
  /**
   * Raw body string (before JSON parsing).
   * Required for signature verification in some providers (e.g., AIInbx).
   */
  rawBody?: string
  query?: Record<string, string>
  raw?: unknown
}

/**
 * Webhook response
 */
export interface WebhookResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

/**
 * Standardized webhook event union returned by drivers
 */
export type WebhookEvent =
  | { type: 'inbound'; data: InboundEmailEvent }
  | { type: 'outbound'; data: OutboundEmailEvent }
  | { type: 'delivered'; data: OutboundEmailEvent & { responseTime?: number } }
  | {
      type: 'opened'
      data: OutboundEmailEvent & {
        ip?: string
        userAgent?: string
        timeSinceSendMs?: number
        location?: {
          city?: string
          country?: string
          region?: string
          timezone?: string
        }
        deviceType?: string
        clientType?: string
        os?: string
        botDetection?: { isBot: boolean; reason: string }
      }
    }
  | {
      type: 'clicked'
      data: OutboundEmailEvent & {
        url?: string
        ip?: string
        userAgent?: string
        location?: {
          city?: string
          country?: string
          region?: string
          timezone?: string
        }
        deviceType?: string
        clientType?: string
        os?: string
        botDetection?: { isBot: boolean; reason: string }
      }
    }
  | {
      type: 'bounced'
      data: OutboundEmailEvent & {
        reason?: string
        severity?: 'permanent' | 'temporary'
        code?: string | number
        smtpResponse?: string
      }
    }
  | {
      type: 'complained'
      data: OutboundEmailEvent & {
        feedbackType?: string
        feedback?: string
        source?: string
      }
    }
  | {
      type: 'rejected'
      data: OutboundEmailEvent & {
        reason?: string
        code?: string | number
        smtpResponse?: string
        category?: string
      }
    }
  | { type: 'unknown'; data: unknown }

/**
 * Hook function types
 */
export type InboundEmailHook = (event: InboundEmailEvent) => Promise<void>
export type OutboundEmailHook = (event: OutboundEmailEvent) => Promise<void>
/**
 * Hook for delivered email events
 */
export type OutboundEmailDeliveredHook = (
  event: OutboundEmailEvent & {
    /** Response time in milliseconds (if available) */
    responseTime?: number
  },
) => Promise<void>

/**
 * Hook for email opened events
 */
export type OutboundEmailOpenedHook = (
  event: OutboundEmailEvent & {
    /** IP address of the user who opened the email */
    ip?: string
    /** User agent string of the browser/client */
    userAgent?: string
    /** Milliseconds since send (or delivery), if available */
    timeSinceSendMs?: number
    /** Geolocation information */
    location?: {
      /** City name */
      city?: string
      /** Country code or name */
      country?: string
      /** Region/state */
      region?: string
      /** Timezone */
      timezone?: string
    }
    /** Device type (mobile, desktop, tablet, etc.) */
    deviceType?: string
    /** Email client name (Gmail, Outlook, etc.) */
    clientType?: string
    /** Operating system */
    os?: string
    /** Bot detection result */
    botDetection?: {
      /** Whether this is detected as a bot */
      isBot: boolean
      /** Reason for the bot detection decision */
      reason: string
    }
  },
) => Promise<void>

/**
 * Hook for email link clicked events
 */
export type OutboundEmailClickedHook = (
  event: OutboundEmailEvent & {
    /** URL that was clicked */
    url?: string
    /** IP address of the user who clicked */
    ip?: string
    /** User agent string of the browser/client */
    userAgent?: string
    /** Geolocation information */
    location?: {
      /** City name */
      city?: string
      /** Country code or name */
      country?: string
      /** Region/state */
      region?: string
      /** Timezone */
      timezone?: string
    }
    /** Device type (mobile, desktop, tablet, etc.) */
    deviceType?: string
    /** Email client name (Gmail, Outlook, etc.) */
    clientType?: string
    /** Operating system */
    os?: string
    /** Bot detection result */
    botDetection?: {
      /** Whether this is detected as a bot */
      isBot: boolean
      /** Reason for the bot detection decision */
      reason: string
    }
  },
) => Promise<void>

/**
 * Hook for bounced email events
 */
export type OutboundEmailBouncedHook = (
  event: OutboundEmailEvent & {
    /** Human-readable bounce reason/message */
    reason?: string
    /** Bounce severity: permanent (hard bounce) or temporary (soft bounce) */
    severity?: 'permanent' | 'temporary'
    /** Error code from the email provider */
    code?: string | number
    /** SMTP response code and message */
    smtpResponse?: string
    /** Bounce category/type */
    category?: string
  },
) => Promise<void>

/**
 * Hook for spam complaint events
 */
export type OutboundEmailComplainedHook = (
  event: OutboundEmailEvent & {
    /** Type of complaint (spam, abuse, etc.) */
    feedbackType?: string
    /** Feedback loop message */
    feedback?: string
    /** Complaint source (ESP, ISP, etc.) */
    source?: string
  },
) => Promise<void>

/**
 * Hook for rejected email events
 */
export type OutboundEmailRejectedHook = (
  event: OutboundEmailEvent & {
    /** Human-readable rejection reason */
    reason?: string
    /** Error code from the email provider */
    code?: string | number
    /** SMTP response code and message */
    smtpResponse?: string
    /** Rejection category/type */
    category?: string
  },
) => Promise<void>

/**
 * Hook for unknown/unrecognized events
 */
export type UnknownEventHook = (event: {
  type: 'unknown'
  data: unknown
  raw?: unknown
}) => Promise<void>

/**
 * Hook that receives all events (runs before specific hooks)
 */
export type AllEventsHook = (event: {
  type:
    | 'inbound'
    | 'outbound'
    | 'delivered'
    | 'opened'
    | 'clicked'
    | 'bounced'
    | 'complained'
    | 'rejected'
    | 'unknown'
  data: unknown
  raw?: unknown
}) => Promise<void>

/**
 * Hooks configuration
 */
export interface EmailKitHooks {
  onInboundEmail?: InboundEmailHook
  onOutboundEmail?: OutboundEmailHook
  onOutboundEmailDelivered?: OutboundEmailDeliveredHook
  onOutboundEmailOpened?: OutboundEmailOpenedHook
  onOutboundEmailClicked?: OutboundEmailClickedHook
  onOutboundEmailBounced?: OutboundEmailBouncedHook
  onOutboundEmailComplained?: OutboundEmailComplainedHook
  onOutboundEmailRejected?: OutboundEmailRejectedHook
  onUnknownEvent?: UnknownEventHook
  onAllEvents?: AllEventsHook
}

/**
 * Domain & DNS Management Types (unified across providers)
 */

/**
 * DNS record types we commonly encounter for email sending
 * Extended with A/AAAA for potential tracking/click domains
 */
export type DNSRecordType = 'TXT' | 'CNAME' | 'MX' | 'A' | 'AAAA'

/**
 * Purpose/category of a DNS record in email domain setup
 */
export type DomainRecordPurpose =
  | 'spf'
  | 'dkim'
  | 'dmarc'
  | 'mx'
  | 'returnPath'
  | 'tracking'
  | 'custom'

/**
 * High-level domain verification status
 */
export type DomainStatus =
  | 'unverified'
  | 'pending'
  | 'verified'
  | 'disabled'
  | 'unknown'

/**
 * Normalized DNS record definition for domain verification
 */
export interface DomainDNSRecord {
  /** DNS record type */
  type: DNSRecordType
  /** Host/name for the record (relative like "_dmarc" or FQDN) */
  name: string
  /** Record value (TXT content, CNAME target, MX host, etc.) */
  value: string
  /** TTL in seconds or 'auto' when provider returns automatic TTL */
  ttl?: number | 'auto'
  /** MX priority if applicable */
  priority?: number
  /** Purpose of this record within email setup */
  purpose?: DomainRecordPurpose
  /** Whether the provider reports this record as verified/present */
  verified?: boolean
  /** Last time the provider checked this record */
  lastCheckedAt?: Date
}

/**
 * Verification state and instructions for a domain
 */
export interface DomainVerification {
  /** Overall verification status for the domain */
  status: DomainStatus
  /** Required and relevant DNS records */
  records: DomainDNSRecord[]
  /** When the verification state was last checked */
  checkedAt?: Date
  /** When to check again (if provider hints) */
  nextCheckAfter?: Date
  /** Provider-specific raw data (for debugging or advanced use cases) */
  raw?: unknown
}

/**
 * Unified domain object
 */
export interface Domain {
  /** Provider identifier if available; falls back to name */
  id: string
  /** The domain name (e.g., example.com) */
  name: string
  /** Current provider-reported status */
  status: DomainStatus
  /** Optional sending region (e.g., us-east-1) */
  region?: string
  /** Timestamps if the provider exposes them */
  createdAt?: Date
  updatedAt?: Date
  /** DKIM selector if explicit/known */
  dkimSelector?: string
  /** Return-Path subdomain (a.k.a. mail-from/bounce) */
  returnPathSubdomain?: string
  /** Verification data including required DNS records */
  verification?: DomainVerification
  /** Provider-specific raw data (for debugging or advanced use cases) */
  raw?: unknown
}

/**
 * List domains filter/pagination
 */
export interface ListDomainsOptions {
  /** Filter by verification status */
  status?: Extract<DomainStatus, 'verified' | 'unverified' | 'pending'>
  /** Page index (1-based unless provider defines otherwise) */
  page?: number
  /** Page size */
  pageSize?: number
  /** Number of results to retrieve (provider-specific pagination) */
  limit?: number
  /** Provider-specific filters */
  provider?: Record<string, unknown>
}

/**
 * Create a new sending domain
 */
export interface CreateDomainInput {
  /** Domain name to create (e.g., example.com) */
  name: string
  /** Explicit DKIM selector if supported */
  dkimSelector?: string
  /** Custom Return-Path subdomain (e.g., send, bounce) */
  returnPathSubdomain?: string
  /** Sending region if the provider supports it (e.g., us-east-1) */
  region?: string
  /** Tracking defaults at domain level if supported */
  tracking?: { opens?: boolean; clicks?: boolean }
  /** Provider-specific creation options */
  provider?: Record<string, unknown>
}

/**
 * Update mutable domain settings
 */
export interface UpdateDomainInput {
  /** Update tracking defaults (if provider supports it) */
  tracking?: { opens?: boolean; clicks?: boolean }
  /** Change DKIM selector (regenerate or switch if supported) */
  dkimSelector?: string
  /** Change Return-Path subdomain if supported */
  returnPathSubdomain?: string
  /** Provider-specific update options */
  provider?: Record<string, unknown>
}

/**
 * Result for delete/remove domain operations
 */
export interface DomainDeleteResult {
  deleted: boolean
}

/**
 * Result of an idempotent domain provisioning call.
 */
export interface DomainEnsureResult {
  domain: Domain
  created: boolean
}

/**
 * Domain identifier for domain operations.
 * The exact shape depends on the driver's domainIdentifier capability:
 * - 'domain': requires domain, domainId is optional
 * - 'domainId': requires domainId, domain is optional
 * - 'both' or undefined: requires at least one of domain or domainId
 */
export type DomainIdentifier<TIdentifierType extends DomainIdentifierType = 'both'> =
  TIdentifierType extends 'domain'
    ? { domain: string; domainId?: string }
    : TIdentifierType extends 'domainId'
      ? { domain?: string; domainId: string }
      : { domain?: string; domainId?: string } & (
          | { domain: string }
          | { domainId: string }
          | { domain: string; domainId: string }
        )

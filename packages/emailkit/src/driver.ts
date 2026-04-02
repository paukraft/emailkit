/**
 * Base driver interface that all email providers must implement
 *
 * This abstraction allows the SDK to work with any email provider.
 * Each provider implements this interface to transform their specific API/webhook
 * formats into the standardized SDK format.
 *
 * @example Creating a new driver
 * ```ts
 * import type { EmailDriver, EmailDriverConfig } from '@/lib/mr-email'
 * import type { InboundEmailEvent, OutboundEmailEvent } from '@/lib/mr-email/types'
 *
 * interface MyProviderConfig extends EmailDriverConfig {
 *   apiKey: string
 *   webhookSecret?: string
 * }
 *
 * export const MyProviderDriver = (config: MyProviderConfig): EmailDriver<MyProviderConfig> => {
 *   return {
 *     name: 'my-provider',
 *
 *     async sendEmail(message) {
 *       // Transform EmailMessage to provider format and send
 *       const response = await fetch('https://api.myprovider.com/send', {
 *         method: 'POST',
 *         headers: { 'Authorization': `Bearer ${config.apiKey}` },
 *         body: JSON.stringify({
 *           to: message.to,
 *           subject: message.subject,
 *           // Optional, only if your driver sets capabilities.tenantRouting = true
 *           tenantId: (message as any).tenantId,
 *           // Optional, only if your driver sets capabilities.sendIdempotency = true
 *           idempotencyKey: (message as any).idempotencyKey,
 *         }),
 *       })
 *       return { messageId: response.id, provider: 'my-provider' }
 *     },
 *
 *     async handleWebhook(request) {
 *       // Parse provider-specific webhook payload
 *       const payload = request.body as MyProviderWebhookPayload
 *
 *       // Detect event type and transform to InboundEmailEvent
 *       if (payload.type === 'inbound') {
 *         const event: InboundEmailEvent = {
 *           schemaVersion: '1',
 *           eventId: payload.eventId,
 *           messageId: payload.messageId,
 *           from: { email: payload.from },
 *           to: [{ email: payload.to }],
 *           subject: payload.subject,
 *           text: payload.text,
 *           html: payload.html,
 *           attachments: payload.attachments?.map(att => ({
 *             filename: att.name,
 *             content: base64ToBytes(att.data), // Uint8Array
 *             contentType: att.type,
 *           })),
 *           headers: payload.headers,
 *           timestamp: new Date(payload.timestamp),
 *           raw: payload,
 *         }
 *         return { type: 'inbound', data: event }
 *       }
 *
 *       // Handle outbound events...
 *       return { type: 'unknown', data: payload }
 *     },
 *
 *     async verifyWebhook(request) {
 *       // Implement provider-specific signature verification
 *       const signature = request.headers['x-signature']
 *       const expected = computeSignature(request.body, config.webhookSecret)
 *       return signature === expected
 *     },
 *   }
 * }
 * ```
 */

import type {
  DriverCapabilities,
  EmailMessage,
  SendEmailResult,
  WebhookEvent,
  WebhookRequest,
  WebhookResponse,
} from "./types";
import type {
  CreateDomainInput,
  Domain,
  DomainDeleteResult,
  DomainVerification,
  ListDomainsOptions,
  UpdateDomainInput,
} from "./types";

/**
 * Configuration options for email drivers
 * Each driver can extend this with provider-specific options
 */
export interface EmailDriverConfig {
  [key: string]: unknown;
}

/**
 * Value type supported for provider fetch search parameters.
 */
export type ProviderFetchParamValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean | null | undefined>;

/**
 * Search parameters supported by provider fetch helper.
 */
export type ProviderFetchSearchParams =
  | Record<string, ProviderFetchParamValue>
  | URLSearchParams;

/**
 * Extended RequestInit supported by providerFetch.
 */
export interface ProviderFetchInit extends RequestInit {
  searchParams?: ProviderFetchSearchParams;
}

/**
 * Provider-aware fetch helper signature.
 */
export type ProviderFetch = (
  path: string | URL,
  init?: ProviderFetchInit,
) => Promise<Response>;

/**
 * Base driver interface that all email providers must implement
 */
export interface EmailDriver<
  TConfig extends EmailDriverConfig = EmailDriverConfig,
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> {
  /**
   * Driver name/identifier
   */
  name: string;

  /**
   * Capabilities this driver supports
   */
  capabilities: TCapabilities;

  /**
   * Send an email using this driver
   * Type-safe: only accepts EmailMessage with features this driver supports
   */
  sendEmail: (
    message: EmailMessage<TCapabilities>,
    options?: { signal?: AbortSignal }
  ) => Promise<SendEmailResult>;

  /**
   * Handle incoming webhook from the email provider
   *
   * This method should:
   * 1. Parse the provider-specific webhook payload
   * 2. Transform it into a standardized event format
   * 3. Return the event type and normalized data
   *
   * For inbound emails, the `data` should be an `InboundEmailEvent`.
   * For outbound events, the `data` should be an `OutboundEmailEvent` or compatible structure.
   *
   * @param request - The webhook request containing provider-specific payload
   * @returns Event type and normalized data matching the SDK's event types
   */
  handleWebhook: (request: WebhookRequest) => Promise<WebhookEvent>;

  /**
   * Verify webhook signature/authenticity
   */
  verifyWebhook?: (request: WebhookRequest) => Promise<boolean>;

  /**
   * Generate webhook response (if needed)
   */
  webhookResponse?: (
    request: WebhookRequest,
    handled: boolean
  ) => Promise<WebhookResponse>;

  /**
   * Optional domains management API.
   * Implement methods your provider supports; unsupported methods can be omitted.
   */
  domains?: Partial<DriverDomainsAPI>;

  /**
   * Optional provider-aware fetch helper.
   * Allows consumers to call provider-specific endpoints with auth and base URL applied.
   */
  providerFetch?: ProviderFetch;
}

/**
 * Type helper to extract driver config type
 */
export type DriverConfig<TDriver extends EmailDriver> =
  TDriver extends EmailDriver<infer TConfig, any> ? TConfig : never;

/**
 * Type helper to extract driver capabilities type
 */
export type DriverCapabilitiesType<TDriver extends EmailDriver> =
  TDriver extends EmailDriver<any, infer TCapabilities>
    ? TCapabilities
    : DriverCapabilities;

/**
 * Standardized domain management operations a driver may implement
 */
export interface DriverDomainsAPI {
  /** List domains */
  list: (opts?: ListDomainsOptions) => Promise<Domain[]>;
  /** Create a domain */
  create: (input: CreateDomainInput) => Promise<Domain>;
  /** Get domain by provider id or name */
  get: (idOrName: string) => Promise<Domain>;
  /** Update mutable domain properties */
  update: (idOrName: string, patch: UpdateDomainInput) => Promise<Domain>;
  /** Trigger or check verification, returning required DNS records */
  verify: (idOrName: string) => Promise<DomainVerification>;
  /** Delete a domain */
  delete: (idOrName: string) => Promise<DomainDeleteResult>;
}

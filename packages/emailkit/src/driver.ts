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
 * interface MyProviderConfig<TId extends string = 'my-provider'> extends EmailDriverConfig {
 *   id?: TId
 *   apiKey: string
 *   webhookSecret?: string
 * }
 *
 * export const MyProviderDriver = <const TId extends string = 'my-provider'>(
 *   config: MyProviderConfig<TId>
 * ): EmailDriver<MyProviderConfig<TId>, DriverCapabilities, TId> => {
 *   return {
 *     id: (config.id || 'my-provider') as TId,
 *     name: 'my-provider',
 *     capabilities: {},
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
  DriverPublicRoutes,
  Mailbox,
  MailboxIdentity,
  MailboxConnectionResult,
  MailboxDeleteResult,
  ConnectMailboxInput,
  CreateMailboxInput,
  ListMailboxesOptions,
  AccountWebhookDeleteInput,
  AccountWebhookDeleteResult,
  AccountWebhookRefreshInput,
  AccountWebhookRefreshResult,
  AccountWebhookSetupInput,
  AccountWebhookSetupResult,
  DomainWebhookDeleteInput,
  DomainWebhookDeleteResult,
  DomainWebhookRefreshInput,
  DomainWebhookRefreshResult,
  DomainWebhookSetupInput,
  DomainWebhookSetupResult,
  MailboxWebhookDeleteInput,
  MailboxWebhookDeleteResult,
  MailboxWebhookRefreshInput,
  MailboxWebhookRefreshResult,
  MailboxWebhookSetupInput,
  MailboxWebhookSetupResult,
  SendEmailResult,
  WebhookEventResult,
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
  provider?: Record<string, unknown>;
}

/**
 * Provider-aware fetch helper signature.
 */
export type ProviderFetch = (
  path: string | URL,
  init?: ProviderFetchInit,
) => Promise<Response>;

export interface DriverAuthUpdate {
  auth: unknown;
  mailbox?: MailboxIdentity | Mailbox;
  context?: unknown;
  raw?: unknown;
  previousAuth?: unknown;
}

export interface EmailDriverOperationOptions<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> {
  secret?: string;
  mailbox?: MailboxIdentity | Mailbox;
  auth?: unknown;
  context?: unknown;
  publicRoutes?: DriverPublicRoutes<TCapabilities>;
  onAuthUpdated?: (event: DriverAuthUpdate) => Promise<void>;
}

export interface SendEmailOptions<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> extends EmailDriverOperationOptions<TCapabilities> {
  signal?: AbortSignal;
}

export type DriverCallbackResult = WebhookResponse | MailboxConnectionResult;

/**
 * Base driver interface that all email providers must implement
 */
export interface EmailDriver<
  TConfig extends EmailDriverConfig = EmailDriverConfig,
  TCapabilities extends DriverCapabilities = DriverCapabilities,
  TId extends string = string,
> {
  /**
   * Required literal driver identifier used for typed EmailKit facades.
   */
  id: TId;

  /**
   * Legacy internal/provider label. New public routing should use `id`.
   */
  name?: string;

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
    options?: SendEmailOptions<TCapabilities>,
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
  handleWebhook: (request: WebhookRequest) => Promise<WebhookEventResult>;

  /**
   * Verify webhook signature/authenticity
   */
  verifyWebhook?: (request: WebhookRequest) => Promise<boolean>;

  /**
   * Generate webhook response (if needed)
   */
  webhookResponse?: (
    request: WebhookRequest,
    handled: boolean,
  ) => Promise<WebhookResponse>;

  /**
   * Optional domains management API.
   * Implement methods your provider supports; unsupported methods can be omitted.
   */
  domains?: Partial<DriverDomainsAPI>;

  /**
   * Optional mailbox management/auth API.
   * Implement methods your provider supports; unsupported methods can be omitted.
   */
  mailboxes?: Partial<DriverMailboxesAPI<TCapabilities>>;

  /**
   * Optional webhook management API grouped by normalized scope.
   * Implement methods your provider supports; unsupported methods can be omitted.
   */
  webhooks?: Partial<DriverWebhooksAPI<TCapabilities>>;

  /**
   * Optional OAuth/callback handler for GET requests routed through `handler()`.
   */
  handleCallback?: (
    request: WebhookRequest,
    options?: EmailDriverOperationOptions<TCapabilities>,
  ) => Promise<DriverCallbackResult>;

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
  TDriver extends EmailDriver<infer TConfig, any, any> ? TConfig : never;

/**
 * Type helper to extract driver capabilities type
 */
export type DriverCapabilitiesType<TDriver extends EmailDriver> =
  TDriver extends {
    capabilities: infer TCapabilities extends DriverCapabilities;
  }
    ? TCapabilities
    : DriverCapabilities;

/**
 * Type helper to extract driver id.
 */
export type DriverId<TDriver extends EmailDriver> = TDriver extends {
  id: infer TId extends string;
}
  ? TId
  : string;

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

/**
 * Standardized mailbox operations a driver may implement.
 */
export interface DriverMailboxesAPI<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> {
  connect: (
    input: ConnectMailboxInput<TCapabilities>,
    options?: EmailDriverOperationOptions<TCapabilities>,
  ) => Promise<MailboxConnectionResult>;
  create: (
    input: CreateMailboxInput,
    options?: EmailDriverOperationOptions<TCapabilities>,
  ) => Promise<Mailbox>;
  list: (
    opts?: ListMailboxesOptions,
    options?: EmailDriverOperationOptions<TCapabilities>,
  ) => Promise<Mailbox[]>;
  get: (
    idOrEmail: string,
    options?: EmailDriverOperationOptions<TCapabilities>,
  ) => Promise<Mailbox>;
  delete: (
    idOrEmail: string,
    options?: EmailDriverOperationOptions<TCapabilities>,
  ) => Promise<MailboxDeleteResult>;
}

export interface DriverWebhookScopeAPI<
  TCapabilities extends DriverCapabilities,
  TSetupInput,
  TRefreshInput,
  TDeleteInput,
  TSetupResult,
  TRefreshResult,
  TDeleteResult,
> {
  setup: (
    input: TSetupInput,
    options?: EmailDriverOperationOptions<TCapabilities>,
  ) => Promise<TSetupResult>;
  refresh: (
    input: TRefreshInput,
    options?: EmailDriverOperationOptions<TCapabilities>,
  ) => Promise<TRefreshResult>;
  delete: (
    input: TDeleteInput,
    options?: EmailDriverOperationOptions<TCapabilities>,
  ) => Promise<TDeleteResult>;
}

export type DriverAccountWebhooksAPI<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> = DriverWebhookScopeAPI<
  TCapabilities,
  AccountWebhookSetupInput,
  AccountWebhookRefreshInput,
  AccountWebhookDeleteInput,
  AccountWebhookSetupResult,
  AccountWebhookRefreshResult,
  AccountWebhookDeleteResult
>;

export type DriverMailboxWebhooksAPI<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> = DriverWebhookScopeAPI<
  TCapabilities,
  MailboxWebhookSetupInput,
  MailboxWebhookRefreshInput,
  MailboxWebhookDeleteInput,
  MailboxWebhookSetupResult,
  MailboxWebhookRefreshResult,
  MailboxWebhookDeleteResult
>;

export type DriverDomainWebhooksAPI<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> = DriverWebhookScopeAPI<
  TCapabilities,
  DomainWebhookSetupInput,
  DomainWebhookRefreshInput,
  DomainWebhookDeleteInput,
  DomainWebhookSetupResult,
  DomainWebhookRefreshResult,
  DomainWebhookDeleteResult
>;

/**
 * Standardized webhook management operations a driver may implement.
 */
export interface DriverWebhooksAPI<
  TCapabilities extends DriverCapabilities = DriverCapabilities,
> {
  account: Partial<DriverAccountWebhooksAPI<TCapabilities>>;
  mailbox: Partial<DriverMailboxWebhooksAPI<TCapabilities>>;
  domain: Partial<DriverDomainWebhooksAPI<TCapabilities>>;
}

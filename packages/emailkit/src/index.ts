/**
 * EmailKit - Unified Email SDK
 *
 * A unified API for working with different email providers,
 * similar to the AI SDK pattern but for email services.
 *
 * @example
 * ```ts
 * import { EmailKit, MailgunDriver } from 'emailkit'
 *
 * const emailkit = EmailKit({
 *   emailDrivers: [MailgunDriver({
 *     apiKey: process.env.MAILGUN_API_KEY!,
 *   })],
 *   hooks: {
 *     email: {
 *       onInbound: async (event) => {
 *         console.log('Received email:', event.subject)
 *       },
 *     },
 *   },
 * })
 *
 * // Send an email
 * await emailkit.sendEmail({
 *   from: { email: 'sender@example.com', name: 'Sender' },
 *   to: { email: 'recipient@example.com' },
 *   subject: 'Hello',
 *   text: 'Hello world!',
 * })
 * ```
 */

import {
  createEmailKitClient,
  type EmailDriverTuple,
  type EmailKitClient,
  type EmailKitConfig,
} from "./client";

/**
 * Create an EmailKit client instance
 *
 * @param config - Configuration including email drivers and hooks
 * @returns EmailKit client instance with type-safe sendEmail based on driver capabilities
 */
export const EmailKit = <const TDrivers extends EmailDriverTuple>(
  config: EmailKitConfig<TDrivers>,
): EmailKitClient<TDrivers> => {
  return createEmailKitClient(config);
};

// Export types
export type {
  AllEventsHook,
  AccountSyncInput,
  AccountWebhookDeleteInput,
  AccountWebhookDeleteResult,
  AccountWebhookRefreshInput,
  AccountWebhookRefreshResult,
  AccountWebhookSetupInput,
  AccountWebhookSetupResult,
  Attachment,
  BaseEmailMessage,
  CreateDomainInput,
  DNSRecordType,
  Domain,
  DomainDeleteResult,
  DomainEnsureResult,
  DomainDNSRecord,
  DomainIdentifier,
  DomainIdentifierType,
  DomainOperationInput,
  DomainStatus,
  DomainSyncInput,
  DomainVerification,
  DomainWebhookDeleteInput,
  DomainWebhookDeleteResult,
  DomainWebhookRefreshInput,
  DomainWebhookRefreshResult,
  DomainWebhookSetupInput,
  DomainWebhookSetupResult,
  DriverCapabilities,
  DriverDomainCapabilities,
  DriverEventTrackingCapabilities,
  DriverPublicRoutes,
  DriverPublicRouteCapabilities,
  DriverSendTrackingCapabilities,
  DriverSyncCapabilities,
  DriverWebhookCapabilities,
  EmailTag,
  EmailDriverSelector,
  EmailAddress,
  EmailKitHooks,
  EmailMessage,
  EmailSenderOverride,
  ReplyContext,
  InboundEmailEvent,
  InboundEmailHook,
  ListDomainsOptions,
  ListMailboxesOptions,
  Mailbox,
  MailboxConnectedHookEvent,
  MailboxAuthUpdatedHookEvent,
  MailboxConnectionResult,
  MailboxDeleteResult,
  MailboxSyncInput,
  MailboxWebhookDeleteInput,
  MailboxWebhookDeleteResult,
  MailboxWebhookRefreshInput,
  MailboxWebhookRefreshResult,
  MailboxWebhookSetupInput,
  MailboxWebhookSetupResult,
  MailboxHookEvent,
  HookResult,
  MaybePromise,
  MailboxIdentity,
  ConnectMailboxInput,
  CreateMailboxInput,
  DomainHookEvent,
  EmailHookEvent,
  OutboundEmailBouncedHook,
  OutboundEmailClickedHook,
  OutboundEmailComplainedHook,
  OutboundEmailDeliveredHook,
  OutboundEmailEvent,
  OutboundEmailHook,
  OutboundEmailOpenedHook,
  OutboundEmailRejectedHook,
  Personalization,
  PublicRouteDriverConfig,
  PublicRouteGroup,
  PublicRoutesConfig,
  PublicRouteTemplate,
  SendEmailResult,
  SyncInput,
  SyncResult,
  TrackConfig,
  UnknownEventHook,
  UnsubscribeConfig,
  UpdateDomainInput,
  Webhook,
  WebhookDriverEvent,
  WebhookEvent,
  WebhookEventSelection,
  WebhookEventType,
  WebhookLifecycleDriverEvent,
  WebhookInboundOptions,
  WebhookLifecycleAction,
  WebhookLifecycleEvent,
  WebhookLifecycleEventBase,
  WebhookLifecycleHookEvent,
  WebhookLifecycleReason,
  WebhookLifecycleSource,
  WebhookLifecycleTarget,
  WebhookRecommendedAction,
  WebhookReference,
  WebhookRequest,
  WebhookResponse,
  WebhookScope,
  WebhookSetupInput,
  WebhookSetupResult,
  WebhookRefreshInput,
  WebhookRefreshResult,
  WebhookDeleteInput,
  WebhookDeleteResult,
  WebhookStatus,
} from "./types";

export type {
  DriverAccountWebhooksAPI,
  DriverCapabilitiesType,
  DriverAuthUpdate,
  DriverConfig,
  DriverCallbackResult,
  DriverDomainWebhooksAPI,
  DriverDomainsAPI,
  EmailDriverOperationOptions,
  DriverId,
  DriverMailboxesAPI,
  DriverMailboxWebhooksAPI,
  DriverSyncAPI,
  DriverWebhookScopeAPI,
  DriverWebhooksAPI,
  EmailDriver,
  EmailDriverConfig,
  ProviderFetch,
  ProviderFetchInit,
  ProviderFetchParamValue,
  ProviderFetchSearchParams,
  SendEmailOptions,
  SyncStream,
} from "./driver";

export type {
  AccountWebhooksFacade,
  AttachmentsFacade,
  DomainWebhooksFacade,
  DomainsFacade,
  EmailDriverTuple,
  EmailKitClient,
  EmailKitConfig,
  EmailDriverSelection,
  MailboxWebhooksFacade,
  MailboxesFacade,
  ProviderFetchFacade,
  ResolveEmailDriver,
  ResolveEmailDriverContext,
  SendEmailMessage,
} from "./client";

export { EmailKitError, EmailKitSyncError } from "./types";

// Export package version constant (keep in sync with package.json)
export const VERSION = "2.0.1";

// Export drivers
export {
  MAILGUN_CAPABILITIES,
  MAILGUN_ENDPOINTS,
  MailgunDriver,
} from "./drivers/mailgun";
export type {
  InboundAttachmentHandling,
  MailgunCapabilities,
  MailgunDriverConfig,
} from "./drivers/mailgun";

export { AIINBX_CAPABILITIES, AIInbxDriver } from "./drivers/aiinbx";
export type { AIInbxCapabilities, AIInbxDriverConfig } from "./drivers/aiinbx";

export { RESEND_CAPABILITIES, ResendDriver } from "./drivers/resend";
export type { ResendCapabilities, ResendDriverConfig } from "./drivers/resend";

export {
  OUTLOOK_CAPABILITIES,
  OUTLOOK_DRAFT_CAPABILITIES,
  OutlookDriver,
} from "./drivers/outlook";
export type {
  OutlookCapabilities,
  OutlookCapabilitiesForSendMode,
  OutlookDraftCapabilities,
  OutlookDriverConfig,
  OutlookMailboxAuth,
  OutlookSendEmailMode,
  OutlookSendEmailResult,
} from "./drivers/outlook";

// Export Next.js helpers
// Next.js helpers are available under the optional subpath: `emailkit/nextjs`

// Export bot detection utilities
export {
  checkClickBot,
  checkOpenBot,
  classifyClick,
  classifyOpen,
  CLICK_REASONS,
  OPEN_REASONS,
} from "./bot-detect";
export type { ClickReason, OpenReason } from "./bot-detect";

export { createProviderFetch } from "./utils/provider-fetch";
export type {
  CreateProviderFetchOptions,
  HeadersSource as ProviderFetchHeadersSource,
} from "./utils/provider-fetch";

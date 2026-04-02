/**
 * EmailKit - Unified Email SDK
 *
 * A unified API for working with different email providers,
 * similar to the AI SDK pattern but for email services.
 *
 * @example
 * ```ts
 * import { EmailKit } from 'emailkit'
 * import { MailgunDriver } from 'emailkit/drivers/mailgun'
 *
 * const emailkit = EmailKit({
 *   emailDriver: MailgunDriver({
 *     apiKey: process.env.MAILGUN_API_KEY!,
 *   }),
 *   hooks: {
 *     onInboundEmail: async (event) => {
 *       console.log('Received email:', event.subject)
 *     },
 *     onOutboundEmailDelivered: async (event) => {
 *       console.log('Email delivered:', event.messageId)
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

import { createEmailKitClient, type EmailKitClient } from "./client";
import type { EmailDriver } from "./driver";
import type { EmailKitHooks } from "./types";

/**
 * Create an EmailKit client instance
 *
 * @param config - Configuration including email driver and hooks
 * @returns EmailKit client instance with type-safe sendEmail based on driver capabilities
 */
export const EmailKit = <TDriver extends EmailDriver>(config: {
  emailDriver: TDriver;
  hooks?: EmailKitHooks;
}): EmailKitClient<TDriver> => {
  return createEmailKitClient(config);
};

// Export types
export type {
  AllEventsHook,
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
  DomainStatus,
  DomainVerification,
  DriverCapabilities,
  EmailAddress,
  EmailKitHooks,
  EmailMessage,
  ReplyContext,
  InboundEmailEvent,
  InboundEmailHook,
  ListDomainsOptions,
  OutboundEmailBouncedHook,
  OutboundEmailClickedHook,
  OutboundEmailComplainedHook,
  OutboundEmailDeliveredHook,
  OutboundEmailEvent,
  OutboundEmailHook,
  OutboundEmailOpenedHook,
  OutboundEmailRejectedHook,
  Personalization,
  SendEmailResult,
  TrackConfig,
  UnknownEventHook,
  UnsubscribeConfig,
  UpdateDomainInput,
  WebhookEvent,
  WebhookRequest,
  WebhookResponse,
} from "./types";

export type {
  DriverCapabilitiesType,
  DriverConfig,
  DriverDomainsAPI,
  EmailDriver,
  EmailDriverConfig,
  ProviderFetch,
  ProviderFetchInit,
  ProviderFetchParamValue,
  ProviderFetchSearchParams,
} from "./driver";

export type {
  AttachmentsFacade,
  DomainsFacade,
  EmailKitClient,
  EmailKitConfig,
} from "./client";

export { EmailKitError } from "./types";

// Export package version constant (keep in sync with package.json)
export const VERSION = "0.2.0";

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

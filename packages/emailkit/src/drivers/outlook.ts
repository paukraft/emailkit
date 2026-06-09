/**
 * Outlook/Microsoft Graph email driver.
 *
 * Implements delegated mailbox OAuth and sendMail through Microsoft Graph.
 * Documentation:
 * - https://learn.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-auth-code-flow
 * - https://learn.microsoft.com/graph/api/user-sendmail
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import type {
  EmailDriver,
  EmailDriverConfig,
  EmailDriverOperationOptions,
  ProviderFetchInit,
  SendEmailOptions,
} from "../driver";
import type {
  Attachment,
  DriverCapabilities,
  EmailAddress,
  EmailMessage,
  InboundEmailEvent,
  Mailbox,
  MailboxConnectionResult,
  MailboxWebhookDeleteInput,
  MailboxWebhookDeleteResult,
  MailboxWebhookRefreshInput,
  MailboxWebhookRefreshResult,
  MailboxWebhookSetupInput,
  MailboxWebhookSetupResult,
  SendEmailResult,
  Webhook,
  WebhookEvent,
  WebhookEventResult,
  WebhookLifecycleDriverEvent,
  WebhookRecommendedAction,
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

export interface OutlookDriverConfig<TId extends string = "outlook">
  extends EmailDriverConfig {
  /**
   * EmailKit driver id. Override when configuring multiple Outlook drivers.
   */
  id?: TId;
  clientId: string;
  clientSecret: string;
  /**
   * Microsoft Entra tenant segment. Common values: "common", "organizations",
   * "consumers", or a tenant id/domain.
   */
  tenant?: string;
  scopes?: string[];
  /**
   * Optional Microsoft identity base URL.
   * Defaults to https://login.microsoftonline.com.
   */
  authBase?: string;
  /**
   * Optional Microsoft Graph base URL.
   * Defaults to https://graph.microsoft.com/v1.0.
   */
  graphBase?: string;
  /**
   * How outbound messages are submitted to Microsoft Graph.
   *
   * - "sendMail" (default): requires Mail.Send and returns Graph's request id
   *   as a send receipt because Graph returns 202 with no message object.
   * - "draft": creates a draft with immutable ids, sends it, and returns the
   *   Graph message id. This requires Mail.ReadWrite in addition to Mail.Send.
   */
  sendEmailMode?: OutlookSendEmailMode;
  /**
   * Create a Microsoft Graph inbound-message subscription immediately after a
   * mailbox is connected. The created subscription is returned on mailbox.raw
   * as `inboundSubscription`. Defaults to false.
   */
  autoSubscribeInbound?: boolean;
  /**
   * Automatically renew Microsoft Graph mailbox subscriptions when Graph sends
   * a lifecycle reauthorizationRequired notification. Requires webhookAuth or
   * webhookAuthResolver so the driver can authenticate the renewal request.
   * When enabled, new subscriptions default lifecycleNotificationUrl to the
   * normal inbound notification URL unless explicitly configured.
   * Defaults to true.
   */
  autoRenewOnLifecycle?: boolean;
  /**
   * Microsoft Graph subscription resource. Defaults to the connected user's
   * Inbox messages.
   */
  inboundResource?: string;
  /**
   * Subscription lifetime in minutes. Outlook message subscriptions expire and
   * must be renewed before expiration.
   */
  inboundSubscriptionMinutes?: number;
  /**
   * Mailbox auth used to hydrate Microsoft Graph change notifications.
   * Microsoft Graph webhooks only include resource identifiers, so inbound
   * message normalization requires an access token with Mail.Read scope.
   */
  webhookAuth?: OutlookMailboxAuth;
  /**
   * Expected Microsoft Graph subscription clientState value(s). Configure this
   * to reject forged webhook notifications before mailbox data is fetched.
   */
  webhookClientState?: string | string[];
  /**
   * Resolve mailbox auth for a specific Graph notification. Use this when one
   * webhook endpoint receives subscriptions for multiple mailboxes.
   */
  webhookAuthResolver?: OutlookWebhookAuthResolver;
}

export interface OutlookMailboxAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  tokenType?: string;
}

export type OutlookSendEmailMode = "sendMail" | "draft";

export interface OutlookSendEmailResult extends SendEmailResult {
  /**
   * Microsoft Graph request/receipt id for the send operation. When
   * `messageIdKind` is "sendReceipt", this is also the required normalized
   * `messageId` fallback because Graph sendMail does not return a message.
   */
  receiptId?: string;
  raw?: {
    skippedHeaders?: string[];
    messageIdKind?: "graphMessageId" | "sendReceipt";
    createDraft?: unknown;
    sendDraft?: unknown;
    sendMail?: unknown;
  };
}

export interface OutlookInboundSubscription {
  id: string;
  resource?: string;
  changeType?: string;
  notificationUrl?: string;
  lifecycleNotificationUrl?: string;
  expirationDateTime?: string;
  clientState?: string;
  raw?: unknown;
}

export interface OutlookCapabilities extends DriverCapabilities {
  cc: true;
  bcc: true;
  replyTo: true;
  attachments: true;
  customHeaders: true;
  providerFetch: true;
  senderAuth: true;
  senderMailbox: true;
  requiresSecret: true;
  mailboxConnect: true;
  webhooks: {
    mailbox: true;
  };
  publicRoutes: {
    webhook: true;
    lifecycleWebhook: true;
    connectCallback: true;
    connectLanding: true;
  };
}

export const OUTLOOK_CAPABILITIES = {
  cc: true,
  bcc: true,
  replyTo: true,
  attachments: true,
  customHeaders: true,
  providerFetch: true,
  senderAuth: true,
  senderMailbox: true,
  requiresSecret: true,
  mailboxConnect: true,
  webhooks: {
    mailbox: true,
  },
  publicRoutes: {
    webhook: true,
    lifecycleWebhook: true,
    connectCallback: true,
    connectLanding: true,
  },
} as const satisfies OutlookCapabilities;

const DEFAULT_SCOPES = [
  "offline_access",
  "User.Read",
  "Mail.Send",
  "Mail.Read",
];
const PROVIDER = "outlook";
const STATE_VERSION = 1;
const TOKEN_REFRESH_LEEWAY_MS = 60_000;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const STATE_ENCRYPTION_ALGORITHM = "aes-256-gcm";
const DEFAULT_INBOUND_RESOURCE = "me/mailFolders('Inbox')/messages";
const DEFAULT_INBOUND_SUBSCRIPTION_MINUTES = 60 * 24 * 3;
const WEBHOOK_RENEWAL_BUFFER_MS = 60 * 60 * 1000;
const IMMUTABLE_ID_PREFER_HEADER = 'IdType="ImmutableId"';

interface OutlookStatePayload {
  v: typeof STATE_VERSION;
  provider: typeof PROVIDER;
  nonce: string;
  issuedAt: number;
  callbackUrl: string;
  webhookUrl?: string;
  lifecycleNotificationUrl?: string;
  scopes: string[];
  codeVerifier: string;
  email?: string;
  context?: unknown;
}

type OutlookPublicRoutes = NonNullable<
  EmailDriverOperationOptions["publicRoutes"]
> & {
  callback?: {
    url?: unknown;
    callbackUrl?: unknown;
  };
  webhook?: {
    url?: unknown;
    lifecycleUrl?: unknown;
    lifecycleNotificationUrl?: unknown;
  };
};

interface OutlookPublicRouteOptions {
  callbackUrl?: unknown;
  publicRoutes?: OutlookPublicRoutes;
}

interface MicrosoftTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  ext_expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
  [key: string]: unknown;
}

interface MicrosoftUserResponse {
  id?: string;
  displayName?: string;
  mail?: string | null;
  userPrincipalName?: string;
  [key: string]: unknown;
}

interface MicrosoftSubscriptionResponse {
  id?: string;
  resource?: string;
  changeType?: string;
  notificationUrl?: string;
  lifecycleNotificationUrl?: string;
  expirationDateTime?: string;
  clientState?: string;
  [key: string]: unknown;
}

type GraphRecipient = {
  emailAddress: {
    address: string;
    name?: string;
  };
};

interface GraphWebhookPayload {
  value: GraphChangeNotification[];
  [key: string]: unknown;
}

interface GraphChangeNotification {
  subscriptionId?: string;
  changeType?: string;
  resource?: string;
  resourceData?: {
    id?: string;
    "@odata.id"?: string;
    "@odata.type"?: string;
    [key: string]: unknown;
  };
  clientState?: string;
  tenantId?: string;
  subscriptionExpirationDateTime?: string;
  lifecycleEvent?: string;
  [key: string]: unknown;
}

export interface OutlookWebhookAuthResolverContext {
  notification: GraphChangeNotification;
  request: WebhookRequest;
  query?: Record<string, string>;
  subscriptionId?: string;
  clientState?: string;
}

export type OutlookWebhookAuthResolver = (
  context: OutlookWebhookAuthResolverContext,
) =>
  | OutlookMailboxAuth
  | undefined
  | null
  | Promise<OutlookMailboxAuth | undefined | null>;

interface GraphEmailAddress {
  emailAddress?: {
    address?: string;
    name?: string | null;
  };
}

interface GraphMessage {
  id?: string;
  internetMessageId?: string;
  subject?: string | null;
  body?: {
    contentType?: string;
    content?: string | null;
  };
  bodyPreview?: string | null;
  from?: GraphEmailAddress | null;
  toRecipients?: GraphEmailAddress[];
  ccRecipients?: GraphEmailAddress[];
  bccRecipients?: GraphEmailAddress[];
  replyTo?: GraphEmailAddress[];
  receivedDateTime?: string;
  sentDateTime?: string;
  conversationId?: string;
  internetMessageHeaders?: Array<{
    name?: string;
    value?: string;
  }>;
  attachments?: GraphAttachment[];
  [key: string]: unknown;
}

interface GraphAttachment {
  id?: string;
  name?: string;
  contentType?: string | null;
  size?: number;
  isInline?: boolean;
  contentId?: string | null;
  [key: string]: unknown;
}

interface OutlookAttachmentProviderMetadata {
  notification?: GraphChangeNotification;
  query?: Record<string, string>;
}

const createCodeVerifier = (): string => randomBytes(32).toString("base64url");

const createCodeChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

const stateEncryptionKey = (secret: string): Buffer =>
  createHash("sha256").update(secret).digest();

const encodeState = (payload: OutlookStatePayload, secret: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    STATE_ENCRYPTION_ALGORITHM,
    stateEncryptionKey(secret),
    iv,
  );
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, encrypted, tag]
    .map((part) => part.toString("base64url"))
    .join(".");
};

const decodeState = (state: string, secret: string): OutlookStatePayload => {
  const [ivPart, encryptedPart, tagPart, extra] = state.split(".");
  if (!ivPart || !encryptedPart || !tagPart || extra !== undefined) {
    throw new EmailKitError(
      "Invalid Outlook OAuth state",
      PROVIDER,
      "INVALID_STATE",
    );
  }

  let parsed: OutlookStatePayload;
  try {
    const decipher = createDecipheriv(
      STATE_ENCRYPTION_ALGORITHM,
      stateEncryptionKey(secret),
      Buffer.from(ivPart, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    parsed = JSON.parse(decrypted) as OutlookStatePayload;
  } catch (error) {
    throw new EmailKitError(
      "Invalid Outlook OAuth state payload",
      PROVIDER,
      "INVALID_STATE",
      undefined,
      error,
    );
  }
  if (parsed.v !== STATE_VERSION || parsed.provider !== PROVIDER) {
    throw new EmailKitError(
      "Unsupported Outlook OAuth state",
      PROVIDER,
      "INVALID_STATE",
    );
  }
  if (typeof parsed.issuedAt !== "number") {
    throw new EmailKitError(
      "Outlook OAuth state is missing an issuedAt timestamp",
      PROVIDER,
      "INVALID_STATE",
    );
  }
  if (Date.now() - parsed.issuedAt > STATE_MAX_AGE_MS) {
    throw new EmailKitError(
      "Outlook OAuth state has expired; please reconnect the mailbox",
      PROVIDER,
      "EXPIRED_STATE",
    );
  }
  if (!parsed.codeVerifier) {
    throw new EmailKitError(
      "Outlook OAuth state is missing PKCE verifier",
      PROVIDER,
      "INVALID_STATE",
    );
  }
  if (!parsed.callbackUrl) {
    throw new EmailKitError(
      "Outlook OAuth state is missing callbackUrl",
      PROVIDER,
      "INVALID_STATE",
    );
  }
  return parsed;
};

const requireSecret = (
  secret: string | undefined,
  operation: string,
): string => {
  if (!secret) {
    throw new EmailKitError(
      `EmailKit secret is required for Outlook ${operation}`,
      PROVIDER,
      "MISSING_SECRET",
    );
  }
  return secret;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const outlookRouteOptions = (
  options?: EmailDriverOperationOptions,
): OutlookPublicRouteOptions =>
  (options || {}) as EmailDriverOperationOptions & OutlookPublicRouteOptions;

const resolveMailboxConnectCallbackUrl = (
  input: { provider?: Record<string, unknown> },
  options?: EmailDriverOperationOptions,
): string => {
  const routeOptions = outlookRouteOptions(options);
  const callbackUrl =
    nonEmptyString((input as { callbackUrl?: unknown }).callbackUrl) ||
    nonEmptyString(routeOptions.callbackUrl) ||
    nonEmptyString(routeOptions.publicRoutes?.connectCallbackUrl) ||
    nonEmptyString(routeOptions.publicRoutes?.callback?.callbackUrl) ||
    nonEmptyString(routeOptions.publicRoutes?.callback?.url);

  if (!callbackUrl) {
    throw new EmailKitError(
      "Outlook mailbox connect requires callbackUrl from EmailKit public routes",
      PROVIDER,
      "MISSING_CALLBACK_URL",
    );
  }

  return callbackUrl;
};

const resolvePublicWebhookUrl = (
  options?: EmailDriverOperationOptions,
): string | undefined =>
  nonEmptyString(outlookRouteOptions(options).publicRoutes?.webhookUrl) ||
  nonEmptyString(outlookRouteOptions(options).publicRoutes?.webhook?.url);

const resolveWebhookSetupUrl = (input: { url?: string }): string => {
  const url = nonEmptyString(input.url);
  if (!url) {
    throw new EmailKitError(
      "Outlook mailbox webhook setup requires url from EmailKit public routes",
      PROVIDER,
      "MISSING_WEBHOOK_URL",
    );
  }
  return url;
};

const resolveLifecycleNotificationUrl = (
  notificationUrl: string,
  provider?: Record<string, unknown>,
  options?: EmailDriverOperationOptions,
  autoRenewOnLifecycle = true,
): string | undefined => {
  const routeOptions = outlookRouteOptions(options);
  return (
    nonEmptyString(provider?.lifecycleNotificationUrl) ||
    nonEmptyString(routeOptions.publicRoutes?.lifecycleWebhookUrl) ||
    nonEmptyString(routeOptions.publicRoutes?.webhook?.lifecycleUrl) ||
    nonEmptyString(
      routeOptions.publicRoutes?.webhook?.lifecycleNotificationUrl,
    ) ||
    (autoRenewOnLifecycle ? notificationUrl : undefined)
  );
};

const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, "");

const formatScopes = (scopes: string[]): string => scopes.join(" ");

const uniqueScopes = (scopes: string[]): string[] => {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    const key = scope.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const scopesForMailboxConnect = (
  scopes: string[],
  config: OutlookDriverConfig<string>,
): string[] => {
  const requiredScopes = [...scopes];
  if (config.autoSubscribeInbound) requiredScopes.push("Mail.Read");
  if (config.sendEmailMode === "draft") {
    requiredScopes.push("Mail.ReadWrite");
  }
  return uniqueScopes(requiredScopes);
};

const resolveSendEmailMode = (
  value: unknown,
  source: string,
): OutlookSendEmailMode | undefined => {
  if (value === undefined) return undefined;
  if (value === "sendMail" || value === "draft") return value;
  throw new EmailKitError(
    `Outlook ${source} must be "sendMail" or "draft"`,
    PROVIDER,
    "INVALID_PROVIDER_OPTION",
  );
};

const defaultWebhookClientState = (
  config: OutlookDriverConfig<string>,
): string =>
  `emailkit:${createHash("sha256")
    .update(`${config.clientId}:${config.clientSecret}`)
    .digest("hex")
    .slice(0, 32)}`;

const webhookClientStates = (config: OutlookDriverConfig<string>): string[] => {
  if (Array.isArray(config.webhookClientState))
    return config.webhookClientState;
  if (config.webhookClientState) return [config.webhookClientState];
  return config.webhookAuthResolver && !config.autoSubscribeInbound
    ? []
    : [defaultWebhookClientState(config)];
};

const subscriptionClientState = (config: OutlookDriverConfig<string>): string =>
  webhookClientStates(config)[0] || defaultWebhookClientState(config);

const autoRenewOnLifecycleEnabled = (
  config: OutlookDriverConfig<string>,
): boolean => config.autoRenewOnLifecycle !== false;

const addressToRecipient = (address: EmailAddress): GraphRecipient => ({
  emailAddress: {
    address: address.email,
    ...(address.name ? { name: address.name } : {}),
  },
});

const addressesToRecipients = (
  addresses: EmailAddress | EmailAddress[] | undefined,
): GraphRecipient[] | undefined => {
  if (!addresses) return undefined;
  const list = Array.isArray(addresses) ? addresses : [addresses];
  return list.map(addressToRecipient);
};

const graphAddressToEmailAddress = (
  recipient: GraphEmailAddress | null | undefined,
): EmailAddress | undefined => {
  const address = recipient?.emailAddress?.address?.trim();
  if (!address) return undefined;
  const name = recipient?.emailAddress?.name?.trim();
  return {
    email: address,
    ...(name ? { name } : {}),
  };
};

const graphRecipientsToEmailAddresses = (
  recipients: GraphEmailAddress[] | undefined,
): EmailAddress[] => {
  if (!recipients) return [];
  return recipients
    .map(graphAddressToEmailAddress)
    .filter((address): address is EmailAddress => Boolean(address));
};

const attachmentToGraph = (attachment: Attachment): Record<string, unknown> => {
  if (attachment.content === undefined) {
    throw new EmailKitError(
      `Outlook attachment ${attachment.filename} must include content; URL-only attachments are not supported by sendMail`,
      PROVIDER,
      "INVALID_ATTACHMENT",
    );
  }

  return {
    "@odata.type": "#microsoft.graph.fileAttachment",
    name: attachment.filename,
    contentType: attachment.contentType || "application/octet-stream",
    contentBytes:
      typeof attachment.content === "string"
        ? stringToBase64(attachment.content)
        : bytesToBase64(attachment.content),
    ...(attachment.isInline ? { isInline: true } : {}),
    ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
  };
};

const readJsonResponse = async (response: Response): Promise<unknown> => {
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) return response.json();
  const text = await response.text();
  if (!text) return undefined;
  return text;
};

const microsoftErrorMessage = (body: unknown, fallback: string): string => {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const graphError = record.error;
    if (typeof graphError === "object" && graphError !== null) {
      const message = (graphError as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof record.error_description === "string") {
      return record.error_description;
    }
    if (typeof record.message === "string") return record.message;
  }
  if (typeof body === "string" && body) return body;
  return fallback;
};

const sanitizeTokenResponse = (token: MicrosoftTokenResponse) => ({
  expiresIn: token.expires_in,
  extExpiresIn: token.ext_expires_in,
  scopes:
    typeof token.scope === "string"
      ? token.scope.split(/\s+/).filter(Boolean)
      : undefined,
  tokenType: token.token_type,
});

const toAuth = (
  token: MicrosoftTokenResponse,
  previous?: OutlookMailboxAuth,
): OutlookMailboxAuth => {
  if (!token.access_token) {
    throw new EmailKitError(
      "Microsoft token response did not include an access token",
      PROVIDER,
      "INVALID_TOKEN_RESPONSE",
      undefined,
      undefined,
      token,
    );
  }

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || previous?.refreshToken,
    expiresAt:
      typeof token.expires_in === "number"
        ? Date.now() + token.expires_in * 1000
        : previous?.expiresAt,
    scopes:
      typeof token.scope === "string"
        ? token.scope.split(/\s+/).filter(Boolean)
        : previous?.scopes,
    tokenType: token.token_type || previous?.tokenType || "Bearer",
  };
};

const isOutlookAuth = (auth: unknown): auth is OutlookMailboxAuth =>
  typeof auth === "object" &&
  auth !== null &&
  typeof (auth as OutlookMailboxAuth).accessToken === "string";

const webhookAuthFromConfig = async (
  config: OutlookDriverConfig<string>,
  request: WebhookRequest,
  notification: GraphChangeNotification,
): Promise<OutlookMailboxAuth | undefined> => {
  if (config.webhookAuthResolver) {
    const resolved = await config.webhookAuthResolver({
      notification,
      request,
      query: request.query,
      subscriptionId: notification.subscriptionId,
      clientState: notification.clientState,
    });
    if (isOutlookAuth(resolved)) return resolved;
  }
  if (isOutlookAuth(config.webhookAuth)) return config.webhookAuth;
  return undefined;
};

const staticWebhookAuthFromConfig = (
  config: OutlookDriverConfig<string>,
): OutlookMailboxAuth | undefined => {
  if (isOutlookAuth(config.webhookAuth)) return config.webhookAuth;
  return undefined;
};

const subscriptionRenewAfter = (
  expiresAt: Date | undefined,
): Date | undefined => {
  const expiresTime = expiresAt?.getTime();
  if (!expiresTime || Number.isNaN(expiresTime)) return undefined;

  const remainingMs = expiresTime - Date.now();
  if (remainingMs <= 1) return new Date(expiresTime - 1);

  const bufferMs = Math.min(
    WEBHOOK_RENEWAL_BUFFER_MS,
    Math.max(1, Math.floor(remainingMs / 2)),
  );
  return new Date(expiresTime - bufferMs);
};

const webhookEvents = (
  events: MailboxWebhookSetupInput["events"],
): NonNullable<Webhook["events"]> => {
  if (events === "all") return ["inbound"];
  return events && events.length > 0 ? events : ["inbound"];
};

const normalizeInboundSubscription = (
  subscription: OutlookInboundSubscription,
  input: {
    driverId: string;
    url: string;
    events?: Webhook["events"];
  },
): Webhook => {
  const expiresAt = subscription.expirationDateTime
    ? new Date(subscription.expirationDateTime)
    : undefined;
  const validExpiresAt =
    expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt : undefined;

  return {
    id: subscription.id,
    emailDriver: input.driverId,
    scope: "mailbox",
    url: subscription.notificationUrl || input.url,
    events: input.events,
    status: "active",
    providerId: subscription.id,
    expiresAt: validExpiresAt,
    renewAfter: subscriptionRenewAfter(validExpiresAt),
    raw: subscription.raw || subscription,
  };
};

const webhookSubscriptionId = (
  input: MailboxWebhookRefreshInput | MailboxWebhookDeleteInput,
): string => {
  const id =
    ("providerId" in input ? input.providerId : undefined) ||
    input.webhook?.providerId ||
    input.webhookId ||
    input.webhook?.id;
  if (!id) {
    throw new EmailKitError(
      "Outlook mailbox webhook operation requires a Graph subscription id",
      PROVIDER,
      "MISSING_WEBHOOK_ID",
    );
  }
  return id;
};

const parseWebhookBody = (request: WebhookRequest): unknown => {
  if (typeof request.body === "string") {
    try {
      return JSON.parse(request.body);
    } catch {
      return request.body;
    }
  }
  return request.body;
};

const isGraphWebhookPayload = (
  payload: unknown,
): payload is GraphWebhookPayload =>
  typeof payload === "object" &&
  payload !== null &&
  Array.isArray((payload as GraphWebhookPayload).value);

const isMessageNotification = (
  notification: GraphChangeNotification,
): boolean => {
  const resource =
    notification.resource || notification.resourceData?.["@odata.id"];
  const odataType = notification.resourceData?.["@odata.type"];
  return Boolean(
    (resource && /(^|\/)messages(\/|$|\()/i.test(resource)) ||
      odataType === "#Microsoft.Graph.Message" ||
      odataType === "#microsoft.graph.message",
  );
};

const isCreatedMessageNotification = (
  notification: GraphChangeNotification,
): boolean => {
  if (isLifecycleNotification(notification)) return false;
  const changeType = notification.changeType?.toLowerCase();
  return (
    isMessageNotification(notification) &&
    (!changeType || changeType === "created")
  );
};

const graphLifecycleEventName = (
  notification: GraphChangeNotification,
): string | undefined => notification.lifecycleEvent?.toLowerCase();

const isLifecycleNotification = (
  notification: GraphChangeNotification,
): boolean => {
  const lifecycleEvent = graphLifecycleEventName(notification);
  return (
    lifecycleEvent === "reauthorizationrequired" ||
    lifecycleEvent === "subscriptionremoved" ||
    lifecycleEvent === "missed"
  );
};

const lifecycleTargetFromNotification = (
  notification: GraphChangeNotification,
  request: WebhookRequest,
) => {
  const mailboxEmail = request.query?.mailboxEmail || request.query?.email;
  const explicitMailboxId = request.query?.mailboxId;
  const resource =
    notification.resource || notification.resourceData?.["@odata.id"];
  const resourceMailboxId = resource?.match(/(?:^|\/)users\/([^/]+)/i)?.[1];
  const mailboxId = explicitMailboxId || resourceMailboxId;
  if (!mailboxEmail && !mailboxId) return undefined;

  return {
    ...(mailboxEmail ? { mailboxEmail } : {}),
    ...(mailboxId ? { mailboxId: decodeURIComponent(mailboxId) } : {}),
  };
};

const lifecycleRecommendedActions = (
  notification: GraphChangeNotification,
): WebhookRecommendedAction[] => {
  switch (graphLifecycleEventName(notification)) {
    case "reauthorizationrequired":
      return notification.subscriptionId ? ["renew"] : ["reauthorize"];
    case "subscriptionremoved":
      return ["delete_local", "recreate"];
    case "missed":
      return ["sync"];
    default:
      return ["inspect"];
  }
};

const transformGraphLifecycleNotification = (
  notification: GraphChangeNotification,
  request: WebhookRequest,
  driverId: string,
): WebhookLifecycleDriverEvent | undefined => {
  const lifecycleEvent = graphLifecycleEventName(notification);
  if (!lifecycleEvent) return undefined;

  const subscriptionId = notification.subscriptionId;
  const target = lifecycleTargetFromNotification(notification, request);
  const base = {
    emailDriver: driverId,
    source: "provider" as const,
    scope: "mailbox" as const,
    ...(subscriptionId
      ? {
          providerId: subscriptionId,
          subscriptionId,
          webhookId: subscriptionId,
        }
      : {}),
    ...(target ? { target } : {}),
    recommendedActions: lifecycleRecommendedActions(notification),
    receivedAt: new Date(),
    raw: notification,
  };

  switch (lifecycleEvent) {
    case "reauthorizationrequired":
      return {
        type: "webhook.lifecycle",
        data: {
          ...base,
          action: "action_required",
          reason: "reauthorization_required",
        },
      };
    case "subscriptionremoved":
      return {
        type: "webhook.lifecycle",
        data: {
          ...base,
          action: "deleted",
          reason: "subscription_removed",
          status: "deleted",
        },
      };
    case "missed":
      return {
        type: "webhook.lifecycle",
        data: {
          ...base,
          action: "sync_required",
          reason: "notifications_missed",
        },
      };
  }
};

const verifyWebhookClientState = (
  config: OutlookDriverConfig<string>,
  notification: GraphChangeNotification,
): void => {
  const allowed = webhookClientStates(config);
  if (allowed.length === 0) return;

  if (notification.clientState && allowed.includes(notification.clientState)) {
    return;
  }

  throw new EmailKitError(
    "Invalid Outlook webhook clientState",
    PROVIDER,
    "INVALID_WEBHOOK_CLIENT_STATE",
    401,
  );
};

const outlookProviderMetadata = (
  provider: Record<string, unknown> | undefined,
): OutlookAttachmentProviderMetadata | undefined => {
  const outlook = provider?.outlook;
  if (!outlook || typeof outlook !== "object") return undefined;
  return outlook as OutlookAttachmentProviderMetadata;
};

const notificationResourcePath = (
  notification: GraphChangeNotification,
): string | undefined => {
  const resource =
    notification.resourceData?.["@odata.id"] || notification.resource;
  if (resource) return resource.replace(/^\/+/, "");
  const messageId = notification.resourceData?.id;
  return messageId ? `me/messages/${encodeURIComponent(messageId)}` : undefined;
};

const graphMessageUrl = (graphBase: string, resourcePath: string): string => {
  const base =
    resourcePath.startsWith("http://") || resourcePath.startsWith("https://")
      ? resourcePath
      : `${graphBase}/${resourcePath}`;
  const url = new URL(base);
  const graphBaseUrl = new URL(`${graphBase}/`);
  if (
    url.origin !== graphBaseUrl.origin ||
    !url.pathname.startsWith(graphBaseUrl.pathname)
  ) {
    throw new EmailKitError(
      "Invalid Microsoft Graph message resource URL",
      PROVIDER,
      "INVALID_WEBHOOK_RESOURCE",
      400,
    );
  }
  url.searchParams.set(
    "$select",
    [
      "id",
      "internetMessageId",
      "subject",
      "body",
      "bodyPreview",
      "from",
      "toRecipients",
      "ccRecipients",
      "bccRecipients",
      "replyTo",
      "receivedDateTime",
      "sentDateTime",
      "conversationId",
      "internetMessageHeaders",
      "attachments",
    ].join(","),
  );
  url.searchParams.set(
    "$expand",
    "attachments($select=id,name,contentType,size,isInline)",
  );
  return url.toString();
};

const resolveGraphUrl = (
  graphBase: string,
  path: string | URL,
  init?: ProviderFetchInit,
): URL => {
  const value = path instanceof URL ? path.toString() : path;
  const url = /^https?:\/\//i.test(value)
    ? new URL(value)
    : new URL(value.replace(/^\/+/, ""), `${graphBase}/`);

  if (init?.searchParams) {
    const params =
      init.searchParams instanceof URLSearchParams
        ? Array.from(init.searchParams.entries())
        : Object.entries(init.searchParams).flatMap(([key, value]) => {
            if (value === undefined || value === null) return [];
            if (Array.isArray(value)) {
              return value
                .filter((entry) => entry !== undefined && entry !== null)
                .map((entry) => [key, String(entry)] as const);
            }
            return [[key, String(value)] as const];
          });

    for (const [key] of params) url.searchParams.delete(key);
    for (const [key, value] of params) url.searchParams.append(key, value);
  }

  return url;
};

const normalizeHeaders = (
  headers: GraphMessage["internetMessageHeaders"],
): Record<string, string> => {
  const normalized: Record<string, string> = {};
  for (const header of headers || []) {
    if (header.name && typeof header.value === "string") {
      normalized[header.name.toLowerCase()] = header.value;
    }
  }
  return normalized;
};

const transformGraphMessage = (
  message: GraphMessage,
  notification: GraphChangeNotification,
  messageUrl: string,
  request?: WebhookRequest,
): InboundEmailEvent => {
  const headers = normalizeHeaders(message.internetMessageHeaders);
  const replyTo = graphRecipientsToEmailAddresses(message.replyTo);
  const references = headers.references
    ? headers.references.split(/\s+/).filter(Boolean)
    : undefined;
  const bodyContent = message.body?.content || undefined;
  const bodyType = message.body?.contentType?.toLowerCase();
  const timestamp =
    message.receivedDateTime ||
    message.sentDateTime ||
    new Date().toISOString();
  const attachmentBaseUrl = messageUrl.replace(/[?#].*$/, "");
  const attachments = (message.attachments || [])
    .filter((attachment) => attachment.id || attachment.name)
    .map(
      (attachment, index): Attachment => ({
        filename: attachment.name || `attachment-${index + 1}`,
        contentType: attachment.contentType || undefined,
        size: attachment.size,
        contentId: attachment.contentId || undefined,
        isInline: attachment.isInline || undefined,
        ...(attachment.id
          ? {
              url: `${attachmentBaseUrl}/attachments/${encodeURIComponent(
                attachment.id,
              )}/$value`,
            }
          : {}),
        provider: {
          outlook: {
            notification,
            ...(request?.query ? { query: request.query } : {}),
          },
        },
      }),
    );

  return {
    schemaVersion: "1",
    eventId:
      notification.subscriptionId && message.id
        ? `${notification.subscriptionId}:${message.id}:${
            notification.changeType || "updated"
          }`
        : undefined,
    messageId: message.internetMessageId || message.id || "",
    providerId: message.id,
    from: graphAddressToEmailAddress(message.from) || { email: "" },
    to: graphRecipientsToEmailAddresses(message.toRecipients),
    cc: graphRecipientsToEmailAddresses(message.ccRecipients),
    bcc: graphRecipientsToEmailAddresses(message.bccRecipients),
    reply: buildReplyContext({
      addresses: replyTo,
      messageId: headers["in-reply-to"],
      references,
      threadId: message.conversationId,
    }),
    subject: message.subject || "",
    text: bodyType === "text" ? bodyContent : message.bodyPreview || undefined,
    html: bodyType === "html" ? bodyContent : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    headers,
    timestamp: new Date(timestamp),
    raw: {
      notification,
      message,
    },
  };
};

const queryValue = (
  request: WebhookRequest,
  key: string,
): string | undefined => {
  const value = request.query?.[key];
  return typeof value === "string" ? value : undefined;
};

const requestIdFrom = (response: Response): string | undefined =>
  response.headers.get("request-id") ||
  response.headers.get("x-ms-request-id") ||
  response.headers.get("client-request-id") ||
  undefined;

export const OutlookDriver = <const TId extends string = "outlook">(
  config: OutlookDriverConfig<TId>,
): EmailDriver<OutlookDriverConfig<TId>, typeof OUTLOOK_CAPABILITIES, TId> => {
  const driverId = (config.id || "outlook") as TId;
  const tenant = encodeURIComponent(config.tenant || "common");
  const authBase = normalizeBaseUrl(
    config.authBase || "https://login.microsoftonline.com",
  );
  const graphBase = normalizeBaseUrl(
    config.graphBase || "https://graph.microsoft.com/v1.0",
  );
  const configuredSendEmailMode =
    resolveSendEmailMode(config.sendEmailMode, "sendEmailMode") || "sendMail";
  const scopes =
    config.scopes && config.scopes.length > 0 ? config.scopes : DEFAULT_SCOPES;
  const mailboxScopes = scopesForMailboxConnect(scopes, config);
  const tokenUrl = `${authBase}/${tenant}/oauth2/v2.0/token`;

  const fetchToken = async (
    form: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<MicrosoftTokenResponse> => {
    const response = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal,
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      throw new EmailKitError(
        microsoftErrorMessage(body, "Microsoft token request failed"),
        PROVIDER,
        undefined,
        response.status,
        undefined,
        body,
      );
    }
    return body as MicrosoftTokenResponse;
  };

  const refreshAuth = async (
    auth: OutlookMailboxAuth,
    signal?: AbortSignal,
  ): Promise<OutlookMailboxAuth> => {
    if (!auth.refreshToken) {
      throw new EmailKitError(
        "Outlook access token is expired and no refresh token was provided",
        PROVIDER,
        "MISSING_REFRESH_TOKEN",
      );
    }

    const form = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
      scope: formatScopes(
        auth.scopes && auth.scopes.length > 0 ? auth.scopes : mailboxScopes,
      ),
    });
    const token = await fetchToken(form, signal);
    return toAuth(token, auth);
  };

  const createInboundSubscription = async (
    auth: OutlookMailboxAuth,
    input?: {
      notificationUrl?: string;
      events?: Webhook["events"];
      provider?: Record<string, unknown>;
      options?: EmailDriverOperationOptions;
    },
  ): Promise<OutlookInboundSubscription> => {
    const provider = input?.provider || {};
    const minutes =
      typeof provider.subscriptionMinutes === "number" &&
      provider.subscriptionMinutes > 0
        ? provider.subscriptionMinutes
        : typeof config.inboundSubscriptionMinutes === "number" &&
            config.inboundSubscriptionMinutes > 0
          ? config.inboundSubscriptionMinutes
          : DEFAULT_INBOUND_SUBSCRIPTION_MINUTES;
    const resource =
      typeof provider.resource === "string" && provider.resource
        ? provider.resource
        : config.inboundResource || DEFAULT_INBOUND_RESOURCE;
    const changeType =
      typeof provider.changeType === "string" && provider.changeType
        ? provider.changeType
        : "created";
    const notificationUrl = input?.notificationUrl;
    if (!notificationUrl) {
      throw new EmailKitError(
        "Outlook inbound subscription creation requires a notificationUrl",
        PROVIDER,
        "MISSING_WEBHOOK_URL",
      );
    }
    const clientState =
      typeof provider.clientState === "string" && provider.clientState
        ? provider.clientState
        : subscriptionClientState(config);
    const lifecycleNotificationUrl = resolveLifecycleNotificationUrl(
      notificationUrl,
      provider,
      input?.options,
      autoRenewOnLifecycleEnabled(config),
    );
    const expirationDateTime =
      typeof provider.expirationDateTime === "string" &&
      provider.expirationDateTime
        ? provider.expirationDateTime
        : provider.expirationDateTime instanceof Date
          ? provider.expirationDateTime.toISOString()
          : new Date(Date.now() + minutes * 60_000).toISOString();

    const requestBody: Record<string, unknown> = {
      changeType,
      notificationUrl,
      resource,
      expirationDateTime,
      clientState,
      latestSupportedTlsVersion: "v1_2",
    };
    if (lifecycleNotificationUrl) {
      requestBody.lifecycleNotificationUrl = lifecycleNotificationUrl;
    }

    const response = await fetch(`${graphBase}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `${auth.tokenType || "Bearer"} ${auth.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      throw new EmailKitError(
        microsoftErrorMessage(
          body,
          "Microsoft Graph inbound subscription creation failed",
        ),
        PROVIDER,
        undefined,
        response.status,
        undefined,
        body,
      );
    }

    const subscription = body as MicrosoftSubscriptionResponse;
    if (!subscription.id) {
      throw new EmailKitError(
        "Microsoft Graph subscription response did not include an id",
        PROVIDER,
        "INVALID_SUBSCRIPTION_RESPONSE",
        undefined,
        undefined,
        body,
      );
    }

    return {
      id: subscription.id,
      resource: subscription.resource,
      changeType: subscription.changeType,
      notificationUrl: subscription.notificationUrl,
      lifecycleNotificationUrl: subscription.lifecycleNotificationUrl,
      expirationDateTime: subscription.expirationDateTime,
      clientState: subscription.clientState,
      raw: subscription,
    };
  };

  const resolveMailboxWebhookAuth = async (
    input:
      | MailboxWebhookSetupInput
      | MailboxWebhookRefreshInput
      | MailboxWebhookDeleteInput,
    options?: EmailDriverOperationOptions,
  ): Promise<OutlookMailboxAuth> => {
    const inputAuth = isOutlookAuth(input.auth) ? input.auth : undefined;
    const optionsAuth = isOutlookAuth(options?.auth) ? options.auth : undefined;
    let auth = inputAuth || optionsAuth;
    if (!auth) {
      throw new EmailKitError(
        "Outlook mailbox webhook operation requires mailbox auth with an accessToken",
        PROVIDER,
        "MISSING_AUTH",
      );
    }

    if (
      typeof auth.expiresAt === "number" &&
      auth.expiresAt <= Date.now() + TOKEN_REFRESH_LEEWAY_MS
    ) {
      const previousAuth = auth;
      auth = await refreshAuth(auth);
      await options?.onAuthUpdated?.({
        auth,
        previousAuth,
        mailbox: "mailbox" in input ? input.mailbox : options?.mailbox,
        context: options?.context,
      });
    }

    return auth;
  };

  const refreshInboundSubscription = async (
    auth: OutlookMailboxAuth,
    id: string,
    provider?: Record<string, unknown>,
  ): Promise<OutlookInboundSubscription> => {
    const minutes =
      typeof provider?.subscriptionMinutes === "number" &&
      provider.subscriptionMinutes > 0
        ? provider.subscriptionMinutes
        : typeof config.inboundSubscriptionMinutes === "number" &&
            config.inboundSubscriptionMinutes > 0
          ? config.inboundSubscriptionMinutes
          : DEFAULT_INBOUND_SUBSCRIPTION_MINUTES;
    const requestBody: Record<string, unknown> = {
      expirationDateTime:
        typeof provider?.expirationDateTime === "string" &&
        provider.expirationDateTime
          ? provider.expirationDateTime
          : provider?.expirationDateTime instanceof Date
            ? provider.expirationDateTime.toISOString()
            : new Date(Date.now() + minutes * 60_000).toISOString(),
    };
    if (
      typeof provider?.notificationUrl === "string" &&
      provider.notificationUrl
    ) {
      requestBody.notificationUrl = provider.notificationUrl;
    }

    const response = await fetch(
      `${graphBase}/subscriptions/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `${auth.tokenType || "Bearer"} ${auth.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
    );
    const body = await readJsonResponse(response);
    if (!response.ok) {
      throw new EmailKitError(
        microsoftErrorMessage(
          body,
          "Microsoft Graph inbound subscription renewal failed",
        ),
        PROVIDER,
        undefined,
        response.status,
        undefined,
        body,
      );
    }

    const subscription = body as MicrosoftSubscriptionResponse;
    if (!subscription.id) {
      throw new EmailKitError(
        "Microsoft Graph subscription response did not include an id",
        PROVIDER,
        "INVALID_SUBSCRIPTION_RESPONSE",
        undefined,
        undefined,
        body,
      );
    }

    return {
      id: subscription.id,
      resource: subscription.resource,
      changeType: subscription.changeType,
      notificationUrl: subscription.notificationUrl,
      lifecycleNotificationUrl: subscription.lifecycleNotificationUrl,
      expirationDateTime: subscription.expirationDateTime,
      clientState: subscription.clientState,
      raw: subscription,
    };
  };

  const deleteInboundSubscription = async (
    auth: OutlookMailboxAuth,
    id: string,
  ): Promise<{ deleted: boolean; raw: unknown }> => {
    const response = await fetch(
      `${graphBase}/subscriptions/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: {
          Authorization: `${auth.tokenType || "Bearer"} ${auth.accessToken}`,
        },
      },
    );
    const body = await readJsonResponse(response);
    if (response.status === 404) {
      return { deleted: true, raw: body };
    }
    if (!response.ok) {
      throw new EmailKitError(
        microsoftErrorMessage(
          body,
          "Microsoft Graph inbound subscription deletion failed",
        ),
        PROVIDER,
        undefined,
        response.status,
        undefined,
        body,
      );
    }
    return { deleted: true, raw: body };
  };

  const autoRenewLifecycleNotification = async (
    request: WebhookRequest,
    notification: GraphChangeNotification,
  ): Promise<WebhookLifecycleDriverEvent | undefined> => {
    if (!autoRenewOnLifecycleEnabled(config)) return undefined;
    if (graphLifecycleEventName(notification) !== "reauthorizationrequired") {
      return undefined;
    }
    if (!notification.subscriptionId) return undefined;

    const auth = await webhookAuthFromConfig(config, request, notification);
    if (!auth) return undefined;

    const inboundSubscription = await refreshInboundSubscription(
      auth,
      notification.subscriptionId,
    );
    const url = inboundSubscription.notificationUrl;
    if (!url) {
      throw new EmailKitError(
        "Outlook lifecycle renewal requires a notificationUrl from Microsoft Graph",
        PROVIDER,
        "MISSING_WEBHOOK_URL",
      );
    }
    const webhook = normalizeInboundSubscription(inboundSubscription, {
      driverId,
      url,
      events: ["inbound"],
    });

    return {
      type: "webhook.lifecycle",
      data: {
        emailDriver: driverId,
        action: "updated",
        source: "provider",
        reason: "renewed",
        recommendedActions: ["persist"],
        scope: "mailbox",
        webhook,
        webhookId: webhook.id,
        providerId: webhook.providerId,
        subscriptionId: inboundSubscription.id,
        ...(lifecycleTargetFromNotification(notification, request)
          ? { target: lifecycleTargetFromNotification(notification, request) }
          : {}),
        status: webhook.status,
        expiresAt: webhook.expiresAt,
        renewAfter: webhook.renewAfter,
        receivedAt: new Date(),
        raw: {
          notification,
          inboundSubscription,
        },
      },
    };
  };

  const setupMailboxWebhook = async (
    input: MailboxWebhookSetupInput,
    options?: EmailDriverOperationOptions,
  ): Promise<MailboxWebhookSetupResult> => {
    const auth = await resolveMailboxWebhookAuth(input, options);
    const events = webhookEvents(input.events);
    const url = resolveWebhookSetupUrl(input);
    const inboundSubscription = await createInboundSubscription(auth, {
      notificationUrl: url,
      events,
      provider: input.provider,
      ...(options ? { options } : {}),
    });
    const webhook = normalizeInboundSubscription(inboundSubscription, {
      driverId,
      url,
      events,
    });

    return {
      webhook,
      context: input.context ?? options?.context,
      raw: {
        inboundSubscription,
      },
    };
  };

  const resolveProviderFetchAuth = async (
    init?: ProviderFetchInit,
  ): Promise<OutlookMailboxAuth | undefined> => {
    const metadata = outlookProviderMetadata(init?.provider);
    if (metadata?.notification) {
      const resolved = await webhookAuthFromConfig(
        config,
        {
          method: "GET",
          headers: {},
          body: null,
          ...(metadata.query ? { query: metadata.query } : {}),
        },
        metadata.notification,
      );
      if (resolved) return resolved;
    }

    return staticWebhookAuthFromConfig(config);
  };

  return {
    id: driverId,
    name: "outlook",
    capabilities: OUTLOOK_CAPABILITIES,

    sendEmail: async (
      message: EmailMessage<typeof OUTLOOK_CAPABILITIES>,
      options?: SendEmailOptions,
    ): Promise<SendEmailResult> => {
      if (!isOutlookAuth(options?.auth)) {
        throw new EmailKitError(
          "Outlook sendEmail requires mailbox auth with an accessToken",
          PROVIDER,
          "MISSING_AUTH",
        );
      }
      if (!message.html && !message.text) {
        throw new EmailKitError(
          "Outlook sendEmail requires either html or text content",
          PROVIDER,
          "MISSING_REQUIRED_FIELD",
        );
      }

      const unsupportedSendFields = [
        ...((message as { track?: unknown }).track !== undefined
          ? ["track"]
          : []),
        ...((message as { tags?: unknown }).tags !== undefined ? ["tags"] : []),
        ...((message as { metadata?: unknown }).metadata !== undefined
          ? ["metadata"]
          : []),
        ...((message as { sendAt?: unknown }).sendAt !== undefined
          ? ["sendAt"]
          : []),
        ...((message as { templateId?: unknown }).templateId !== undefined
          ? ["templateId"]
          : []),
        ...((message as { templateData?: unknown }).templateData !== undefined
          ? ["templateData"]
          : []),
        ...((message as { sandbox?: unknown }).sandbox !== undefined
          ? ["sandbox"]
          : []),
        ...((message as { idempotencyKey?: unknown }).idempotencyKey !==
        undefined
          ? ["idempotencyKey"]
          : []),
      ];
      if (unsupportedSendFields.length > 0) {
        throw new EmailKitError(
          `Outlook sendEmail does not support these EmailKit send fields: ${unsupportedSendFields.join(
            ", ",
          )}`,
          PROVIDER,
          "NOT_SUPPORTED",
        );
      }

      const senderMailboxEmail = options.mailbox?.email?.toLowerCase();
      if (
        senderMailboxEmail &&
        message.from.email.toLowerCase() !== senderMailboxEmail
      ) {
        throw new EmailKitError(
          "Outlook sendEmail can only send from the authenticated mailbox. Shared mailbox/send-as is not supported by this driver.",
          PROVIDER,
          "NOT_SUPPORTED",
        );
      }

      let auth = options.auth;
      if (
        typeof auth.expiresAt === "number" &&
        auth.expiresAt <= Date.now() + TOKEN_REFRESH_LEEWAY_MS
      ) {
        const previousAuth = auth;
        auth = await refreshAuth(auth, options.signal);
        await options.onAuthUpdated?.({
          auth,
          previousAuth,
          ...(options.mailbox ? { mailbox: options.mailbox } : {}),
          ...(options.context !== undefined
            ? { context: options.context }
            : {}),
        });
      }

      const reply = resolveMessageReplyContext(message);
      const unsupportedReplyFields = [
        ...(reply.messageId ? ["reply.messageId"] : []),
        ...(reply.references?.length ? ["reply.references"] : []),
        ...(reply.threadId ? ["reply.threadId"] : []),
        ...(reply.isReply ? ["reply.isReply"] : []),
      ];
      if (unsupportedReplyFields.length > 0) {
        throw new EmailKitError(
          `Outlook sendEmail does not support reply threading fields: ${unsupportedReplyFields.join(
            ", ",
          )}. Use reply.addresses only for Reply-To handling.`,
          PROVIDER,
          "NOT_SUPPORTED",
        );
      }
      const replyTo = hasReplyData(reply)
        ? addressesToRecipients(replyAddressesAsArray(reply))
        : undefined;
      const skippedHeaders = Object.keys(message.headers || {}).filter(
        (name) => !name.toLowerCase().startsWith("x-"),
      );
      if (skippedHeaders.length > 0) {
        throw new EmailKitError(
          `Outlook sendEmail only supports custom headers beginning with X-: ${skippedHeaders.join(
            ", ",
          )}`,
          PROVIDER,
          "NOT_SUPPORTED",
        );
      }
      const internetMessageHeaders = Object.entries(message.headers || {}).map(
        ([name, value]) => ({ name, value: String(value) }),
      );

      const graphMessage: Record<string, unknown> = {
        subject: message.subject,
        from: addressToRecipient(message.from),
        body: {
          contentType: message.html ? "HTML" : "Text",
          content: message.html || message.text || "",
        },
        toRecipients: addressesToRecipients(message.to) || [],
      };
      const ccRecipients = addressesToRecipients(message.cc);
      const bccRecipients = addressesToRecipients(message.bcc);
      if (ccRecipients?.length) graphMessage.ccRecipients = ccRecipients;
      if (bccRecipients?.length) graphMessage.bccRecipients = bccRecipients;
      if (replyTo?.length) graphMessage.replyTo = replyTo;
      if (internetMessageHeaders.length) {
        graphMessage.internetMessageHeaders = internetMessageHeaders;
      }
      if (message.attachments?.length) {
        graphMessage.attachments = message.attachments.map(attachmentToGraph);
      }

      const sendEmailMode =
        resolveSendEmailMode(
          message.provider?.sendEmailMode,
          "message.provider.sendEmailMode",
        ) || configuredSendEmailMode;

      if (
        sendEmailMode === "draft" &&
        message.provider?.saveToSentItems === false
      ) {
        throw new EmailKitError(
          'Outlook draft send mode always saves to Sent Items. Use sendEmailMode: "sendMail" when provider.saveToSentItems is false.',
          PROVIDER,
          "NOT_SUPPORTED",
        );
      }

      if (sendEmailMode === "draft") {
        const createDraftResponse = await fetch(`${graphBase}/me/messages`, {
          method: "POST",
          headers: {
            Authorization: `${auth.tokenType || "Bearer"} ${auth.accessToken}`,
            "Content-Type": "application/json",
            Prefer: IMMUTABLE_ID_PREFER_HEADER,
          },
          body: JSON.stringify(graphMessage),
          signal: options?.signal,
        });
        const createDraftBody = await readJsonResponse(createDraftResponse);
        if (!createDraftResponse.ok) {
          throw new EmailKitError(
            microsoftErrorMessage(
              createDraftBody,
              "Microsoft Graph create draft failed",
            ),
            PROVIDER,
            undefined,
            createDraftResponse.status,
            undefined,
            createDraftBody,
          );
        }

        const draft =
          typeof createDraftBody === "object" && createDraftBody !== null
            ? (createDraftBody as { id?: unknown })
            : undefined;
        const draftId = typeof draft?.id === "string" ? draft.id : undefined;
        if (!draftId) {
          throw new EmailKitError(
            "Microsoft Graph create draft response did not include a message id",
            PROVIDER,
            "INVALID_SEND_RESPONSE",
            undefined,
            undefined,
            createDraftBody,
          );
        }

        const sendDraftResponse = await fetch(
          `${graphBase}/me/messages/${encodeURIComponent(draftId)}/send`,
          {
            method: "POST",
            headers: {
              Authorization: `${auth.tokenType || "Bearer"} ${
                auth.accessToken
              }`,
              Prefer: IMMUTABLE_ID_PREFER_HEADER,
            },
            signal: options?.signal,
          },
        );
        const sendDraftBody = await readJsonResponse(sendDraftResponse);
        if (!sendDraftResponse.ok) {
          throw new EmailKitError(
            microsoftErrorMessage(
              sendDraftBody,
              "Microsoft Graph send draft failed",
            ),
            PROVIDER,
            undefined,
            sendDraftResponse.status,
            undefined,
            sendDraftBody,
          );
        }

        const sendRequestId =
          requestIdFrom(sendDraftResponse) ||
          requestIdFrom(createDraftResponse);
        const result: OutlookSendEmailResult = {
          messageId: draftId,
          provider: driverId,
          requestId: sendRequestId,
          receiptId: sendRequestId,
          providerId: draftId,
          raw: {
            skippedHeaders: skippedHeaders.length ? skippedHeaders : undefined,
            messageIdKind: "graphMessageId",
            createDraft: createDraftBody,
            sendDraft: sendDraftBody,
          },
        };
        return result;
      }

      const requestBody: Record<string, unknown> = {
        message: graphMessage,
      };
      if (message.provider?.saveToSentItems === false) {
        requestBody.saveToSentItems = false;
      }

      const response = await fetch(`${graphBase}/me/sendMail`, {
        method: "POST",
        headers: {
          Authorization: `${auth.tokenType || "Bearer"} ${auth.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: options?.signal,
      });
      const body = await readJsonResponse(response);
      if (!response.ok) {
        throw new EmailKitError(
          microsoftErrorMessage(body, "Microsoft Graph sendMail failed"),
          PROVIDER,
          undefined,
          response.status,
          undefined,
          body,
        );
      }

      const requestId = requestIdFrom(response);
      const receiptId = requestId || `${Date.now()}@outlook.graph`;
      const result: OutlookSendEmailResult = {
        messageId: receiptId,
        provider: driverId,
        requestId,
        receiptId,
        raw: {
          skippedHeaders: skippedHeaders.length ? skippedHeaders : undefined,
          messageIdKind: "sendReceipt",
          sendMail: body,
        },
      };
      return result;
    },

    providerFetch: async (path, init) => {
      const auth = await resolveProviderFetchAuth(init);
      if (!auth) {
        throw new EmailKitError(
          "Outlook providerFetch requires webhookAuth or resolvable Outlook attachment metadata",
          PROVIDER,
          "MISSING_AUTH",
        );
      }

      const {
        searchParams: _ignored,
        headers: initHeaders,
        provider: _provider,
        ...restInit
      } = init ?? {};
      const headers = new Headers(initHeaders);
      if (!headers.has("Authorization")) {
        headers.set(
          "Authorization",
          `${auth.tokenType || "Bearer"} ${auth.accessToken}`,
        );
      }

      return fetch(resolveGraphUrl(graphBase, path, init), {
        ...restInit,
        headers,
      });
    },

    handleWebhook: async (
      request: WebhookRequest,
    ): Promise<WebhookEventResult> => {
      const payload = parseWebhookBody(request);
      if (!isGraphWebhookPayload(payload)) {
        return { type: "unknown", data: payload };
      }

      const lifecycleEvents: WebhookLifecycleDriverEvent[] = [];
      for (const notification of payload.value.filter(
        isLifecycleNotification,
      )) {
        verifyWebhookClientState(config, notification);
        lifecycleEvents.push(
          (await autoRenewLifecycleNotification(request, notification)) ||
            transformGraphLifecycleNotification(
              notification,
              request,
              driverId,
            )!,
        );
      }

      const notifications = payload.value.filter(isCreatedMessageNotification);
      if (notifications.length === 0 && lifecycleEvents.length === 0) {
        return { type: "unknown", data: payload };
      }

      const events: Array<WebhookEvent | WebhookLifecycleDriverEvent> = [
        ...lifecycleEvents,
      ];
      for (const notification of notifications) {
        verifyWebhookClientState(config, notification);
        const resourcePath = notificationResourcePath(notification);
        const auth = await webhookAuthFromConfig(config, request, notification);
        if (!resourcePath || !auth) continue;

        const messageUrl = graphMessageUrl(graphBase, resourcePath);
        const response = await fetch(messageUrl, {
          headers: {
            Authorization: `${auth.tokenType || "Bearer"} ${auth.accessToken}`,
            Accept: "application/json",
          },
        });
        const body = await readJsonResponse(response);
        if (!response.ok) {
          throw new EmailKitError(
            microsoftErrorMessage(body, "Microsoft Graph message fetch failed"),
            PROVIDER,
            undefined,
            response.status,
            undefined,
            body,
          );
        }

        events.push({
          type: "inbound",
          data: transformGraphMessage(
            body as GraphMessage,
            notification,
            messageUrl,
            request,
          ),
        });
      }

      if (events.length === 0) return { type: "unknown", data: payload };
      return events.length === 1 ? events[0]! : events;
    },

    webhookResponse: async (
      request: WebhookRequest,
      _handled: boolean,
    ): Promise<WebhookResponse> => {
      const validationToken = queryValue(request, "validationToken");
      if (validationToken) {
        return {
          status: 200,
          body: decodeURIComponent(validationToken),
          headers: { "Content-Type": "text/plain" },
        };
      }

      return {
        status: 202,
        body: { success: true },
      };
    },

    handleCallback: async (
      request: WebhookRequest,
      options,
    ): Promise<MailboxConnectionResult> => {
      const secret = requireSecret(options?.secret, "callback handling");
      const error = queryValue(request, "error");
      if (error) {
        throw new EmailKitError(
          queryValue(request, "error_description") || error,
          PROVIDER,
          error,
        );
      }

      const code = queryValue(request, "code");
      const stateValue = queryValue(request, "state");
      if (!code) {
        throw new EmailKitError(
          "Missing Outlook OAuth code",
          PROVIDER,
          "MISSING_CODE",
        );
      }
      if (!stateValue) {
        throw new EmailKitError(
          "Missing Outlook OAuth state",
          PROVIDER,
          "MISSING_STATE",
        );
      }

      const state = decodeState(stateValue, secret);
      const token = await fetchToken(
        new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: state.callbackUrl,
          scope: formatScopes(state.scopes),
          code_verifier: state.codeVerifier,
        }),
      );
      const auth = toAuth(token);

      const meResponse = await fetch(
        `${graphBase}/me?$select=id,displayName,mail,userPrincipalName`,
        {
          method: "GET",
          headers: {
            Authorization: `${auth.tokenType || "Bearer"} ${auth.accessToken}`,
          },
        },
      );
      const meBody = await readJsonResponse(meResponse);
      if (!meResponse.ok) {
        throw new EmailKitError(
          microsoftErrorMessage(meBody, "Microsoft Graph /me request failed"),
          PROVIDER,
          undefined,
          meResponse.status,
          undefined,
          meBody,
        );
      }

      const user = meBody as MicrosoftUserResponse;
      const email = user.mail || user.userPrincipalName || state.email;
      if (!user.id || !email) {
        throw new EmailKitError(
          "Microsoft Graph /me response did not include a usable mailbox id/email",
          PROVIDER,
          "INVALID_ME_RESPONSE",
          undefined,
          undefined,
          meBody,
        );
      }

      const mailbox: Mailbox = {
        id: user.id,
        email,
        displayName: user.displayName,
        status: "connected",
        raw: user,
      };
      const autoSubscribeWebhookUrl =
        state.webhookUrl || resolvePublicWebhookUrl(options);
      const webhookSetup = config.autoSubscribeInbound
        ? await setupMailboxWebhook(
            {
              mailbox,
              auth,
              ...(autoSubscribeWebhookUrl
                ? { url: autoSubscribeWebhookUrl }
                : {}),
              events: ["inbound"],
              ...(state.lifecycleNotificationUrl
                ? {
                    provider: {
                      lifecycleNotificationUrl: state.lifecycleNotificationUrl,
                    },
                  }
                : {}),
              context: state.context,
            },
            { ...options, context: state.context },
          )
        : undefined;
      const inboundSubscription = (
        webhookSetup?.raw as
          | { inboundSubscription?: OutlookInboundSubscription }
          | undefined
      )?.inboundSubscription;
      if (inboundSubscription) {
        mailbox.raw = {
          user,
          inboundSubscription,
          webhook: webhookSetup?.webhook,
        };
      }

      return {
        mailbox,
        auth,
        ...(webhookSetup?.webhook ? { webhooks: [webhookSetup.webhook] } : {}),
        context: state.context,
        raw: {
          token: sanitizeTokenResponse(token),
          user,
          ...(inboundSubscription
            ? { inboundSubscription, webhook: webhookSetup?.webhook }
            : {}),
        },
      };
    },

    mailboxes: {
      connect: async (
        input = {},
        options,
      ): Promise<MailboxConnectionResult> => {
        const secret = requireSecret(options?.secret, "mailbox connect");
        const callbackUrl = resolveMailboxConnectCallbackUrl(input, options);
        const webhookUrl = resolvePublicWebhookUrl(options);
        const lifecycleNotificationUrl = resolveLifecycleNotificationUrl(
          webhookUrl || "",
          input.provider,
          options,
          false,
        );
        const requestedScopes = scopesForMailboxConnect(
          input.scopes && input.scopes.length > 0
            ? input.scopes
            : mailboxScopes,
          config,
        );
        const codeVerifier = createCodeVerifier();
        const codeChallenge = createCodeChallenge(codeVerifier);
        const state = encodeState(
          {
            v: STATE_VERSION,
            provider: PROVIDER,
            nonce: randomBytes(16).toString("hex"),
            issuedAt: Date.now(),
            callbackUrl,
            ...(webhookUrl ? { webhookUrl } : {}),
            ...(lifecycleNotificationUrl ? { lifecycleNotificationUrl } : {}),
            scopes: requestedScopes,
            codeVerifier,
            email: input.email,
            context: input.context,
          },
          secret,
        );

        const authorizationUrl = new URL(
          `${authBase}/${tenant}/oauth2/v2.0/authorize`,
        );
        authorizationUrl.searchParams.set("client_id", config.clientId);
        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
        authorizationUrl.searchParams.set("response_mode", "query");
        authorizationUrl.searchParams.set(
          "scope",
          formatScopes(requestedScopes),
        );
        authorizationUrl.searchParams.set("state", state);
        authorizationUrl.searchParams.set("code_challenge", codeChallenge);
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
        if (input.email) {
          authorizationUrl.searchParams.set("login_hint", input.email);
        }

        return {
          redirectUrl: authorizationUrl.toString(),
          state,
          context: input.context,
        };
      },
    },

    webhooks: {
      mailbox: {
        setup: setupMailboxWebhook,

        refresh: async (
          input: MailboxWebhookRefreshInput,
          options?: EmailDriverOperationOptions,
        ): Promise<MailboxWebhookRefreshResult> => {
          const auth = await resolveMailboxWebhookAuth(input, options);
          const id = webhookSubscriptionId(input);
          const inboundSubscription = await refreshInboundSubscription(
            auth,
            id,
            input.provider,
          );
          const url =
            inboundSubscription.notificationUrl ||
            input.webhook?.url ||
            resolvePublicWebhookUrl(options);
          if (!url) {
            throw new EmailKitError(
              "Outlook mailbox webhook refresh requires an existing webhook url or Microsoft Graph notificationUrl",
              PROVIDER,
              "MISSING_WEBHOOK_URL",
            );
          }
          const webhook = normalizeInboundSubscription(inboundSubscription, {
            driverId,
            url,
            events: input.webhook?.events,
          });

          return {
            webhook,
            context: input.context ?? options?.context,
            raw: {
              inboundSubscription,
            },
          };
        },

        delete: async (
          input: MailboxWebhookDeleteInput,
          options?: EmailDriverOperationOptions,
        ): Promise<MailboxWebhookDeleteResult> => {
          const auth = await resolveMailboxWebhookAuth(input, options);
          const id = webhookSubscriptionId(input);
          const result = await deleteInboundSubscription(auth, id);
          const existingWebhook = input.webhook;
          const url = existingWebhook?.url || resolvePublicWebhookUrl(options);
          if (!url) {
            throw new EmailKitError(
              "Outlook mailbox webhook delete requires an existing webhook url",
              PROVIDER,
              "MISSING_WEBHOOK_URL",
            );
          }

          return {
            deleted: result.deleted,
            webhook: {
              id: existingWebhook?.id || id,
              emailDriver: driverId,
              scope: "mailbox",
              url,
              events: existingWebhook?.events,
              status: "deleted",
              providerId: existingWebhook?.providerId || id,
              raw: existingWebhook?.raw,
            },
            context: input.context ?? options?.context,
            raw: result.raw,
          };
        },
      },
    },
  };
};

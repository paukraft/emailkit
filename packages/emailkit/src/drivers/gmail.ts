/**
 * Gmail email driver.
 *
 * Implements delegated mailbox OAuth, raw MIME sending, and Cloud Pub/Sub
 * push-based inbound mail through the Gmail API.
 * Documentation:
 * - https://developers.google.com/identity/protocols/oauth2/web-server
 * - https://developers.google.com/gmail/api/guides/push
 * - https://developers.google.com/gmail/api/reference/rest
 *
 * Provider quirks absorbed by this driver so the EmailKit API stays uniform:
 * - Sending requires a raw RFC 2822 message; the driver builds the MIME
 *   itself, which is also why Gmail supports full reply headers and custom
 *   headers (`replyHeaders` capability, unlike Microsoft Graph).
 * - Inbound push notifications only carry `{ emailAddress, historyId }`.
 *   Hydration needs the mailbox's previous history cursor, which this driver
 *   keeps on the auth blob (`GmailMailboxAuth.historyId`) so apps persist it
 *   through the same `onAuthUpdated` channel they already use for token
 *   refresh. A missing or expired cursor degrades to a `sync_required`
 *   lifecycle event, never a crash.
 * - Gmail watches expire after ~7 days and Gmail sends no lifecycle
 *   warnings. The driver re-watches opportunistically while handling
 *   notifications (active mailboxes never expire) and reports `renewAfter`
 *   on the Webhook object so idle mailboxes can be refreshed on schedule.
 */

import { randomUUID } from "crypto";
import type {
  EmailDriver,
  EmailDriverConfig,
  EmailDriverOperationOptions,
  ProviderFetchInit,
  SendEmailOptions,
  SyncStream,
} from "../driver";
import type {
  Attachment,
  DriverCapabilities,
  EmailMessage,
  InboundEmailEvent,
  Mailbox,
  MailboxConnectionResult,
  MailboxIdentity,
  MailboxSyncInput,
  MailboxWebhookDeleteInput,
  MailboxWebhookDeleteResult,
  MailboxWebhookRefreshInput,
  MailboxWebhookRefreshResult,
  MailboxWebhookSetupInput,
  MailboxWebhookSetupResult,
  SendEmailResult,
  Webhook,
  WebhookDriverEvent,
  WebhookEventResult,
  WebhookLifecycleDriverEvent,
  WebhookRequest,
  WebhookResponse,
} from "../types";
import { EmailKitError } from "../types";
import { base64UrlToBytes, base64UrlToString, stringToBase64Url } from "../utils/base64";
import { buildMimeMessage, parseAddressListHeader } from "../utils/mime";
import {
  OAUTH_STATE_VERSION,
  createCodeChallenge,
  createCodeVerifier,
  createStateNonce,
  decodeOAuthState,
  encodeOAuthState,
  type OAuthStatePayload,
} from "../utils/oauth-state";
import {
  buildReplyContext,
  hasReplyData,
  replyAddressesAsArray,
  resolveMessageReplyContext,
} from "../utils/reply";

export interface GmailDriverConfig<TId extends string = "gmail">
  extends EmailDriverConfig {
  /**
   * EmailKit driver id. Override when configuring multiple Gmail drivers.
   */
  id?: TId;
  clientId: string;
  clientSecret: string;
  /**
   * Cloud Pub/Sub topic Gmail publishes watch notifications to, e.g.
   * "projects/my-project/topics/emailkit-gmail". Required for inbound
   * webhooks; sending and sync work without it. The topic must grant
   * gmail-api-push@system.gserviceaccount.com the Pub/Sub Publisher role and
   * have a push subscription pointing at the EmailKit webhook route.
   */
  pubsubTopic?: string;
  scopes?: string[];
  /**
   * Gmail label ids that count as inbound. Used as the watch filter and to
   * scope history/sync listings. Defaults to ["INBOX"].
   */
  labelIds?: string[];
  /**
   * Optional Google authorization endpoint.
   * Defaults to https://accounts.google.com/o/oauth2/v2/auth.
   */
  authorizationEndpoint?: string;
  /**
   * Optional Google token endpoint.
   * Defaults to https://oauth2.googleapis.com/token.
   */
  tokenEndpoint?: string;
  /**
   * Optional Gmail API base URL.
   * Defaults to https://gmail.googleapis.com/gmail/v1.
   */
  gmailBase?: string;
  /**
   * Start a Gmail watch immediately after a mailbox is connected. Requires
   * pubsubTopic. Defaults to false.
   */
  autoSubscribeInbound?: boolean;
  /**
   * Re-watch opportunistically while handling push notifications when the
   * watch expiration (tracked on auth.watchExpiresAt) is near. Emits a
   * webhook.lifecycle "updated" event so apps can persist the new expiry.
   * Defaults to true.
   */
  autoRenewOnNotification?: boolean;
  /**
   * Shared token(s) expected as a `?token=` query parameter on the Pub/Sub
   * push endpoint URL. Configure the push subscription endpoint as
   * `https://app.example.com/api/email/gmail?token=<value>` and set the same
   * value here to reject forged notifications. Enforced only when set,
   * because the push subscription is provisioned outside this driver.
   */
  verificationToken?: string | string[];
  /**
   * Mailbox auth used to hydrate Gmail push notifications. Notifications only
   * include the mailbox email and new history id, so inbound normalization
   * requires an access token with gmail.readonly scope.
   */
  webhookAuth?: GmailMailboxAuth;
  /**
   * Resolve mailbox auth for a specific notification. Use this when one
   * webhook endpoint receives notifications for multiple mailboxes.
   */
  webhookAuthResolver?: GmailWebhookAuthResolver;
  /**
   * Persistence callback for auth material updated outside facade operations
   * (webhook hydration refreshes tokens, advances the history cursor, and
   * renews watches). Mirrors the per-operation onAuthUpdated option; wire it
   * to the same store.
   */
  onAuthUpdated?: (event: GmailAuthUpdate) => Promise<void> | void;
}

export interface GmailMailboxAuth {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  tokenType?: string;
  /**
   * Gmail history cursor used to hydrate push notifications. Seeded on
   * connect/watch and advanced through onAuthUpdated as notifications are
   * processed. When absent or expired the driver emits a sync_required
   * lifecycle event instead of inbound events.
   */
  historyId?: string;
  /**
   * Expiration (epoch ms) of the active Gmail watch, used for opportunistic
   * renewal during notification handling.
   */
  watchExpiresAt?: number;
}

export interface GmailAuthUpdate {
  auth: GmailMailboxAuth;
  previousAuth?: GmailMailboxAuth;
  mailbox?: MailboxIdentity | Mailbox;
  context?: unknown;
  raw?: unknown;
}

export interface GmailWatch {
  historyId?: string;
  /** Epoch ms watch expiration. */
  expiration?: number;
  topicName: string;
  labelIds: string[];
  raw?: unknown;
}

export interface GmailSendEmailResult extends SendEmailResult {
  raw?: {
    send?: unknown;
    threadLookup?: unknown;
    sentMessageLookup?: unknown;
  };
}

export interface GmailCapabilities extends DriverCapabilities {
  cc: true;
  bcc: true;
  replyTo: true;
  replyHeaders: true;
  replyThreadId: true;
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
  sync: {
    mailbox: true;
  };
  publicRoutes: {
    webhook: true;
    connectCallback: true;
    connectLanding: true;
  };
}

export const GMAIL_CAPABILITIES = {
  cc: true,
  bcc: true,
  replyTo: true,
  replyHeaders: true,
  replyThreadId: true,
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
  sync: {
    mailbox: true,
  },
  publicRoutes: {
    webhook: true,
    connectCallback: true,
    connectLanding: true,
  },
} as const satisfies GmailCapabilities;

const PROVIDER = "gmail";
const DEFAULT_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const DEFAULT_GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];
const DEFAULT_LABEL_IDS = ["INBOX"];
const TOKEN_REFRESH_LEEWAY_MS = 60_000;
const WATCH_RENEWAL_BUFFER_MS = 24 * 60 * 60 * 1000;
const HISTORY_PAGE_SIZE = 500;
const SYNC_PAGE_SIZE = 100;

interface GmailStatePayload extends OAuthStatePayload {
  provider: typeof PROVIDER;
  webhookUrl?: string;
}

type GmailPublicRoutes = NonNullable<
  EmailDriverOperationOptions["publicRoutes"]
> & {
  callback?: {
    url?: unknown;
    callbackUrl?: unknown;
  };
  webhook?: {
    url?: unknown;
  };
};

interface GmailPublicRouteOptions {
  callbackUrl?: unknown;
  publicRoutes?: GmailPublicRoutes;
}

interface GoogleTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
  [key: string]: unknown;
}

interface GmailProfileResponse {
  emailAddress?: string;
  messagesTotal?: number;
  threadsTotal?: number;
  historyId?: string;
  [key: string]: unknown;
}

interface GmailWatchResponse {
  historyId?: string;
  expiration?: string;
  [key: string]: unknown;
}

interface PubSubPushPayload {
  message: {
    data?: string;
    messageId?: string;
    publishTime?: string;
    attributes?: Record<string, string>;
    [key: string]: unknown;
  };
  subscription?: string;
  [key: string]: unknown;
}

export interface GmailNotification {
  emailAddress: string;
  historyId?: string;
}

export interface GmailWebhookAuthResolverContext {
  notification?: GmailNotification;
  payload?: PubSubPushPayload;
  request?: WebhookRequest;
  query?: Record<string, string>;
  mailboxEmail?: string;
  mailboxId?: string;
  messageId?: string;
}

export type GmailWebhookAuthResolver = (
  context: GmailWebhookAuthResolverContext,
) =>
  | GmailMailboxAuth
  | undefined
  | null
  | Promise<GmailMailboxAuth | undefined | null>;

interface GmailMessagePartBody {
  attachmentId?: string;
  size?: number;
  data?: string;
  [key: string]: unknown;
}

interface GmailMessagePart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: GmailMessagePartBody;
  parts?: GmailMessagePart[];
  [key: string]: unknown;
}

interface GmailMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
  [key: string]: unknown;
}

interface GmailHistoryMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  [key: string]: unknown;
}

interface GmailHistoryRecord {
  id?: string;
  messagesAdded?: Array<{ message?: GmailHistoryMessage }>;
  [key: string]: unknown;
}

interface GmailHistoryListResponse {
  history?: GmailHistoryRecord[];
  nextPageToken?: string;
  historyId?: string;
  [key: string]: unknown;
}

interface GmailMessageListResponse {
  messages?: Array<{ id?: string; threadId?: string }>;
  nextPageToken?: string;
  [key: string]: unknown;
}

interface GmailAttachmentProviderMetadata {
  mailboxEmail?: string;
  mailboxId?: string;
  messageId?: string;
  attachmentId?: string;
}

const requireSecret = (
  secret: string | undefined,
  operation: string,
): string => {
  if (!secret) {
    throw new EmailKitError(
      `EmailKit secret is required for Gmail ${operation}`,
      PROVIDER,
      "MISSING_SECRET",
    );
  }
  return secret;
};

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const gmailRouteOptions = (
  options?: EmailDriverOperationOptions,
): GmailPublicRouteOptions =>
  (options || {}) as EmailDriverOperationOptions & GmailPublicRouteOptions;

const resolveMailboxConnectCallbackUrl = (
  input: { provider?: Record<string, unknown> },
  options?: EmailDriverOperationOptions,
): string => {
  const routeOptions = gmailRouteOptions(options);
  const callbackUrl =
    nonEmptyString((input as { callbackUrl?: unknown }).callbackUrl) ||
    nonEmptyString(routeOptions.callbackUrl) ||
    nonEmptyString(routeOptions.publicRoutes?.connectCallbackUrl) ||
    nonEmptyString(routeOptions.publicRoutes?.callback?.callbackUrl) ||
    nonEmptyString(routeOptions.publicRoutes?.callback?.url);

  if (!callbackUrl) {
    throw new EmailKitError(
      "Gmail mailbox connect requires callbackUrl from EmailKit public routes",
      PROVIDER,
      "MISSING_CALLBACK_URL",
    );
  }

  return callbackUrl;
};

const resolvePublicWebhookUrl = (
  options?: EmailDriverOperationOptions,
): string | undefined =>
  nonEmptyString(gmailRouteOptions(options).publicRoutes?.webhookUrl) ||
  nonEmptyString(gmailRouteOptions(options).publicRoutes?.webhook?.url);

const normalizeBaseUrl = (url: string): string => url.replace(/\/+$/, "");

const formatScopes = (scopes: string[]): string => scopes.join(" ");

const uniqueScopes = (scopes: string[]): string[] => {
  const seen = new Set<string>();
  return scopes.filter((scope) => {
    if (seen.has(scope)) return false;
    seen.add(scope);
    return true;
  });
};

const normalizeHistoryId = (value: unknown): string | undefined => {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }
  return undefined;
};

const maxHistoryId = (
  ...values: Array<string | undefined>
): string | undefined => {
  let max: string | undefined;
  for (const value of values) {
    const normalized = normalizeHistoryId(value);
    if (!normalized) continue;
    if (max === undefined || BigInt(normalized) > BigInt(max)) {
      max = normalized;
    }
  }
  return max;
};

// Gmail returns some 204s (e.g. users.stop) with a JSON content-type but an
// empty body, so parse from text instead of trusting the header.
const readJsonResponse = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (!text) return undefined;
  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
};

const googleErrorMessage = (body: unknown, fallback: string): string => {
  if (typeof body === "object" && body !== null) {
    const record = body as Record<string, unknown>;
    const googleError = record.error;
    if (typeof googleError === "object" && googleError !== null) {
      const message = (googleError as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof googleError === "string" && googleError) {
      const description = record.error_description;
      return typeof description === "string" && description
        ? `${googleError}: ${description}`
        : googleError;
    }
    if (typeof record.message === "string") return record.message;
  }
  if (typeof body === "string" && body) return body;
  return fallback;
};

const sanitizeTokenResponse = (token: GoogleTokenResponse) => ({
  expiresIn: token.expires_in,
  scopes:
    typeof token.scope === "string"
      ? token.scope.split(/\s+/).filter(Boolean)
      : undefined,
  tokenType: token.token_type,
});

const toAuth = (
  token: GoogleTokenResponse,
  previous?: GmailMailboxAuth,
): GmailMailboxAuth => {
  if (!token.access_token) {
    throw new EmailKitError(
      "Google token response did not include an access token",
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
    ...(previous?.historyId ? { historyId: previous.historyId } : {}),
    ...(previous?.watchExpiresAt
      ? { watchExpiresAt: previous.watchExpiresAt }
      : {}),
  };
};

const isGmailAuth = (auth: unknown): auth is GmailMailboxAuth =>
  typeof auth === "object" &&
  auth !== null &&
  typeof (auth as GmailMailboxAuth).accessToken === "string";

const authsEqual = (a: GmailMailboxAuth, b: GmailMailboxAuth): boolean =>
  a.accessToken === b.accessToken &&
  a.refreshToken === b.refreshToken &&
  a.expiresAt === b.expiresAt &&
  a.historyId === b.historyId &&
  a.watchExpiresAt === b.watchExpiresAt;

const webhookVerificationTokens = (
  config: GmailDriverConfig<string>,
): string[] => {
  if (Array.isArray(config.verificationToken)) return config.verificationToken;
  if (config.verificationToken) return [config.verificationToken];
  return [];
};

const verifyWebhookToken = (
  config: GmailDriverConfig<string>,
  request: WebhookRequest,
): boolean => {
  const allowed = webhookVerificationTokens(config);
  if (allowed.length === 0) return true;

  const token = request.query?.token;
  return Boolean(token && allowed.includes(token));
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

const isPubSubPayload = (payload: unknown): payload is PubSubPushPayload =>
  typeof payload === "object" &&
  payload !== null &&
  typeof (payload as PubSubPushPayload).message === "object" &&
  (payload as PubSubPushPayload).message !== null &&
  typeof (payload as PubSubPushPayload).message.data === "string";

const decodeNotification = (
  payload: PubSubPushPayload,
): GmailNotification | undefined => {
  try {
    const decoded = JSON.parse(base64UrlToString(payload.message.data || ""));
    const emailAddress = nonEmptyString(
      (decoded as { emailAddress?: unknown }).emailAddress,
    );
    if (!emailAddress) return undefined;
    return {
      emailAddress,
      historyId: normalizeHistoryId(
        (decoded as { historyId?: unknown }).historyId,
      ),
    };
  } catch {
    return undefined;
  }
};

const webhookAuthFromConfig = async (
  config: GmailDriverConfig<string>,
  context: GmailWebhookAuthResolverContext,
): Promise<GmailMailboxAuth | undefined> => {
  if (config.webhookAuthResolver) {
    const resolved = await config.webhookAuthResolver(context);
    if (isGmailAuth(resolved)) return resolved;
  }
  if (isGmailAuth(config.webhookAuth)) return config.webhookAuth;
  return undefined;
};

const watchRenewAfter = (expiresAt: Date | undefined): Date | undefined => {
  const expiresTime = expiresAt?.getTime();
  if (!expiresTime || Number.isNaN(expiresTime)) return undefined;

  const remainingMs = expiresTime - Date.now();
  if (remainingMs <= 1) return new Date(expiresTime - 1);

  const bufferMs = Math.min(
    WATCH_RENEWAL_BUFFER_MS,
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

const normalizeWatch = (
  watch: GmailWatch,
  input: {
    driverId: string;
    mailboxEmail?: string;
    url?: string;
    events?: Webhook["events"];
  },
): Webhook => {
  const expiresAt =
    typeof watch.expiration === "number" && watch.expiration > 0
      ? new Date(watch.expiration)
      : undefined;
  const id = `watch:${input.mailboxEmail || "me"}`;

  return {
    id,
    emailDriver: input.driverId,
    scope: "mailbox",
    url: input.url || `pubsub:${watch.topicName}`,
    events: input.events,
    status: "active",
    providerId: id,
    expiresAt,
    renewAfter: watchRenewAfter(expiresAt),
    provider: {
      topicName: watch.topicName,
      labelIds: watch.labelIds,
    },
    raw: watch.raw || watch,
  };
};

const gmailProviderMetadata = (
  provider: Record<string, unknown> | undefined,
): GmailAttachmentProviderMetadata | undefined => {
  const gmail = provider?.gmail;
  if (!gmail || typeof gmail !== "object") return undefined;
  return gmail as GmailAttachmentProviderMetadata;
};

const headersToMap = (
  headers: GmailMessagePart["headers"],
): Record<string, string> => {
  const normalized: Record<string, string> = {};
  for (const header of headers || []) {
    if (header.name && typeof header.value === "string") {
      normalized[header.name.toLowerCase()] = header.value;
    }
  }
  return normalized;
};

const collectLeafParts = (
  part: GmailMessagePart | undefined,
  out: GmailMessagePart[],
): void => {
  if (!part) return;
  if (part.parts && part.parts.length > 0) {
    for (const child of part.parts) collectLeafParts(child, out);
    return;
  }
  out.push(part);
};

const decodePartText = (part: GmailMessagePart): string | undefined => {
  const data = part.body?.data;
  if (typeof data !== "string" || !data) return undefined;
  try {
    return base64UrlToString(data);
  } catch {
    return undefined;
  }
};

const isBodyPart = (part: GmailMessagePart, mimeType: string): boolean =>
  !part.filename &&
  !part.body?.attachmentId &&
  (part.mimeType || "").toLowerCase().startsWith(mimeType);

const contentIdFromHeaders = (
  headers: Record<string, string>,
): string | undefined => {
  const raw = headers["content-id"];
  if (!raw) return undefined;
  return raw.trim().replace(/^</, "").replace(/>$/, "") || undefined;
};

const addNormalizedMailboxEmail = (
  emails: Set<string>,
  value: unknown,
): void => {
  if (typeof value === "string" && value.trim()) {
    emails.add(value.trim().toLowerCase());
  }
};

const normalizedMailboxEmails = (input: MailboxSyncInput): Set<string> => {
  const emails = new Set<string>();
  addNormalizedMailboxEmail(emails, input.email);
  if (
    input.mailbox &&
    typeof input.mailbox === "object" &&
    !Array.isArray(input.mailbox)
  ) {
    addNormalizedMailboxEmail(emails, input.mailbox.email);
  }
  return emails;
};

const mailboxProviderMetadata = (
  input: MailboxSyncInput,
): Pick<GmailAttachmentProviderMetadata, "mailboxEmail" | "mailboxId"> => {
  const mailbox =
    input.mailbox &&
    typeof input.mailbox === "object" &&
    !Array.isArray(input.mailbox)
      ? input.mailbox
      : undefined;
  return {
    mailboxEmail: nonEmptyString(input.email) || nonEmptyString(mailbox?.email),
    mailboxId: nonEmptyString(input.mailboxId) || nonEmptyString(mailbox?.id),
  };
};

export const GmailDriver = <const TId extends string = "gmail">(
  config: GmailDriverConfig<TId>,
): EmailDriver<GmailDriverConfig<TId>, typeof GMAIL_CAPABILITIES, TId> => {
  const driverId = (config.id || "gmail") as TId;
  const authorizationEndpoint =
    config.authorizationEndpoint || DEFAULT_AUTHORIZATION_ENDPOINT;
  const tokenEndpoint = config.tokenEndpoint || DEFAULT_TOKEN_ENDPOINT;
  const gmailBase = normalizeBaseUrl(config.gmailBase || DEFAULT_GMAIL_BASE);
  const scopes =
    config.scopes && config.scopes.length > 0
      ? uniqueScopes(config.scopes)
      : DEFAULT_SCOPES;
  const labelIds =
    config.labelIds && config.labelIds.length > 0
      ? config.labelIds
      : DEFAULT_LABEL_IDS;

  const requirePubSubTopic = (operation: string): string => {
    const topic = nonEmptyString(config.pubsubTopic);
    if (!topic) {
      throw new EmailKitError(
        `Gmail ${operation} requires the pubsubTopic driver option (a Cloud Pub/Sub topic Gmail can publish to)`,
        PROVIDER,
        "MISSING_PUBSUB_TOPIC",
      );
    }
    return topic;
  };

  const fetchToken = async (
    form: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<GoogleTokenResponse> => {
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal,
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      throw new EmailKitError(
        googleErrorMessage(body, "Google token request failed"),
        PROVIDER,
        undefined,
        response.status,
        undefined,
        body,
      );
    }
    return body as GoogleTokenResponse;
  };

  const refreshAuth = async (
    auth: GmailMailboxAuth,
    signal?: AbortSignal,
  ): Promise<GmailMailboxAuth> => {
    if (!auth.refreshToken) {
      throw new EmailKitError(
        "Gmail access token is expired and no refresh token was provided",
        PROVIDER,
        "MISSING_REFRESH_TOKEN",
      );
    }

    const form = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
      refresh_token: auth.refreshToken,
    });
    const token = await fetchToken(form, signal);
    return toAuth(token, auth);
  };

  const authorization = (auth: GmailMailboxAuth): string =>
    `${auth.tokenType || "Bearer"} ${auth.accessToken}`;

  const gmailFetch = async (
    auth: GmailMailboxAuth,
    path: string,
    init?: {
      method?: string;
      body?: unknown;
      searchParams?: Record<string, string | string[] | undefined>;
      signal?: AbortSignal;
    },
    fallbackError = "Gmail API request failed",
  ): Promise<unknown> => {
    const url = new URL(`${gmailBase}/${path.replace(/^\/+/, "")}`);
    for (const [key, value] of Object.entries(init?.searchParams || {})) {
      if (value === undefined) continue;
      for (const entry of Array.isArray(value) ? value : [value]) {
        url.searchParams.append(key, entry);
      }
    }

    const response = await fetch(url, {
      method: init?.method || "GET",
      headers: {
        Authorization: authorization(auth),
        Accept: "application/json",
        ...(init?.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: init?.signal,
    });
    const body = await readJsonResponse(response);
    if (!response.ok) {
      throw new EmailKitError(
        googleErrorMessage(body, fallbackError),
        PROVIDER,
        undefined,
        response.status,
        undefined,
        body,
      );
    }
    return body;
  };

  const getProfile = async (
    auth: GmailMailboxAuth,
    signal?: AbortSignal,
  ): Promise<GmailProfileResponse> =>
    (await gmailFetch(
      auth,
      "users/me/profile",
      { signal },
      "Gmail profile request failed",
    )) as GmailProfileResponse;

  const startWatch = async (
    auth: GmailMailboxAuth,
    input?: {
      topicName?: string;
      labelIds?: string[];
      signal?: AbortSignal;
    },
  ): Promise<GmailWatch> => {
    const topicName = input?.topicName || requirePubSubTopic("watch");
    const watchLabelIds =
      input?.labelIds && input.labelIds.length > 0 ? input.labelIds : labelIds;
    const body = (await gmailFetch(
      auth,
      "users/me/watch",
      {
        method: "POST",
        body: {
          topicName,
          labelIds: watchLabelIds,
          labelFilterBehavior: "INCLUDE",
        },
        signal: input?.signal,
      },
      "Gmail watch request failed",
    )) as GmailWatchResponse;

    const expiration = Number(body.expiration);
    return {
      historyId: normalizeHistoryId(body.historyId),
      expiration:
        Number.isFinite(expiration) && expiration > 0 ? expiration : undefined,
      topicName,
      labelIds: watchLabelIds,
      raw: body,
    };
  };

  const stopWatch = async (
    auth: GmailMailboxAuth,
    signal?: AbortSignal,
  ): Promise<unknown> =>
    gmailFetch(
      auth,
      "users/me/stop",
      { method: "POST", body: {}, signal },
      "Gmail watch stop request failed",
    );

  const resolveMailboxOperationAuth = async (
    operation: string,
    input: { auth?: unknown; mailbox?: MailboxIdentity | Mailbox },
    options?: EmailDriverOperationOptions,
    signal?: AbortSignal,
  ): Promise<GmailMailboxAuth> => {
    const inputAuth = isGmailAuth(input.auth) ? input.auth : undefined;
    const optionsAuth = isGmailAuth(options?.auth) ? options.auth : undefined;
    let auth = inputAuth || optionsAuth;
    if (!auth) {
      throw new EmailKitError(
        `Gmail ${operation} requires mailbox auth with an accessToken`,
        PROVIDER,
        "MISSING_AUTH",
      );
    }

    if (
      typeof auth.expiresAt === "number" &&
      auth.expiresAt <= Date.now() + TOKEN_REFRESH_LEEWAY_MS
    ) {
      const previousAuth = auth;
      auth = await refreshAuth(auth, signal);
      await options?.onAuthUpdated?.({
        auth,
        previousAuth,
        mailbox: "mailbox" in input ? input.mailbox : options?.mailbox,
        context: options?.context,
      });
    }

    return auth;
  };

  const lookupThreadId = async (
    auth: GmailMailboxAuth,
    replyMessageId: string,
    signal?: AbortSignal,
  ): Promise<{ threadId?: string; raw: unknown }> => {
    const rfcId = replyMessageId.trim().replace(/^</, "").replace(/>$/, "");
    const body = (await gmailFetch(
      auth,
      "users/me/messages",
      {
        searchParams: {
          q: `rfc822msgid:${rfcId}`,
          maxResults: "1",
        },
        signal,
      },
      "Gmail reply source message lookup failed",
    )) as GmailMessageListResponse;

    return { threadId: body.messages?.[0]?.threadId, raw: body };
  };

  const getMessage = async (
    auth: GmailMailboxAuth,
    messageId: string,
    signal?: AbortSignal,
  ): Promise<GmailMessage> =>
    (await gmailFetch(
      auth,
      `users/me/messages/${encodeURIComponent(messageId)}`,
      { searchParams: { format: "full" }, signal },
      "Gmail message fetch failed",
    )) as GmailMessage;

  const transformGmailMessage = (
    message: GmailMessage,
    input: {
      eventId?: string;
      notification?: GmailNotification;
      attachmentProvider?: GmailAttachmentProviderMetadata;
    },
  ): InboundEmailEvent => {
    const headers = headersToMap(message.payload?.headers);
    const leaves: GmailMessagePart[] = [];
    collectLeafParts(message.payload, leaves);

    const textLeaf = leaves.find((part) => isBodyPart(part, "text/plain"));
    const htmlLeaf = leaves.find((part) => isBodyPart(part, "text/html"));
    const attachments = leaves
      .filter(
        (part) =>
          part !== textLeaf &&
          part !== htmlLeaf &&
          (part.filename || part.body?.attachmentId),
      )
      .map((part, index): Attachment => {
        const partHeaders = headersToMap(part.headers);
        const contentId = contentIdFromHeaders(partHeaders);
        const disposition = partHeaders["content-disposition"] || "";
        const attachmentId = part.body?.attachmentId;
        const inlineData =
          typeof part.body?.data === "string" && part.body.data
            ? base64UrlToBytes(part.body.data)
            : undefined;

        return {
          filename: part.filename || `attachment-${index + 1}`,
          contentType: part.mimeType || undefined,
          size: part.body?.size,
          contentId,
          isInline: disposition.toLowerCase().startsWith("inline") || undefined,
          ...(inlineData ? { content: inlineData } : {}),
          ...(attachmentId && message.id
            ? {
                url: `${gmailBase}/users/me/messages/${encodeURIComponent(
                  message.id,
                )}/attachments/${encodeURIComponent(attachmentId)}`,
              }
            : {}),
          provider: {
            gmail: {
              ...(input.attachmentProvider || {}),
              ...(input.notification?.emailAddress
                ? { mailboxEmail: input.notification.emailAddress }
                : {}),
              ...(message.id ? { messageId: message.id } : {}),
              ...(attachmentId ? { attachmentId } : {}),
            },
          },
        };
      });

    const internalDate = Number(message.internalDate);
    const timestamp =
      Number.isFinite(internalDate) && internalDate > 0
        ? new Date(internalDate)
        : headers.date
          ? new Date(headers.date)
          : new Date();

    return {
      schemaVersion: "1",
      eventId: input.eventId,
      messageId: headers["message-id"] || message.id || "",
      providerId: message.id,
      from: parseAddressListHeader(headers.from)[0] || { email: "" },
      to: parseAddressListHeader(headers.to),
      cc: parseAddressListHeader(headers.cc),
      bcc: parseAddressListHeader(headers.bcc),
      reply: buildReplyContext({
        addresses: parseAddressListHeader(headers["reply-to"]),
        messageId: headers["in-reply-to"],
        references: headers.references,
        threadId: message.threadId,
      }),
      subject: headers.subject || "",
      text: textLeaf ? decodePartText(textLeaf) : undefined,
      html: htmlLeaf ? decodePartText(htmlLeaf) : undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      headers,
      timestamp,
      raw: {
        ...(input.notification ? { notification: input.notification } : {}),
        message,
      },
    };
  };

  const matchesConfiguredLabels = (
    messageLabelIds: string[] | undefined,
  ): boolean => {
    if (labelIds.length === 0) return true;
    if (!messageLabelIds) return false;
    return labelIds.some((label) => messageLabelIds.includes(label));
  };

  const listHistoryMessageIds = async (
    auth: GmailMailboxAuth,
    startHistoryId: string,
    signal?: AbortSignal,
  ): Promise<{ messageIds: string[]; historyId?: string }> => {
    const messageIds: string[] = [];
    const seen = new Set<string>();
    let latestHistoryId: string | undefined;
    let pageToken: string | undefined;

    do {
      const body = (await gmailFetch(
        auth,
        "users/me/history",
        {
          searchParams: {
            startHistoryId,
            historyTypes: "messageAdded",
            maxResults: String(HISTORY_PAGE_SIZE),
            ...(labelIds.length === 1 ? { labelId: labelIds[0] } : {}),
            ...(pageToken ? { pageToken } : {}),
          },
          signal,
        },
        "Gmail history listing failed",
      )) as GmailHistoryListResponse;

      latestHistoryId = maxHistoryId(latestHistoryId, body.historyId);
      for (const record of body.history || []) {
        for (const added of record.messagesAdded || []) {
          const message = added.message;
          if (!message?.id || seen.has(message.id)) continue;
          if (
            labelIds.length !== 1 &&
            !matchesConfiguredLabels(message.labelIds)
          ) {
            continue;
          }
          seen.add(message.id);
          messageIds.push(message.id);
        }
      }
      pageToken = body.nextPageToken;
    } while (pageToken);

    return { messageIds, historyId: latestHistoryId };
  };

  const syncRequiredEvent = (
    notification: GmailNotification,
    reason: "history_gap" | "notifications_missed",
    raw: unknown,
  ): WebhookLifecycleDriverEvent => ({
    type: "webhook.lifecycle",
    data: {
      emailDriver: driverId,
      action: "sync_required",
      source: "provider",
      reason,
      recommendedActions: ["sync"],
      scope: "mailbox",
      target: { mailboxEmail: notification.emailAddress },
      receivedAt: new Date(),
      raw,
    },
  });

  const resolveProviderFetchAuth = async (
    init?: ProviderFetchInit,
  ): Promise<GmailMailboxAuth | undefined> => {
    const metadata = gmailProviderMetadata(init?.provider);
    if (metadata?.mailboxEmail || metadata?.mailboxId || metadata?.messageId) {
      const resolved = await webhookAuthFromConfig(config, {
        mailboxEmail: metadata.mailboxEmail,
        mailboxId: metadata.mailboxId,
        messageId: metadata.messageId,
      });
      if (resolved) return resolved;
    }
    if (isGmailAuth(config.webhookAuth)) return config.webhookAuth;
    return undefined;
  };

  const resolveGmailUrl = (
    path: string | URL,
    init?: ProviderFetchInit,
  ): URL => {
    const value = path instanceof URL ? path.toString() : path;
    const url = /^https?:\/\//i.test(value)
      ? new URL(value)
      : new URL(value.replace(/^\/+/, ""), `${gmailBase}/`);
    const gmailBaseUrl = new URL(`${gmailBase}/`);
    if (
      url.origin !== gmailBaseUrl.origin ||
      !url.pathname.startsWith(gmailBaseUrl.pathname)
    ) {
      throw new EmailKitError(
        "Invalid Gmail providerFetch URL",
        PROVIDER,
        "INVALID_PROVIDER_FETCH_URL",
        400,
      );
    }

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

  const isAttachmentPath = (url: URL): boolean =>
    /\/users\/[^/]+\/messages\/[^/]+\/attachments\/[^/]+$/.test(url.pathname);

  const setupMailboxWebhook = async (
    input: MailboxWebhookSetupInput,
    options?: EmailDriverOperationOptions,
  ): Promise<MailboxWebhookSetupResult> => {
    const auth = await resolveMailboxOperationAuth(
      "mailbox webhook operation",
      input,
      options,
    );
    const topicName =
      nonEmptyString(input.provider?.topicName) ||
      requirePubSubTopic("mailbox webhook setup");
    const watchLabelIds = Array.isArray(input.provider?.labelIds)
      ? (input.provider.labelIds as string[])
      : undefined;
    const events = webhookEvents(input.events);
    const mailboxEmail =
      nonEmptyString(input.email) || nonEmptyString(input.mailbox?.email);

    const watch = await startWatch(auth, {
      topicName,
      ...(watchLabelIds ? { labelIds: watchLabelIds } : {}),
    });

    const nextAuth: GmailMailboxAuth = {
      ...auth,
      ...(watch.expiration ? { watchExpiresAt: watch.expiration } : {}),
      ...(auth.historyId
        ? {}
        : watch.historyId
          ? { historyId: watch.historyId }
          : {}),
    };
    if (!authsEqual(auth, nextAuth)) {
      await options?.onAuthUpdated?.({
        auth: nextAuth,
        previousAuth: auth,
        mailbox:
          input.mailbox ||
          options?.mailbox ||
          (mailboxEmail ? { email: mailboxEmail } : undefined),
        context: input.context ?? options?.context,
        raw: watch.raw,
      });
    }

    const webhook = normalizeWatch(watch, {
      driverId,
      mailboxEmail,
      url: nonEmptyString(input.url) || resolvePublicWebhookUrl(options),
      events,
    });

    return {
      webhook,
      context: input.context ?? options?.context,
      raw: { watch: watch.raw },
    };
  };

  return {
    id: driverId,
    name: "gmail",
    capabilities: GMAIL_CAPABILITIES,

    sendEmail: async (
      message: EmailMessage<typeof GMAIL_CAPABILITIES>,
      options?: SendEmailOptions,
    ): Promise<SendEmailResult> => {
      if (!isGmailAuth(options?.auth)) {
        throw new EmailKitError(
          "Gmail sendEmail requires mailbox auth with an accessToken",
          PROVIDER,
          "MISSING_AUTH",
        );
      }
      if (!message.html && !message.text) {
        throw new EmailKitError(
          "Gmail sendEmail requires either html or text content",
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
          `Gmail sendEmail does not support these EmailKit send fields: ${unsupportedSendFields.join(
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
          "Gmail sendEmail can only send from the authenticated mailbox. Send-as aliases are not supported by this driver.",
          PROVIDER,
          "NOT_SUPPORTED",
        );
      }

      const reservedHeaderCollisions = Object.keys(message.headers || {}).filter(
        (name) =>
          [
            "from",
            "to",
            "cc",
            "bcc",
            "subject",
            "reply-to",
            "in-reply-to",
            "references",
            "message-id",
            "date",
            "mime-version",
            "content-type",
            "content-transfer-encoding",
          ].includes(name.toLowerCase()),
      );
      if (reservedHeaderCollisions.length > 0) {
        throw new EmailKitError(
          `Gmail sendEmail computes these headers from the message itself; pass the data through EmailKit fields instead: ${reservedHeaderCollisions.join(
            ", ",
          )}`,
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
      const replyTo = hasReplyData(reply)
        ? replyAddressesAsArray(reply)
        : [];
      const references = reply.references?.length
        ? reply.references
        : reply.messageId
          ? [reply.messageId]
          : undefined;

      let threadId = reply.threadId;
      let threadLookup: unknown;
      if (!threadId && reply.messageId) {
        try {
          const lookup = await lookupThreadId(
            auth,
            reply.messageId,
            options.signal,
          );
          threadId = lookup.threadId;
          threadLookup = lookup.raw;
        } catch (error) {
          // Recipient-side threading still works through the reply headers;
          // a failed thread lookup must not fail the send.
          threadLookup = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      for (const attachment of message.attachments || []) {
        if (attachment.content === undefined) {
          throw new EmailKitError(
            `Gmail attachment ${attachment.filename} must include content; URL-only attachments are not supported`,
            PROVIDER,
            "INVALID_ATTACHMENT",
          );
        }
      }

      const fromDomain = message.from.email.split("@")[1] || "mail.gmail.com";
      const messageId = `<${randomUUID()}@${fromDomain}>`;
      const mime = buildMimeMessage({
        from: message.from,
        to: message.to,
        cc: message.cc,
        bcc: message.bcc,
        subject: message.subject,
        text: message.text,
        html: message.html,
        replyTo,
        messageId,
        inReplyTo: reply.messageId,
        references,
        headers: message.headers,
        attachments: message.attachments,
      });

      const body = (await gmailFetch(
        auth,
        "users/me/messages/send",
        {
          method: "POST",
          body: {
            raw: stringToBase64Url(mime),
            ...(threadId ? { threadId } : {}),
          },
          signal: options.signal,
        },
        "Gmail message send failed",
      )) as GmailMessage;

      // Consumer Gmail accounts rewrite the Message-ID set in the MIME, so
      // the id recipients (and reply.messageId lookups) see is Gmail's own.
      // Read it back from the stored message; fall back to the generated id.
      let sentMessageId = messageId;
      let sentLookup: unknown;
      if (body.id) {
        try {
          const sent = (await gmailFetch(
            auth,
            `users/me/messages/${encodeURIComponent(body.id)}`,
            {
              searchParams: {
                format: "metadata",
                metadataHeaders: "Message-ID",
              },
              signal: options.signal,
            },
            "Gmail sent message lookup failed",
          )) as GmailMessage;
          const storedMessageId = headersToMap(sent.payload?.headers)[
            "message-id"
          ];
          if (storedMessageId) sentMessageId = storedMessageId;
        } catch (error) {
          sentLookup = {
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }

      const result: GmailSendEmailResult = {
        messageId: sentMessageId,
        provider: driverId,
        providerId: body.id,
        ...(body.threadId ? { threadId: body.threadId } : {}),
        raw: {
          send: body,
          ...(threadLookup !== undefined ? { threadLookup } : {}),
          ...(sentLookup !== undefined ? { sentMessageLookup: sentLookup } : {}),
        },
      };
      return result;
    },

    providerFetch: async (path, init) => {
      const auth = await resolveProviderFetchAuth(init);
      if (!auth) {
        throw new EmailKitError(
          "Gmail providerFetch requires webhookAuth or resolvable Gmail attachment metadata",
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
        headers.set("Authorization", authorization(auth));
      }

      const url = resolveGmailUrl(path, init);
      const response = await fetch(url, { ...restInit, headers });

      // Gmail returns attachment bodies as base64url JSON instead of raw
      // bytes. Normalize GET responses on attachment endpoints so
      // emailkit.attachments.getContent behaves identically across drivers.
      const method = (restInit.method || "GET").toUpperCase();
      if (method === "GET" && isAttachmentPath(url) && response.ok) {
        const body = (await response.json()) as { data?: string };
        const bytes =
          typeof body.data === "string" && body.data
            ? base64UrlToBytes(body.data)
            : new Uint8Array();
        return new Response(bytes.slice().buffer, {
          status: 200,
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.byteLength),
          },
        });
      }

      return response;
    },

    handleWebhook: async (
      request: WebhookRequest,
    ): Promise<WebhookEventResult> => {
      const payload = parseWebhookBody(request);
      if (!isPubSubPayload(payload)) {
        return { type: "unknown", data: payload };
      }

      const notification = decodeNotification(payload);
      if (!notification) {
        return { type: "unknown", data: payload };
      }

      const resolvedAuth = await webhookAuthFromConfig(config, {
        notification,
        payload,
        request,
        query: request.query,
        mailboxEmail: notification.emailAddress,
      });
      if (!resolvedAuth) {
        return { type: "unknown", data: payload };
      }

      let auth = resolvedAuth;
      if (
        typeof auth.expiresAt === "number" &&
        auth.expiresAt <= Date.now() + TOKEN_REFRESH_LEEWAY_MS
      ) {
        auth = await refreshAuth(auth);
      }

      const mailbox: MailboxIdentity = { email: notification.emailAddress };
      const finishAuth = async (nextAuth: GmailMailboxAuth, raw?: unknown) => {
        if (authsEqual(resolvedAuth, nextAuth)) return;
        await config.onAuthUpdated?.({
          auth: nextAuth,
          previousAuth: resolvedAuth,
          mailbox,
          raw: raw ?? notification,
        });
      };

      // Without a cursor there is no way to know which messages the
      // notification covers; hand recovery to the app's sync machinery and
      // start tracking from this notification onward.
      if (!auth.historyId) {
        await finishAuth({
          ...auth,
          ...(notification.historyId
            ? { historyId: notification.historyId }
            : {}),
        });
        return syncRequiredEvent(notification, "notifications_missed", {
          notification,
          payload,
        });
      }

      let history: { messageIds: string[]; historyId?: string };
      try {
        history = await listHistoryMessageIds(auth, auth.historyId);
      } catch (error) {
        if (error instanceof EmailKitError && error.httpStatus === 404) {
          // The stored cursor is older than Gmail's history retention.
          await finishAuth(
            {
              ...auth,
              ...(notification.historyId
                ? { historyId: notification.historyId }
                : {}),
            },
            { notification, error: error.message },
          );
          return syncRequiredEvent(notification, "history_gap", {
            notification,
            payload,
          });
        }
        throw error;
      }

      const events: WebhookDriverEvent[] = [];
      for (const messageId of history.messageIds) {
        let message: GmailMessage;
        try {
          message = await getMessage(auth, messageId);
        } catch (error) {
          if (error instanceof EmailKitError && error.httpStatus === 404) {
            continue;
          }
          throw error;
        }
        events.push({
          type: "inbound",
          data: transformGmailMessage(message, {
            eventId: `${notification.emailAddress}:${messageId}:added`,
            notification,
          }),
        });
      }

      let nextAuth: GmailMailboxAuth = {
        ...auth,
        historyId:
          maxHistoryId(
            auth.historyId,
            notification.historyId,
            history.historyId,
          ) || auth.historyId,
      };

      // Opportunistic watch renewal: active mailboxes renew inline instead of
      // relying on scheduled refreshes. Gmail sends no lifecycle warnings.
      if (
        config.autoRenewOnNotification !== false &&
        nonEmptyString(config.pubsubTopic) &&
        typeof auth.watchExpiresAt === "number" &&
        auth.watchExpiresAt - Date.now() < WATCH_RENEWAL_BUFFER_MS
      ) {
        const watch = await startWatch(auth);
        if (watch.expiration) {
          nextAuth = { ...nextAuth, watchExpiresAt: watch.expiration };
        }
        const webhook = normalizeWatch(watch, {
          driverId,
          mailboxEmail: notification.emailAddress,
          events: ["inbound"],
        });
        events.push({
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
            target: { mailboxEmail: notification.emailAddress },
            status: webhook.status,
            expiresAt: webhook.expiresAt,
            renewAfter: webhook.renewAfter,
            receivedAt: new Date(),
            raw: { notification, watch: watch.raw },
          },
        });
      }

      await finishAuth(nextAuth);

      if (events.length === 0) return { type: "unknown", data: payload };
      return events.length === 1 ? events[0]! : events;
    },

    verifyWebhook: async (request: WebhookRequest): Promise<boolean> => {
      // Only Pub/Sub pushes carry the endpoint token; OAuth callbacks and
      // other GETs are validated by their own flows (encrypted state).
      if (request.method.toUpperCase() !== "POST") return true;
      return verifyWebhookToken(config, request);
    },

    webhookResponse: async (
      _request: WebhookRequest,
      _handled: boolean,
    ): Promise<WebhookResponse> => ({
      status: 200,
      body: { success: true },
    }),

    handleCallback: async (
      request: WebhookRequest,
      options,
    ): Promise<MailboxConnectionResult> => {
      const secret = requireSecret(options?.secret, "callback handling");
      const queryError = request.query?.error;
      if (queryError) {
        throw new EmailKitError(
          request.query?.error_description || queryError,
          PROVIDER,
          queryError,
        );
      }

      const code = request.query?.code;
      const stateValue = request.query?.state;
      if (!code) {
        throw new EmailKitError(
          "Missing Gmail OAuth code",
          PROVIDER,
          "MISSING_CODE",
        );
      }
      if (!stateValue) {
        throw new EmailKitError(
          "Missing Gmail OAuth state",
          PROVIDER,
          "MISSING_STATE",
        );
      }

      const state = decodeOAuthState<GmailStatePayload>(stateValue, secret, {
        provider: PROVIDER,
        label: "Gmail",
      });
      const token = await fetchToken(
        new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: state.callbackUrl,
          code_verifier: state.codeVerifier,
        }),
      );
      let auth = toAuth(token);

      const profile = await getProfile(auth);
      const email = profile.emailAddress || state.email;
      if (!email) {
        throw new EmailKitError(
          "Gmail profile response did not include an email address",
          PROVIDER,
          "INVALID_PROFILE_RESPONSE",
          undefined,
          undefined,
          profile,
        );
      }

      // Seed the history cursor at "now" so the first push notification can
      // hydrate everything received after connect.
      auth = {
        ...auth,
        ...(normalizeHistoryId(profile.historyId)
          ? { historyId: normalizeHistoryId(profile.historyId) }
          : {}),
      };

      const mailbox: Mailbox = {
        id: email,
        email,
        status: "connected",
        raw: profile,
      };

      let webhook: Webhook | undefined;
      let watch: GmailWatch | undefined;
      if (config.autoSubscribeInbound) {
        watch = await startWatch(auth);
        auth = {
          ...auth,
          ...(watch.expiration ? { watchExpiresAt: watch.expiration } : {}),
          historyId:
            maxHistoryId(auth.historyId, watch.historyId) || auth.historyId,
        };
        webhook = normalizeWatch(watch, {
          driverId,
          mailboxEmail: email,
          url: state.webhookUrl || resolvePublicWebhookUrl(options),
          events: ["inbound"],
        });
        mailbox.raw = { profile, watch: watch.raw, webhook };
      }

      return {
        mailbox,
        auth,
        ...(webhook ? { webhooks: [webhook] } : {}),
        context: state.context,
        raw: {
          token: sanitizeTokenResponse(token),
          profile,
          ...(watch ? { watch: watch.raw, webhook } : {}),
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
        const requestedScopes = uniqueScopes(
          input.scopes && input.scopes.length > 0 ? input.scopes : scopes,
        );
        const codeVerifier = createCodeVerifier();
        const state = encodeOAuthState(
          {
            v: OAUTH_STATE_VERSION,
            provider: PROVIDER,
            nonce: createStateNonce(),
            issuedAt: Date.now(),
            callbackUrl,
            ...(webhookUrl ? { webhookUrl } : {}),
            scopes: requestedScopes,
            codeVerifier,
            email: input.email,
            context: input.context,
          } satisfies GmailStatePayload,
          secret,
        );

        const authorizationUrl = new URL(authorizationEndpoint);
        authorizationUrl.searchParams.set("client_id", config.clientId);
        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("redirect_uri", callbackUrl);
        authorizationUrl.searchParams.set(
          "scope",
          formatScopes(requestedScopes),
        );
        authorizationUrl.searchParams.set("state", state);
        authorizationUrl.searchParams.set(
          "code_challenge",
          createCodeChallenge(codeVerifier),
        );
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
        // Offline access + forced consent guarantee a refresh token, which
        // mailbox operations rely on for silent token renewal.
        authorizationUrl.searchParams.set("access_type", "offline");
        authorizationUrl.searchParams.set("prompt", "consent");
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

        // Gmail has no subscription id to renew; refresh is a fresh watch.
        refresh: async (
          input: MailboxWebhookRefreshInput,
          options?: EmailDriverOperationOptions,
        ): Promise<MailboxWebhookRefreshResult> => {
          const setup = await setupMailboxWebhook(
            {
              ...(input.mailbox ? { mailbox: input.mailbox } : {}),
              ...(input.mailboxId ? { mailboxId: input.mailboxId } : {}),
              ...(input.email ? { email: input.email } : {}),
              ...(input.auth !== undefined ? { auth: input.auth } : {}),
              ...(input.webhook?.url ? { url: input.webhook.url } : {}),
              ...(input.webhook?.events ? { events: input.webhook.events } : {}),
              ...(input.provider ? { provider: input.provider } : {}),
              ...(input.context !== undefined
                ? { context: input.context }
                : {}),
            } as MailboxWebhookSetupInput,
            options,
          );
          return setup;
        },

        delete: async (
          input: MailboxWebhookDeleteInput,
          options?: EmailDriverOperationOptions,
        ): Promise<MailboxWebhookDeleteResult> => {
          const auth = await resolveMailboxOperationAuth(
            "mailbox webhook operation",
            input,
            options,
          );
          const raw = await stopWatch(auth);
          const existingWebhook = input.webhook;
          const mailboxEmail =
            nonEmptyString(input.email) ||
            nonEmptyString(input.mailbox?.email);

          return {
            deleted: true,
            webhook: {
              id: existingWebhook?.id || `watch:${mailboxEmail || "me"}`,
              emailDriver: driverId,
              scope: "mailbox",
              url:
                existingWebhook?.url ||
                resolvePublicWebhookUrl(options) ||
                `pubsub:${config.pubsubTopic || "unknown"}`,
              events: existingWebhook?.events,
              status: "deleted",
              providerId:
                existingWebhook?.providerId ||
                `watch:${mailboxEmail || "me"}`,
              raw: existingWebhook?.raw,
            },
            context: input.context ?? options?.context,
            raw,
          };
        },
      },
    },

    sync: {
      mailbox: async function* (
        input: MailboxSyncInput,
        options?: EmailDriverOperationOptions,
      ): SyncStream {
        const auth = await resolveMailboxOperationAuth(
          "mailbox sync",
          input,
          options,
          input.signal,
        );
        const until = input.until || new Date();
        const mailboxEmails = normalizedMailboxEmails(input);
        const attachmentProvider = mailboxProviderMetadata(input);

        // Gmail's after:/before: search operators are second-granular, so
        // over-fetch by a second on each side and filter on internalDate.
        const query = `after:${Math.floor(
          input.since.getTime() / 1000,
        )} before:${Math.ceil(until.getTime() / 1000) + 1}`;

        const messageIds: string[] = [];
        let pageToken: string | undefined;
        do {
          const body = (await gmailFetch(
            auth,
            "users/me/messages",
            {
              searchParams: {
                q: query,
                maxResults: String(SYNC_PAGE_SIZE),
                ...(labelIds.length === 1 ? { labelIds: labelIds[0] } : {}),
                ...(pageToken ? { pageToken } : {}),
              },
              signal: input.signal,
            },
            "Gmail message listing failed",
          )) as GmailMessageListResponse;

          for (const message of body.messages || []) {
            if (message.id) messageIds.push(message.id);
          }
          pageToken = body.nextPageToken;
        } while (pageToken);

        // messages.list returns newest-first; sync must yield oldest-first.
        messageIds.reverse();

        for (const messageId of messageIds) {
          let message: GmailMessage;
          try {
            message = await getMessage(auth, messageId, input.signal);
          } catch (error) {
            if (error instanceof EmailKitError && error.httpStatus === 404) {
              continue;
            }
            throw error;
          }

          if (
            labelIds.length !== 1 &&
            !matchesConfiguredLabels(message.labelIds)
          ) {
            continue;
          }

          const internalDate = Number(message.internalDate);
          if (Number.isFinite(internalDate) && internalDate > 0) {
            if (
              internalDate < input.since.getTime() ||
              internalDate >= until.getTime()
            ) {
              continue;
            }
          }

          const headers = headersToMap(message.payload?.headers);
          const from = parseAddressListHeader(headers.from)[0]?.email;
          if (from && mailboxEmails.has(from.toLowerCase())) continue;

          yield {
            type: "inbound",
            data: transformGmailMessage(message, {
              eventId: message.id ? `sync:${message.id}` : undefined,
              attachmentProvider,
            }),
          };
        }

        return { syncedFrom: input.since };
      },
    },
  };
};

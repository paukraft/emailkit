/**
 * AIInbx email driver (API v2)
 *
 * Documentation: https://docs.aiinbx.com
 * OpenAPI Spec: https://api.aiinbx.com/api/v2/openapi.json
 */

import { createHmac, timingSafeEqual } from "crypto";
import type {
  DriverDomainsAPI,
  DriverMailboxesAPI,
  EmailDriver,
  EmailDriverConfig,
  ProviderFetch,
  SendEmailOptions,
  SyncStream,
} from "../driver";
import type {
  AccountSyncInput,
  AccountWebhookDeleteInput,
  AccountWebhookDeleteResult,
  AccountWebhookRefreshInput,
  AccountWebhookRefreshResult,
  AccountWebhookSetupInput,
  AccountWebhookSetupResult,
  Attachment,
  ConnectMailboxInput,
  CreateDomainInput,
  Domain,
  DomainDNSRecord,
  DomainDeleteResult,
  DomainRecordPurpose,
  DomainVerification,
  DriverCapabilities,
  EmailAddress,
  EmailMessage,
  InboundEmailEvent,
  ListDomainsOptions,
  ListMailboxesOptions,
  Mailbox,
  MailboxConnectionResult,
  MailboxDeleteResult,
  OutboundEmailEvent,
  SendEmailResult,
  UpdateDomainInput,
  Webhook,
  WebhookDriverEvent,
  WebhookEvent,
  WebhookEventResult,
  WebhookEventSelection,
  WebhookEventType,
  WebhookRequest,
  WebhookResponse,
} from "../types";
import { EmailKitError } from "../types";
import {
  isAbortError,
  retrieveAttachmentsInParallel,
} from "../utils/attachments";
import { bytesToBase64, stringToBase64 } from "../utils/base64";
import { createProviderFetch } from "../utils/provider-fetch";
import {
  buildReplyContext,
  replyAddressesAsArray,
  resolveMessageReplyContext,
} from "../utils/reply";
import {
  getHeader,
  isFreshWebhookTimestamp,
  requireRawBody,
} from "../utils/webhook";

const PROVIDER = "aiinbx";
const DEFAULT_API_BASE = "https://api.aiinbx.com";
const LIST_PAGE_SIZE = 100;

/**
 * AIInbx-specific configuration
 */
export interface AIInbxDriverConfig<TId extends string = "aiinbx">
  extends EmailDriverConfig {
  /**
   * EmailKit driver id. Override when configuring multiple AIInbx drivers.
   */
  id?: TId;
  apiKey: string;
  /**
   * Optional API base URL (defaults to https://api.aiinbx.com)
   */
  apiBase?: string;
  /**
   * Webhook endpoint signing secret. Pass both secrets during a rotation
   * grace period; a request verifies when any of them matches.
   */
  webhookSecret?: string | string[];
  /**
   * Automatically download inbound attachment content.
   * If false, attachments carry metadata and a stable API URL only.
   * App code can still retrieve content later via `emailkit.attachments.getContent(...)`.
   * Default: true
   */
  autoFetchInboundAttachments?: boolean;
  /**
   * Inline AIInbx's prepared attachment text (PDFs, documents, and
   * spreadsheets extracted to Markdown) on inbound events, readable via
   * `getAIInbxAttachment(attachment)?.preparation?.text`.
   * Default: true
   */
  inlineAttachmentText?: boolean;
}

/**
 * AIInbx classification of an inbound message.
 */
export type AIInbxEmailCategory =
  | "human"
  | "out_of_office"
  | "auto_reply"
  | "bounce"
  | "verification"
  | "transactional"
  | "notification"
  | "marketing"
  | "spam";

/**
 * Sender authentication results. Only delivered with live webhooks — the
 * AIInbx API does not return them on stored emails, so sync replays omit them.
 */
export interface AIInbxVerdicts {
  spam?: string;
  spf?: string;
  dkim?: string;
  dmarc?: string;
}

/**
 * One part of AIInbx's cut of an inbound body, in order.
 */
export interface AIInbxSegment {
  kind: "written" | "quoted" | "signature";
  text: string;
}

/**
 * AIInbx's extraction of an attachment into model-readable text.
 */
export interface AIInbxAttachmentPreparation {
  status: "ready" | "partial" | "unsupported" | "failed";
  format: "markdown" | "text" | null;
  pages: number | null;
  warnings: string[];
  /** Extracted text. Present when `inlineAttachmentText` is enabled. */
  text?: string | null;
}

interface AIInbxResourceMetadata {
  emailId: string;
  threadId?: string;
  /** Space the email is in; null is the workspace itself. */
  spaceId: string | null;
  /** Domain the email went through, when the webhook reported it. */
  domainId?: string | null;
  /** Connected mailbox the email went through, when the webhook reported it. */
  mailboxId?: string | null;
}

/** `provider.aiinbx` on inbound events. */
export interface AIInbxInboundMetadata extends AIInbxResourceMetadata {
  threadId: string;
  category: AIInbxEmailCategory | null;
  snippet: string;
  segments: AIInbxSegment[];
  verdicts?: AIInbxVerdicts;
}

/** `provider.aiinbx` on outbound events. */
export interface AIInbxOutboundMetadata extends AIInbxResourceMetadata {
  suppressionKey?: string | null;
  /**
   * On unsubscribed events: whether the recipient blocked everything or only
   * optional mail (they still want receipts and password resets).
   */
  unsubscribeScope?: "all" | "optional";
}

/** `provider.aiinbx` on inbound attachments. */
export interface AIInbxAttachmentMetadata {
  attachmentId: string;
  /** Null when nothing was extracted, or extraction is still in flight. */
  preparation: AIInbxAttachmentPreparation | null;
}

/**
 * AIInbx send options accepted on `message.provider`.
 */
export interface AIInbxSendOptions {
  /** Suppression list this send is checked against. */
  suppressionKey?: string;
  /** Bypass (`skip`) or discount (`count: false`) pacing rules. */
  pacing?: { skip?: boolean; count?: boolean };
}

/**
 * AIInbx options accepted on `mailboxes.connect({ provider })`.
 */
export interface AIInbxConnectMailboxOptions {
  /** Which account type the customer connects. */
  provider: "google" | "microsoft";
  /** Your own OAuth app, so the consent screen carries your brand. */
  app_id?: string;
  /** Space the mailbox — and everything synced from it — lands in. */
  space_id?: string;
  region?: "eu-central-1" | "us-east-1";
  /** History to import on first sync, 0–90 days. */
  backfill_days?: number;
}

const readAIInbxMetadata = <T>(
  provider: Record<string, unknown> | undefined,
): T | undefined => {
  const metadata = provider?.[PROVIDER];
  return metadata && typeof metadata === "object" ? (metadata as T) : undefined;
};

/** AIInbx extras of an inbound event: category, verdicts, segments, ids. */
export const getAIInbxInbound = (
  event: InboundEmailEvent,
): AIInbxInboundMetadata | undefined => readAIInbxMetadata(event.provider);

/** AIInbx extras of an outbound event: thread, space, suppression key. */
export const getAIInbxOutbound = (
  event: OutboundEmailEvent,
): AIInbxOutboundMetadata | undefined => readAIInbxMetadata(event.provider);

/** AIInbx extras of an inbound attachment: id and prepared Markdown/text. */
export const getAIInbxAttachment = (
  attachment: Attachment,
): AIInbxAttachmentMetadata | undefined =>
  readAIInbxMetadata(attachment.provider);

interface AIInbxAttachment {
  id: string;
  filename: string;
  content_type: string;
  size: number;
  cid: string | null;
  /** Short-lived signed URL. */
  download_url: string;
  preparation:
    | (AIInbxAttachmentPreparation & { content_url: string | null })
    | null;
}

/** `Email` schema — list item shape. */
interface AIInbxEmail {
  id: string;
  thread_id: string;
  space_id: string | null;
  direction: "inbound" | "outbound";
  from: { name?: string | null; address: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  reply_to?: string[];
  subject: string;
  snippet: string;
  html?: string | null;
  text?: string | null;
  category: AIInbxEmailCategory | null;
  message_id: string;
  in_reply_to: string | null;
  created_at: string;
  attachments?: AIInbxAttachment[];
}

/** `FullEmail` schema — `GET /emails/{email_id}`. */
interface AIInbxFullEmail extends AIInbxEmail {
  cc: string[];
  bcc: string[];
  reply_to: string[];
  html: string | null;
  text: string | null;
  stripped_text: string | null;
  stripped_html: string | null;
  segments: AIInbxSegment[];
  references: string[];
  headers: Array<{ name: string; value: string }>;
  attachments: AIInbxAttachment[];
}

interface AIInbxSendResponse extends AIInbxEmail {
  suppressed: string[];
}

interface AIInbxPage<T> {
  data: T[];
  next_cursor: string | null;
}

interface AIInbxEventData {
  email_id: string;
  thread_id?: string;
  domain_id?: string | null;
  mailbox_id?: string | null;
  suppression_key?: string | null;
}

/**
 * What an open or a click carries. AIInbx classifies the hit itself — it
 * knows when the message was delivered, which a user-agent alone does not
 * say. `bot` is absent on events sent before it did.
 */
interface AIInbxEngagementData {
  user_agent?: string | null;
  bot?: boolean;
  bot_reason?: string | null;
}

const engagementDetails = (data: AIInbxEngagementData) => ({
  ...(data.user_agent ? { userAgent: data.user_agent } : {}),
  ...(data.bot === undefined
    ? {}
    : {
        botDetection: {
          isBot: data.bot,
          reason: data.bot_reason ?? "default-allow",
        },
      }),
});

interface AIInbxWebhookEnvelope {
  id: string;
  created_at: string;
  space_id: string | null;
}

type AIInbxEmailWebhookPayload = AIInbxWebhookEnvelope &
  (
    | {
        type: "email.received";
        data: AIInbxEventData & {
          thread_id: string;
          verdicts?: AIInbxVerdicts;
        };
      }
    | {
        type: "email.sent";
        data: AIInbxEventData & { from: string; to: string[]; subject: string };
      }
    | {
        type: "email.delivered";
        data: AIInbxEventData & { recipients: string[] };
      }
    | {
        type: "email.bounced";
        data: AIInbxEventData & {
          recipients: string[];
          permanent: boolean;
          reason: string;
        };
      }
    | {
        type: "email.complained";
        data: AIInbxEventData & { recipients: string[]; reason: string | null };
      }
    | { type: "email.failed"; data: AIInbxEventData & { reason: string } }
    | {
        type: "email.opened";
        data: AIInbxEventData & AIInbxEngagementData;
      }
    | {
        type: "email.clicked";
        data: AIInbxEventData & AIInbxEngagementData & { url: string };
      }
    | {
        type: "email.unsubscribed";
        data: AIInbxEventData & {
          address: string;
          /** Suppression list; `*` is the whole workspace's or space's. */
          key: string;
          scope: "all" | "optional";
          source: "link" | "one_click" | "reply";
        };
      }
  );

interface AIInbxMailboxEventData {
  mailbox_id: string;
  address: string;
  provider: "google" | "microsoft";
}

type AIInbxMailboxWebhookPayload = AIInbxWebhookEnvelope &
  (
    | {
        type: "mailbox.connected";
        /** `ref` is whatever the connect link or `mailboxes.connect` carried. */
        data: AIInbxMailboxEventData & { ref?: string; reconnected: boolean };
      }
    | {
        type: "mailbox.needs_reauth" | "mailbox.disconnected";
        data: AIInbxMailboxEventData & { reason: string | null };
      }
  );

type AIInbxWebhookPayload =
  | AIInbxEmailWebhookPayload
  | AIInbxMailboxWebhookPayload;

interface AIInbxMailbox {
  id: string;
  address: string;
  name: string | null;
  state: "active" | "needs_reauth" | "disconnected";
  connected_at: string;
}

interface AIInbxDomain {
  id: string;
  name: string;
  region: string;
  verified_at: string | null;
  created_at: string;
  records?: Array<{
    purpose: "SPF" | "DKIM" | "DMARC" | "RETURN_PATH" | "INBOUND";
    type: "MX" | "TXT" | "CNAME";
    name: string;
    value: string;
    ttl: number;
    state: "pending" | "verified" | "missing";
    last_checked_at: string | null;
  }>;
}

interface AIInbxWebhookEndpoint {
  id: string;
  url: string;
  enabled: boolean;
  subscriptions: string[];
  created_at: string;
  updated_at: string;
  /** Returned once, on creation. */
  secret?: string;
}

/** RFC 9457 problem+json error body. */
interface AIInbxProblem {
  detail?: string;
  code?: string;
  issues?: Array<{ path: string; message: string }>;
}

/**
 * AIInbx driver capabilities
 */
export const AIINBX_CAPABILITIES = {
  cc: true,
  bcc: true,
  replyTo: true,
  // v2 derives In-Reply-To/References itself when replying on a thread.
  replyHeaders: false,
  replyThreadId: true,
  attachments: true,
  customHeaders: true,
  tags: false,
  metadata: false,
  templates: false,
  personalizations: false,
  scheduling: true,
  unsubscribe: true,
  // Tracking is a domain setting in v2 (`domains.update`), not a send option.
  eventTracking: {
    opens: true,
    clicks: true,
  },
  sandbox: false,
  sendIdempotency: true,
  tenantRouting: false,
  providerFetch: true,
  domains: {
    list: true,
    create: true,
    get: true,
    update: true,
    verify: true,
    delete: true,
    identifier: "domainId" as const,
  },
  webhooks: { account: true },
  sync: { account: true },
  // Connect lands on `return_to`; completion arrives by webhook, so there is
  // no OAuth callback and no signed state.
  publicRoutes: { webhook: true, connectLanding: true },
  requiresSecret: false,
  mailboxConnect: true,
  mailboxList: true,
  mailboxGet: true,
  mailboxDelete: true,
} as const satisfies DriverCapabilities;

/**
 * Type helper for AIInbx capabilities
 */
export type AIInbxCapabilities = typeof AIINBX_CAPABILITIES;

const AIINBX_EVENTS_BY_EMAILKIT_EVENT: Record<string, string[]> = {
  inbound: ["email.received"],
  outbound: ["email.sent"],
  delivered: ["email.delivered"],
  opened: ["email.opened"],
  clicked: ["email.clicked"],
  bounced: ["email.bounced"],
  complained: ["email.complained"],
  rejected: ["email.failed"],
  unsubscribed: ["email.unsubscribed"],
};

const EMAILKIT_EVENT_BY_AIINBX_EVENT: Record<string, WebhookEventType> =
  Object.fromEntries(
    Object.entries(AIINBX_EVENTS_BY_EMAILKIT_EVENT).flatMap(
      ([emailkitEvent, aiinbxEvents]) =>
        aiinbxEvents.map((aiinbxEvent) => [aiinbxEvent, emailkitEvent]),
    ),
  );

const AIINBX_DEFAULT_WEBHOOK_EVENTS = [
  ...Object.values(AIINBX_EVENTS_BY_EMAILKIT_EVENT).flat(),
  "mailbox.connected",
  "mailbox.needs_reauth",
  "mailbox.disconnected",
];

const unique = <T>(values: T[]): T[] => Array.from(new Set(values));

const toAIInbxWebhookEvents = (events?: WebhookEventSelection): string[] => {
  if (!events || events === "all" || events.length === 0) {
    return AIINBX_DEFAULT_WEBHOOK_EVENTS;
  }
  return unique(
    events.flatMap(
      (event) => AIINBX_EVENTS_BY_EMAILKIT_EVENT[event] || [event],
    ),
  );
};

const fromAIInbxWebhookEvents = (events: string[]): WebhookEventType[] =>
  unique(events.map((event) => EMAILKIT_EVENT_BY_AIINBX_EVENT[event] || event));

const normalizeWebhookEndpoint = (raw: AIInbxWebhookEndpoint): Webhook => ({
  id: raw.id,
  providerId: raw.id,
  scope: "account",
  url: raw.url,
  events: fromAIInbxWebhookEvents(raw.subscriptions),
  status: raw.enabled ? "active" : "disabled",
  createdAt: new Date(raw.created_at),
  updatedAt: new Date(raw.updated_at),
  ...(raw.secret ? { provider: { signingSecret: raw.secret } } : {}),
  raw,
});

const requireWebhookId = (
  input: AccountWebhookRefreshInput | AccountWebhookDeleteInput,
  action: string,
): string => {
  const webhookId =
    input.webhook?.providerId ||
    input.webhook?.id ||
    ("providerId" in input ? input.providerId : undefined) ||
    input.webhookId;
  if (!webhookId) {
    throw new EmailKitError(
      `Webhook ${action} requires a webhook id or providerId`,
      PROVIDER,
      "MISSING_REQUIRED_FIELD",
    );
  }
  return webhookId;
};

const toRoutingRules = (
  recipients: NonNullable<AccountWebhookSetupInput["inbound"]>["recipients"],
): Array<{ effect: "allow"; field: "to"; pattern: string }> | undefined => {
  if (!recipients || recipients === "all") return undefined;
  return [recipients].flat().map((pattern) => ({
    effect: "allow",
    field: "to",
    pattern,
  }));
};

const DOMAIN_RECORD_PURPOSE: Record<
  NonNullable<AIInbxDomain["records"]>[number]["purpose"],
  DomainRecordPurpose
> = {
  SPF: "spf",
  DKIM: "dkim",
  DMARC: "dmarc",
  RETURN_PATH: "returnPath",
  INBOUND: "mx",
};

const normalizeDomainRecords = (raw: AIInbxDomain): DomainDNSRecord[] =>
  (raw.records ?? []).map((record) => ({
    type: record.type,
    name: record.name,
    value: record.value,
    ttl: record.ttl,
    purpose: DOMAIN_RECORD_PURPOSE[record.purpose],
    verified: record.state === "verified",
    ...(record.last_checked_at
      ? { lastCheckedAt: new Date(record.last_checked_at) }
      : {}),
  }));

const normalizeDomainVerification = (
  raw: AIInbxDomain,
  checkedAt?: Date,
): DomainVerification => ({
  status: raw.verified_at ? "verified" : "pending",
  records: normalizeDomainRecords(raw),
  checkedAt,
  raw,
});

const normalizeDomain = (raw: AIInbxDomain): Domain => ({
  id: raw.id,
  domain: raw.name,
  status: raw.verified_at ? "verified" : "pending",
  region: raw.region,
  createdAt: new Date(raw.created_at),
  verification: normalizeDomainVerification(raw),
  raw,
});

const MAILBOX_REF_MAX_LENGTH = 200;

const normalizeMailbox = (raw: AIInbxMailbox): Mailbox => ({
  id: raw.id,
  email: raw.address,
  ...(raw.name ? { displayName: raw.name } : {}),
  status: raw.state === "active" ? "connected" : "disabled",
  createdAt: new Date(raw.connected_at),
  raw,
});

/**
 * `context` round-trips through AIInbx's `ref`, echoed on the signed
 * `mailbox.connected` webhook. Hosted connect links set a plain-string ref.
 */
const encodeMailboxRef = (context: unknown): string | undefined => {
  if (context === undefined) return undefined;
  const ref = JSON.stringify(context);
  if (ref.length > MAILBOX_REF_MAX_LENGTH) {
    throw new EmailKitError(
      `AIInbx carries mailbox connect context in a ${MAILBOX_REF_MAX_LENGTH}-character ref; pass an id instead of a large object`,
      PROVIDER,
      "INVALID_INPUT",
    );
  }
  return ref;
};

const decodeMailboxRef = (ref: string | undefined): unknown => {
  if (ref === undefined) return undefined;
  try {
    return JSON.parse(ref);
  } catch {
    return ref;
  }
};

const toMailboxEvent = (
  payload: AIInbxMailboxWebhookPayload,
  emailDriver: string,
): WebhookDriverEvent => {
  const { mailbox_id: id, address: email } = payload.data;

  if (payload.type === "mailbox.needs_reauth") {
    return {
      type: "webhook.lifecycle",
      data: {
        id: payload.id,
        emailDriver,
        action: "action_required",
        source: "provider",
        reason: "reauthorization_required",
        recommendedActions: ["reauthorize"],
        scope: "mailbox",
        target: { mailboxId: id, mailboxEmail: email },
        severity: "critical",
        receivedAt: new Date(payload.created_at),
        raw: payload,
      },
    };
  }

  const connected = payload.type === "mailbox.connected";
  const context = connected ? decodeMailboxRef(payload.data.ref) : undefined;
  return {
    type: "mailbox.lifecycle",
    data: {
      action: connected ? "connected" : "deleted",
      mailbox: {
        id,
        email,
        status: connected ? "connected" : "disabled",
        raw: payload,
      },
      ...(context !== undefined ? { context } : {}),
      raw: payload,
    },
  };
};

const toAddresses = (addresses: string[] | undefined): EmailAddress[] =>
  (addresses ?? []).map((email) => ({ email }));

const emailsOf = (addresses: EmailAddress | EmailAddress[]): string[] =>
  [addresses].flat().map((address) => address.email);

const resourceMetadata = (
  payload: AIInbxEmailWebhookPayload,
): AIInbxResourceMetadata => ({
  emailId: payload.data.email_id,
  threadId: payload.data.thread_id,
  spaceId: payload.space_id,
  domainId: payload.data.domain_id,
  mailboxId: payload.data.mailbox_id,
});

interface AIInbxRequestInit extends Omit<RequestInit, "body"> {
  searchParams?: Record<string, string | undefined>;
  body?: unknown;
}

type AIInbxRequest = <T>(
  path: string,
  init: AIInbxRequestInit,
  action: string,
) => Promise<{ data: T; response: Response }>;

const problemMessage = (problem: AIInbxProblem): string | undefined => {
  if (!problem.detail) return undefined;
  if (!problem.issues?.length) return problem.detail;
  const issues = problem.issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ");
  return `${problem.detail} (${issues})`;
};

const createAIInbxRequest =
  (baseUrl: string, apiKey: string): AIInbxRequest =>
  async <T>(path: string, init: AIInbxRequestInit, action: string) => {
    const { searchParams, body, headers, ...fetchInit } = init;
    const url = new URL(`${baseUrl}${path}`);
    for (const [key, value] of Object.entries(searchParams ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...fetchInit,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (isAbortError(error, init.signal ?? undefined)) throw error;
      throw new EmailKitError(
        `Failed to ${action}: ${error instanceof Error ? error.message : String(error)}`,
        PROVIDER,
        undefined,
        undefined,
        error,
      );
    }

    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("json")
      ? await response.json()
      : await response.text();

    if (!response.ok) {
      const problem: AIInbxProblem =
        data && typeof data === "object" ? data : {};
      throw new EmailKitError(
        problemMessage(problem) ??
          `HTTP ${response.status}: Failed to ${action}`,
        PROVIDER,
        problem.code,
        response.status,
        undefined,
        data,
      );
    }

    return { data: data as T, response };
  };

const isAIInbxApiUrl = (path: string | URL, baseUrl: string): boolean => {
  if (typeof path === "string" && !/^https?:\/\//i.test(path)) return true;
  const url = path.toString();
  return url === baseUrl || url.startsWith(`${baseUrl}/`);
};

/**
 * Authenticated for API URLs; anonymous elsewhere, so the API key never
 * reaches signed storage URLs.
 */
const createAIInbxProviderFetch = (
  baseUrl: string,
  apiKey: string,
): ProviderFetch => {
  const authedFetch = createProviderFetch({
    baseUrl,
    defaultHeaders: { Authorization: `Bearer ${apiKey}` },
  });
  const anonymousFetch = createProviderFetch({ baseUrl });

  return (path, init) =>
    isAIInbxApiUrl(path, baseUrl)
      ? authedFetch(path, init)
      : anonymousFetch(path, init);
};

/** Signed download URLs are self-authenticating and reject bearer auth. */
const downloadAttachments = (
  attachments: Attachment[],
  downloadUrls: string[],
  signal?: AbortSignal,
): Promise<Attachment[]> =>
  retrieveAttachmentsInParallel({
    attachments,
    signal,
    retrieve: async (attachment, index) => {
      const res = await fetch(downloadUrls[index]!, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return {
        ...attachment,
        content: new Uint8Array(await res.arrayBuffer()),
      };
    },
    onError: (attachment, error) => {
      console.error(
        `Failed to retrieve AIInbx attachment ${attachment.filename}:`,
        error,
      );
    },
  });

/** `providerFetch` authenticates lazy inbound attachment URLs when forwarded. */
const toOutboundAttachment = async (
  attachment: Attachment,
  providerFetch: ProviderFetch,
): Promise<Record<string, unknown>> => {
  let content: string;

  if (attachment.content !== undefined) {
    content =
      typeof attachment.content === "string"
        ? stringToBase64(attachment.content)
        : bytesToBase64(attachment.content);
  } else if (attachment.url) {
    try {
      const res = await providerFetch(attachment.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      content = bytesToBase64(new Uint8Array(await res.arrayBuffer()));
    } catch (error) {
      throw new EmailKitError(
        `Failed to fetch attachment ${attachment.filename} from URL: ${attachment.url}`,
        PROVIDER,
        "ATTACHMENT_FETCH_FAILED",
        undefined,
        error,
      );
    }
  } else {
    throw new EmailKitError(
      `Attachment ${attachment.filename} must have either content or url`,
      PROVIDER,
      "INVALID_ATTACHMENT",
    );
  }

  return {
    filename: attachment.filename,
    content_type: attachment.contentType || "application/octet-stream",
    content,
    ...(attachment.isInline && attachment.contentId
      ? { cid: attachment.contentId }
      : {}),
  };
};

const verifySignature = (
  secrets: string[],
  timestamp: string,
  signature: string,
  rawBody: string,
): boolean => {
  const provided = Buffer.from(signature, "utf8");
  return secrets.some((secret) => {
    const expected = Buffer.from(
      createHmac("sha256", secret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex"),
      "utf8",
    );
    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  });
};

export const AIInbxDriver = <const TId extends string = "aiinbx">(
  config: AIInbxDriverConfig<TId>,
): EmailDriver<typeof AIINBX_CAPABILITIES, TId> & {
  domains: DriverDomainsAPI;
  mailboxes: Omit<DriverMailboxesAPI<typeof AIINBX_CAPABILITIES>, "create">;
} => {
  const driverId = (config.id || PROVIDER) as TId;
  const baseUrl = `${(config.apiBase || DEFAULT_API_BASE).replace(/\/+$/, "")}/api/v2`;
  const request = createAIInbxRequest(baseUrl, config.apiKey);

  const listAll = async <T>(
    path: string,
    action: string,
    limit?: number,
  ): Promise<T[]> => {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const { data } = await request<AIInbxPage<T>>(
        path,
        {
          method: "GET",
          searchParams: { limit: String(LIST_PAGE_SIZE), cursor },
        },
        action,
      );
      items.push(...data.data);
      cursor = data.next_cursor ?? undefined;
    } while (cursor && (limit === undefined || items.length < limit));
    return limit === undefined ? items : items.slice(0, limit);
  };

  const resolveDomainId = async (idOrName: string): Promise<string> => {
    // Domain ids (`dom_…`) never contain a dot; names always do.
    if (!idOrName.includes(".")) return idOrName;

    const domains = await listAll<AIInbxDomain>("/domains", "list domains");
    const match = domains.find(
      (domain) => domain.name.toLowerCase() === idOrName.toLowerCase(),
    );
    if (!match) {
      throw new EmailKitError(
        `Domain not found: ${idOrName}`,
        PROVIDER,
        "NOT_FOUND",
        404,
      );
    }
    return match.id;
  };

  const resolveMailboxId = async (idOrEmail: string): Promise<string> => {
    if (!idOrEmail.includes("@")) return idOrEmail;

    const mailboxes = await listAll<AIInbxMailbox>(
      "/mailboxes",
      "list mailboxes",
    );
    const matches = mailboxes.filter(
      (mailbox) => mailbox.address.toLowerCase() === idOrEmail.toLowerCase(),
    );
    // A reconnected address can leave a disconnected record behind.
    const match =
      matches.find((mailbox) => mailbox.state === "active") ?? matches[0];
    if (!match) {
      throw new EmailKitError(
        `Mailbox not found: ${idOrEmail}`,
        PROVIDER,
        "NOT_FOUND",
        404,
      );
    }
    return match.id;
  };

  const mailboxPath = async (idOrEmail: string): Promise<string> =>
    `/mailboxes/${encodeURIComponent(await resolveMailboxId(idOrEmail))}`;

  const domainPath = async (idOrName: string, suffix = ""): Promise<string> =>
    `/domains/${encodeURIComponent(await resolveDomainId(idOrName))}${suffix}`;

  /**
   * Webhooks and list items carry a snippet, not the message — load the full
   * email (bodies, headers, segments, prepared attachment text) by id.
   */
  const loadInboundEvent = async (
    emailId: string,
    source: {
      eventId: string;
      raw?: unknown;
      webhook?: Extract<AIInbxEmailWebhookPayload, { type: "email.received" }>;
      signal?: AbortSignal;
    },
  ): Promise<InboundEmailEvent> => {
    const { data: email } = await request<AIInbxFullEmail>(
      `/emails/${encodeURIComponent(emailId)}`,
      {
        method: "GET",
        signal: source.signal,
        searchParams: {
          include:
            (config.inlineAttachmentText ?? true)
              ? "attachment_content"
              : undefined,
        },
      },
      "retrieve email",
    );

    const attachmentMetadata = email.attachments.map(
      (attachment): Attachment => {
        const { content_url: _contentUrl, ...preparation } =
          attachment.preparation ?? {};
        const metadata: AIInbxAttachmentMetadata = {
          attachmentId: attachment.id,
          preparation: attachment.preparation
            ? (preparation as AIInbxAttachmentPreparation)
            : null,
        };
        return {
          filename: attachment.filename,
          contentType: attachment.content_type,
          size: attachment.size,
          contentId: attachment.cid || undefined,
          isInline: Boolean(attachment.cid),
          // Signed download URLs expire; the API URL redirects to a fresh one.
          url: `${baseUrl}/attachments/${attachment.id}`,
          provider: { [PROVIDER]: metadata },
        };
      },
    );
    const attachments =
      (config.autoFetchInboundAttachments ?? true)
        ? await downloadAttachments(
            attachmentMetadata,
            email.attachments.map((attachment) => attachment.download_url),
            source.signal,
          )
        : attachmentMetadata;

    const metadata: AIInbxInboundMetadata = {
      emailId: email.id,
      threadId: email.thread_id,
      spaceId: email.space_id,
      ...(source.webhook
        ? {
            domainId: source.webhook.data.domain_id,
            mailboxId: source.webhook.data.mailbox_id,
          }
        : {}),
      category: email.category,
      snippet: email.snippet,
      segments: email.segments,
      ...(source.webhook?.data.verdicts
        ? { verdicts: source.webhook.data.verdicts }
        : {}),
    };
    const cc = toAddresses(email.cc);
    const bcc = toAddresses(email.bcc);

    return {
      schemaVersion: "1",
      eventId: source.eventId,
      messageId: email.message_id,
      providerId: email.id,
      from: {
        email: email.from.address,
        ...(email.from.name ? { name: email.from.name } : {}),
      },
      to: toAddresses(email.to),
      ...(cc.length > 0 ? { cc } : {}),
      ...(bcc.length > 0 ? { bcc } : {}),
      reply: buildReplyContext({
        addresses: toAddresses(email.reply_to),
        messageId: email.in_reply_to,
        references: email.references,
        threadId: email.thread_id,
      }),
      subject: email.subject,
      text: email.text ?? undefined,
      html: email.html ?? undefined,
      strippedText: email.stripped_text ?? undefined,
      strippedHtml: email.stripped_html ?? undefined,
      ...(attachments.length > 0 ? { attachments } : {}),
      headers: Object.fromEntries(
        email.headers.map((header) => [header.name, header.value]),
      ),
      timestamp: new Date(email.created_at),
      provider: { [PROVIDER]: metadata },
      raw: source.raw ?? email,
    };
  };

  /**
   * Delivery outcomes are reported per recipient: one normalized event each.
   * Webhooks identify the email by its AIInbx id only, so `messageId` and
   * `providerId` both carry it — correlate with `SendEmailResult.providerId`.
   */
  const toOutboundEvents = (
    type: WebhookEvent["type"],
    status: OutboundEmailEvent["status"],
    payload: AIInbxEmailWebhookPayload,
    recipients: string[],
    details: Record<string, unknown> = {},
  ): WebhookEvent[] => {
    const metadata: AIInbxOutboundMetadata = {
      ...resourceMetadata(payload),
      ...(payload.type === "email.unsubscribed"
        ? {
            suppressionKey: payload.data.key,
            unsubscribeScope: payload.data.scope,
          }
        : { suppressionKey: payload.data.suppression_key }),
    };
    const targets = recipients.length > 0 ? recipients : [""];

    return targets.map((recipient) => {
      const data: OutboundEmailEvent = {
        schemaVersion: "1",
        eventId: targets.length > 1 ? `${payload.id}:${recipient}` : payload.id,
        messageId: payload.data.email_id,
        providerId: payload.data.email_id,
        recipient,
        ...(recipient ? { recipientDomain: recipient.split("@")[1] } : {}),
        status,
        timestamp: new Date(payload.created_at),
        provider: { [PROVIDER]: metadata },
        raw: payload,
        ...details,
      };
      return { type, data } as WebhookEvent;
    });
  };

  const providerFetch = createAIInbxProviderFetch(baseUrl, config.apiKey);

  return {
    id: driverId,
    name: PROVIDER,
    capabilities: AIINBX_CAPABILITIES,
    providerFetch,

    sendEmail: async (
      message: EmailMessage<typeof AIINBX_CAPABILITIES>,
      options?: SendEmailOptions,
    ): Promise<SendEmailResult> => {
      if (!message.html && !message.text) {
        throw new EmailKitError(
          "Either html or text must be provided",
          PROVIDER,
          "MISSING_REQUIRED_FIELD",
        );
      }

      const reply = resolveMessageReplyContext(message);
      if (reply.isReply && !reply.threadId) {
        throw new EmailKitError(
          "AIInbx replies are threaded by reply.threadId. Pass the inbound event's reply.threadId.",
          PROVIDER,
          "INVALID_REPLY_CONTEXT",
        );
      }

      const providerOptions = (message.provider ?? {}) as AIInbxSendOptions;
      const suppressionKey =
        providerOptions.suppressionKey ?? message.unsubscribe?.listId;
      const replyTo = replyAddressesAsArray(reply);

      const body = {
        from: {
          address: message.from.email,
          ...(message.from.name ? { name: message.from.name } : {}),
        },
        to: emailsOf(message.to),
        subject: message.subject,
        ...(message.html ? { html: message.html } : {}),
        ...(message.text ? { text: message.text } : {}),
        ...(message.cc ? { cc: emailsOf(message.cc) } : {}),
        ...(message.bcc ? { bcc: emailsOf(message.bcc) } : {}),
        ...(replyTo.length > 0 ? { reply_to: emailsOf(replyTo) } : {}),
        ...(message.headers ? { headers: message.headers } : {}),
        ...(message.attachments?.length
          ? {
              attachments: await Promise.all(
                message.attachments.map((attachment) =>
                  toOutboundAttachment(attachment, providerFetch),
                ),
              ),
            }
          : {}),
        ...(message.sendAt
          ? { scheduled_at: new Date(message.sendAt).toISOString() }
          : {}),
        ...(message.unsubscribe ? { unsubscribe: true } : {}),
        ...(suppressionKey ? { suppression_key: suppressionKey } : {}),
        ...(providerOptions.pacing ? { pacing: providerOptions.pacing } : {}),
      };

      // Replying on the thread lets AIInbx derive In-Reply-To and References.
      const { data, response } = await request<AIInbxSendResponse>(
        reply.threadId
          ? `/threads/${encodeURIComponent(reply.threadId)}/reply`
          : "/emails",
        {
          method: "POST",
          signal: options?.signal,
          headers: message.idempotencyKey
            ? { "Idempotency-Key": message.idempotencyKey }
            : undefined,
          body,
        },
        "send email",
      );

      const requestId = response.headers.get("x-request-id");
      return {
        // Outbound webhooks identify the email by AIInbx id, not RFC Message-ID.
        messageId: data.id,
        provider: driverId,
        providerId: data.id,
        threadId: data.thread_id,
        ...(requestId ? { requestId } : {}),
        // Suppressed recipients are dropped before sending, not an error.
        ...(data.suppressed.length > 0 ? { rejected: data.suppressed } : {}),
      };
    },

    handleWebhook: async (
      request: WebhookRequest,
    ): Promise<WebhookEventResult> => {
      const payload = request.body as AIInbxWebhookPayload;

      switch (payload.type) {
        case "email.received":
          return {
            type: "inbound",
            data: await loadInboundEvent(payload.data.email_id, {
              eventId: payload.id,
              raw: payload,
              webhook: payload,
            }),
          };
        case "email.sent":
          return toOutboundEvents(
            "outbound",
            "sent",
            payload,
            payload.data.to.slice(0, 1),
            {
              from: { email: payload.data.from },
              to: toAddresses(payload.data.to),
              subject: payload.data.subject,
            },
          );
        case "email.delivered":
          return toOutboundEvents(
            "delivered",
            "delivered",
            payload,
            payload.data.recipients,
          );
        case "email.bounced":
          return toOutboundEvents(
            "bounced",
            "bounced",
            payload,
            payload.data.recipients,
            {
              severity: payload.data.permanent ? "permanent" : "temporary",
              reason: payload.data.reason,
            },
          );
        case "email.complained":
          return toOutboundEvents(
            "complained",
            "complained",
            payload,
            payload.data.recipients,
            payload.data.reason ? { feedback: payload.data.reason } : {},
          );
        case "email.failed":
          return toOutboundEvents("rejected", "rejected", payload, [], {
            reason: payload.data.reason,
          });
        case "email.opened":
          return toOutboundEvents(
            "opened",
            "opened",
            payload,
            [],
            engagementDetails(payload.data),
          );
        case "email.clicked":
          return toOutboundEvents("clicked", "clicked", payload, [], {
            url: payload.data.url,
            ...engagementDetails(payload.data),
          });
        case "email.unsubscribed":
          return toOutboundEvents(
            "unsubscribed",
            "unsubscribed",
            payload,
            [payload.data.address],
            {
              ...(payload.data.key !== "*" ? { listId: payload.data.key } : {}),
              source: payload.data.source,
            },
          );
        case "mailbox.connected":
        case "mailbox.needs_reauth":
        case "mailbox.disconnected":
          return toMailboxEvent(payload, driverId);
        default:
          return { type: "unknown", data: payload };
      }
    },

    verifyWebhook: async (request: WebhookRequest): Promise<boolean> => {
      // An empty secret is an unset env var, not a key anyone can sign with.
      const secrets = [config.webhookSecret ?? []].flat().filter(Boolean);
      if (secrets.length === 0) return false;

      // AIInbx-Signature: t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<raw body>">
      const header = getHeader(request.headers, "aiinbx-signature");
      if (!header) return false;
      const parts = new Map(
        header.split(",").map((part) => {
          const [key = "", ...value] = part.trim().split("=");
          return [key, value.join("=")] as const;
        }),
      );
      const timestamp = parts.get("t");
      const signature = parts.get("v1");
      if (
        !timestamp ||
        !signature ||
        !isFreshWebhookTimestamp(timestamp, PROVIDER)
      ) {
        return false;
      }

      return verifySignature(
        secrets,
        timestamp,
        signature,
        requireRawBody(request, PROVIDER),
      );
    },

    webhookResponse: async (): Promise<WebhookResponse> => ({ status: 204 }),

    mailboxes: {
      /**
       * AIInbx hosts the OAuth flow and keeps the tokens. The customer lands
       * on `landingUrl` whether or not they approved — `mailbox.connected`
       * (→ `hooks.mailbox.onConnected`) is the signal that the mailbox is live.
       */
      connect: async (
        input: ConnectMailboxInput,
      ): Promise<MailboxConnectionResult> => {
        if (!input.landingUrl) {
          throw new EmailKitError(
            "Mailbox connect requires landingUrl or publicRoutes.connectLandingRoutes.success",
            PROVIDER,
            "MISSING_REQUIRED_FIELD",
          );
        }
        const ref = encodeMailboxRef(input.context);

        const { data } = await request<{ url: string }>(
          "/mailboxes/connect",
          {
            method: "POST",
            body: {
              ...input.provider,
              return_to: input.landingUrl,
              ...(ref ? { ref } : {}),
            },
          },
          "connect mailbox",
        );
        return {
          redirectUrl: data.url,
          landingUrl: input.landingUrl,
          context: input.context,
          raw: data,
        };
      },

      list: async (opts?: ListMailboxesOptions): Promise<Mailbox[]> => {
        const mailboxes = (
          await listAll<AIInbxMailbox>(
            "/mailboxes",
            "list mailboxes",
            opts?.status ? undefined : opts?.limit,
          )
        ).map(normalizeMailbox);
        if (!opts?.status) return mailboxes;

        return mailboxes
          .filter((mailbox) => mailbox.status === opts.status)
          .slice(0, opts.limit);
      },

      get: async (idOrEmail: string): Promise<Mailbox> => {
        const { data } = await request<AIInbxMailbox>(
          await mailboxPath(idOrEmail),
          { method: "GET" },
          "get mailbox",
        );
        return normalizeMailbox(data);
      },

      delete: async (idOrEmail: string): Promise<MailboxDeleteResult> => {
        await request(
          await mailboxPath(idOrEmail),
          { method: "DELETE" },
          "disconnect mailbox",
        );
        return { deleted: true };
      },
    },

    webhooks: {
      account: {
        setup: async (
          input: AccountWebhookSetupInput,
        ): Promise<AccountWebhookSetupResult> => {
          if (!input.url?.trim()) {
            throw new EmailKitError(
              "Webhook setup requires input.url",
              PROVIDER,
              "MISSING_REQUIRED_FIELD",
            );
          }

          const routing = toRoutingRules(input.inbound?.recipients);
          const { data: raw } = await request<AIInbxWebhookEndpoint>(
            "/webhook-endpoints",
            {
              method: "POST",
              body: {
                url: input.url,
                subscriptions: toAIInbxWebhookEvents(input.events),
                ...(routing ? { routing } : {}),
                ...input.provider,
              },
            },
            "create webhook",
          );
          return { webhook: normalizeWebhookEndpoint(raw), raw };
        },

        refresh: async (
          input: AccountWebhookRefreshInput,
        ): Promise<AccountWebhookRefreshResult> => {
          const webhookId = requireWebhookId(input, "refresh");
          const { data: raw } = await request<AIInbxWebhookEndpoint>(
            `/webhook-endpoints/${encodeURIComponent(webhookId)}`,
            { method: "GET" },
            "refresh webhook",
          );
          return {
            webhook: {
              ...normalizeWebhookEndpoint(raw),
              // The signing secret is only returned on creation.
              ...(input.webhook?.provider
                ? { provider: input.webhook.provider }
                : {}),
            },
            raw,
          };
        },

        delete: async (
          input: AccountWebhookDeleteInput,
        ): Promise<AccountWebhookDeleteResult> => {
          const webhookId = requireWebhookId(input, "delete");
          await request(
            `/webhook-endpoints/${encodeURIComponent(webhookId)}`,
            { method: "DELETE" },
            "delete webhook",
          );
          return {
            deleted: true,
            webhook: {
              id: input.webhook?.id || webhookId,
              providerId: webhookId,
              scope: "account",
              url: input.webhook?.url || "",
              events: input.webhook?.events,
              status: "deleted",
            },
          };
        },
      },
    },

    sync: {
      /**
       * Replay missed inbound emails.
       *
       * `GET /emails` lists newest-first with cursor pagination and no time
       * filter, so the lightweight list items for the window are buffered
       * while paging back to `since`, then replayed oldest-first. The heavy
       * work (full email + attachments per id) streams lazily at yield time.
       * Replayed events carry no webhook event id or verdicts; dedupe against
       * live webhooks by `messageId`. Outbound delivery events are not
       * replayed.
       */
      account: async function* (input: AccountSyncInput): SyncStream {
        const since = input.since.getTime();
        const until = (input.until ?? new Date()).getTime();

        const windowed: AIInbxEmail[] = [];
        let cursor: string | undefined;

        pagination: do {
          const { data: page } = await request<AIInbxPage<AIInbxEmail>>(
            "/emails",
            {
              method: "GET",
              signal: input.signal,
              searchParams: {
                direction: "inbound",
                limit: String(LIST_PAGE_SIZE),
                cursor,
              },
            },
            "list emails",
          );

          for (const email of page.data) {
            const createdAt = new Date(email.created_at).getTime();
            if (Number.isNaN(createdAt)) continue;
            // Newest-first: everything after this item is older than `since`.
            if (createdAt < since) break pagination;
            if (createdAt >= until) continue;
            windowed.push(email);
          }

          cursor = page.next_cursor ?? undefined;
        } while (cursor);

        for (const email of windowed.reverse()) {
          yield {
            type: "inbound",
            data: await loadInboundEvent(email.id, {
              eventId: `${email.id}:received`,
              signal: input.signal,
            }),
          };
        }

        return { syncedFrom: input.since };
      },
    },

    domains: {
      list: async (opts?: ListDomainsOptions): Promise<Domain[]> => {
        const domains = (
          await listAll<AIInbxDomain>(
            "/domains",
            "list domains",
            opts?.status ? undefined : opts?.limit,
          )
        ).map(normalizeDomain);
        if (!opts?.status) return domains;

        // v2 domains are either verified or pending; nothing is "unverified".
        return domains
          .filter((domain) => domain.status === opts.status)
          .slice(0, opts.limit);
      },

      create: async (input: CreateDomainInput): Promise<Domain> => {
        const { data: created } = await request<AIInbxDomain>(
          "/domains",
          {
            method: "POST",
            body: {
              name: input.domain,
              ...(input.region ? { region: input.region } : {}),
              ...input.provider,
            },
          },
          "create domain",
        );
        if (!input.tracking) return normalizeDomain(created);

        // Tracking is not part of the create request.
        const { data: updated } = await request<AIInbxDomain>(
          `/domains/${created.id}`,
          {
            method: "PATCH",
            body: {
              track_opens: input.tracking.opens,
              track_clicks: input.tracking.clicks,
            },
          },
          "update domain",
        );
        return normalizeDomain(updated);
      },

      get: async (idOrName: string): Promise<Domain> => {
        const { data } = await request<AIInbxDomain>(
          await domainPath(idOrName),
          { method: "GET" },
          "get domain",
        );
        return normalizeDomain(data);
      },

      update: async (
        idOrName: string,
        patch: UpdateDomainInput,
      ): Promise<Domain> => {
        const { data } = await request<AIInbxDomain>(
          await domainPath(idOrName),
          {
            method: "PATCH",
            body: {
              track_opens: patch.tracking?.opens,
              track_clicks: patch.tracking?.clicks,
              ...patch.provider,
            },
          },
          "update domain",
        );
        return normalizeDomain(data);
      },

      verify: async (idOrName: string): Promise<DomainVerification> => {
        const { data } = await request<AIInbxDomain>(
          await domainPath(idOrName, "/verify"),
          { method: "POST" },
          "verify domain",
        );
        return normalizeDomainVerification(data, new Date());
      },

      delete: async (idOrName: string): Promise<DomainDeleteResult> => {
        await request(
          await domainPath(idOrName),
          { method: "DELETE" },
          "delete domain",
        );
        return { deleted: true };
      },
    },
  };
};

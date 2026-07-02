import {
  EmailKitError,
  type MailboxWebhookSetupInput,
  type Webhook,
  type WebhookRequest,
} from "../types";

const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 5 * 60;

export const getHeader = (
  headers: WebhookRequest["headers"],
  name: string,
): string | undefined => {
  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return value;
    }
  }
  return undefined;
};

// Signatures are computed over the exact raw request bytes; a re-stringified
// parsed body cannot reproduce them.
export const requireRawBody = (
  request: WebhookRequest,
  provider: string,
): string => {
  if (request.rawBody === undefined) {
    throw new EmailKitError(
      "Webhook signature verification requires the raw request body. Pass rawBody on WebhookRequest (the unparsed request text).",
      provider,
      "MISSING_RAW_BODY",
      500,
    );
  }
  return request.rawBody;
};

export const parseWebhookBody = (request: WebhookRequest): unknown => {
  if (typeof request.body === "string") {
    try {
      return JSON.parse(request.body);
    } catch {
      return request.body;
    }
  }
  return request.body;
};

export const webhookEvents = (
  events: MailboxWebhookSetupInput["events"],
): NonNullable<Webhook["events"]> => {
  if (events === "all") return ["inbound"];
  return events && events.length > 0 ? events : ["inbound"];
};

/**
 * When to renew a provider subscription/watch: `bufferMs` before expiration,
 * but never more than half the remaining lifetime.
 */
export const webhookRenewAfter = (
  expiresAt: Date | undefined,
  bufferMs: number,
): Date | undefined => {
  const expiresTime = expiresAt?.getTime();
  if (!expiresTime || Number.isNaN(expiresTime)) return undefined;

  const remainingMs = expiresTime - Date.now();
  if (remainingMs <= 1) return new Date(expiresTime - 1);

  const buffer = Math.min(bufferMs, Math.max(1, Math.floor(remainingMs / 2)));
  return new Date(expiresTime - buffer);
};

export const isFreshWebhookTimestamp = (
  timestamp: string,
  provider: string,
): boolean => {
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0) {
    return false;
  }

  const skewSeconds = Math.abs(Date.now() / 1000 - timestampSeconds);
  if (skewSeconds <= WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) return true;

  // A signed-but-stale request usually means server clock skew or delayed
  // delivery, not forgery — without this log it is indistinguishable from a
  // bad signature at the caller's 401.
  console.warn(
    `[emailkit] ${provider} webhook rejected: signed timestamp is ${Math.round(
      skewSeconds,
    )}s from server time (tolerance ${WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS}s). Check for server clock skew or delayed webhook delivery.`,
  );
  return false;
};

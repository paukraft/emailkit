/**
 * AES-256-GCM encrypted OAuth state helpers shared by OAuth mailbox drivers.
 *
 * The state parameter round-trips the PKCE verifier, callback URL, and user
 * context through the provider's authorization redirect without any server
 * side storage. It is encrypted and authenticated with the EmailKit secret.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "crypto";
import { EmailKitError } from "../types";

export const OAUTH_STATE_VERSION = 1;
const STATE_MAX_AGE_MS = 10 * 60 * 1000;
const STATE_ENCRYPTION_ALGORITHM = "aes-256-gcm";

export interface OAuthStatePayload {
  v: typeof OAUTH_STATE_VERSION;
  provider: string;
  nonce: string;
  issuedAt: number;
  callbackUrl: string;
  scopes: string[];
  codeVerifier: string;
  email?: string;
  context?: unknown;
}

export const createCodeVerifier = (): string =>
  randomBytes(32).toString("base64url");

export const createCodeChallenge = (verifier: string): string =>
  createHash("sha256").update(verifier).digest("base64url");

export const createStateNonce = (): string => randomBytes(16).toString("hex");

const stateEncryptionKey = (secret: string): Buffer =>
  createHash("sha256").update(secret).digest();

export const encodeOAuthState = (
  payload: OAuthStatePayload,
  secret: string,
): string => {
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

export interface DecodeOAuthStateOptions {
  /** EmailKit provider id used for thrown EmailKitErrors. */
  provider: string;
  /** Human readable provider label used in error messages (e.g. "Outlook"). */
  label: string;
}

export const decodeOAuthState = <T extends OAuthStatePayload>(
  state: string,
  secret: string,
  { provider, label }: DecodeOAuthStateOptions,
): T => {
  const [ivPart, encryptedPart, tagPart, extra] = state.split(".");
  if (!ivPart || !encryptedPart || !tagPart || extra !== undefined) {
    throw new EmailKitError(
      `Invalid ${label} OAuth state`,
      provider,
      "INVALID_STATE",
    );
  }

  let parsed: T;
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
    parsed = JSON.parse(decrypted) as T;
  } catch (error) {
    throw new EmailKitError(
      `Invalid ${label} OAuth state payload`,
      provider,
      "INVALID_STATE",
      undefined,
      error,
    );
  }
  if (parsed.v !== OAUTH_STATE_VERSION || parsed.provider !== provider) {
    throw new EmailKitError(
      `Unsupported ${label} OAuth state`,
      provider,
      "INVALID_STATE",
    );
  }
  if (typeof parsed.issuedAt !== "number") {
    throw new EmailKitError(
      `${label} OAuth state is missing an issuedAt timestamp`,
      provider,
      "INVALID_STATE",
    );
  }
  if (Date.now() - parsed.issuedAt > STATE_MAX_AGE_MS) {
    throw new EmailKitError(
      `${label} OAuth state has expired; please reconnect the mailbox`,
      provider,
      "EXPIRED_STATE",
    );
  }
  if (!parsed.codeVerifier) {
    throw new EmailKitError(
      `${label} OAuth state is missing PKCE verifier`,
      provider,
      "INVALID_STATE",
    );
  }
  if (!parsed.callbackUrl) {
    throw new EmailKitError(
      `${label} OAuth state is missing callbackUrl`,
      provider,
      "INVALID_STATE",
    );
  }
  return parsed;
};

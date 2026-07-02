/**
 * Minimal RFC 2822/2045 MIME utilities for drivers whose provider APIs speak
 * raw messages (Gmail `users.messages.send`) instead of structured JSON.
 *
 * Covers exactly what EmailKit sends: UTF-8 text/html bodies, regular and
 * inline (CID) attachments, reply headers, and custom headers. Also provides
 * the inverse helpers needed to normalize inbound raw-header address lists.
 */

import { randomBytes } from "crypto";
import type { Attachment, EmailAddress } from "../types";
import { base64ToBytes, bytesToBase64, stringToBase64 } from "./base64";

const CRLF = "\r\n";

const isAscii = (value: string): boolean => /^[\x20-\x7e]*$/.test(value);

/** RFC 2047 B-encoded word for non-ASCII header text. */
export const encodeHeaderText = (value: string): string =>
  isAscii(value) ? value : `=?UTF-8?B?${stringToBase64(value)}?=`;

const quoteDisplayName = (name: string): string => {
  if (!isAscii(name)) return encodeHeaderText(name);
  return /[^A-Za-z0-9 !#$%&'*+\-/=?^_`{|}~]/.test(name)
    ? `"${name.replace(/[\\"]/g, "\\$&")}"`
    : name;
};

export const formatMimeAddress = (address: EmailAddress): string =>
  address.name
    ? `${quoteDisplayName(address.name)} <${address.email}>`
    : address.email;

export const formatMimeAddressList = (
  addresses: EmailAddress | EmailAddress[],
): string =>
  (Array.isArray(addresses) ? addresses : [addresses])
    .map(formatMimeAddress)
    .join(", ");

export const angleBracketMessageId = (messageId: string): string =>
  `<${messageId.trim().replace(/^</, "").replace(/>$/, "")}>`;

const foldBase64 = (b64: string): string => {
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join(CRLF);
};

const quoteMimeParam = (value: string): string =>
  `"${value.replace(/[\\"]/g, "\\$&").replace(/[\r\n]+/g, " ")}"`;

interface MimePart {
  headers: Array<[string, string]>;
  body: string;
}

/** RFC 5322 field name: printable ASCII except colon. */
export const isValidHeaderName = (name: string): boolean =>
  /^[!-9;-~]+$/.test(name);

const sanitizeHeaderName = (name: string): string => {
  if (!isValidHeaderName(name)) {
    throw new TypeError(`Invalid MIME header name: ${JSON.stringify(name)}`);
  }
  return name;
};

const sanitizeHeaderValue = (value: string): string =>
  value.replace(/[\r\n]+/g, " ");

const renderPart = (part: MimePart): string =>
  `${part.headers
    .map(
      ([name, value]) =>
        `${sanitizeHeaderName(name)}: ${sanitizeHeaderValue(value)}`,
    )
    .join(CRLF)}${CRLF}${CRLF}${part.body}`;

const multipart = (subtype: string, parts: MimePart[]): MimePart => {
  const boundary = `emailkit-${randomBytes(12).toString("hex")}`;
  return {
    headers: [
      ["Content-Type", `multipart/${subtype}; boundary=${quoteMimeParam(boundary)}`],
    ],
    body: `${parts
      .map((part) => `--${boundary}${CRLF}${renderPart(part)}`)
      .join(CRLF)}${CRLF}--${boundary}--`,
  };
};

const textPart = (content: string, contentType: string): MimePart => ({
  headers: [
    ["Content-Type", `${contentType}; charset=UTF-8`],
    ["Content-Transfer-Encoding", "base64"],
  ],
  body: foldBase64(stringToBase64(content)),
});

const attachmentPart = (attachment: Attachment): MimePart => {
  const filename = encodeHeaderText(attachment.filename);
  const headers: Array<[string, string]> = [
    [
      "Content-Type",
      `${attachment.contentType || "application/octet-stream"}; name=${quoteMimeParam(filename)}`,
    ],
    ["Content-Transfer-Encoding", "base64"],
    [
      "Content-Disposition",
      `${attachment.isInline ? "inline" : "attachment"}; filename=${quoteMimeParam(filename)}`,
    ],
  ];
  if (attachment.contentId) {
    headers.push(["Content-ID", angleBracketMessageId(attachment.contentId)]);
  }

  return {
    headers,
    body: foldBase64(
      typeof attachment.content === "string"
        ? stringToBase64(attachment.content)
        : bytesToBase64(attachment.content || new Uint8Array()),
    ),
  };
};

export interface BuildMimeMessageInput {
  from: EmailAddress;
  to: EmailAddress | EmailAddress[];
  cc?: EmailAddress | EmailAddress[];
  bcc?: EmailAddress | EmailAddress[];
  subject: string;
  text?: string;
  html?: string;
  replyTo?: EmailAddress[];
  /** Full RFC Message-ID for the outgoing message, with angle brackets. */
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  headers?: Record<string, string>;
  attachments?: Attachment[];
}

/**
 * Build a complete RFC 2822 message. Attachments must carry `content`;
 * callers are responsible for rejecting URL-only attachments first.
 */
export const buildMimeMessage = (input: BuildMimeMessageInput): string => {
  const headers: Array<[string, string]> = [
    ["MIME-Version", "1.0"],
    ["From", formatMimeAddress(input.from)],
    ["To", formatMimeAddressList(input.to)],
  ];
  if (input.cc && (!Array.isArray(input.cc) || input.cc.length > 0)) {
    headers.push(["Cc", formatMimeAddressList(input.cc)]);
  }
  if (input.bcc && (!Array.isArray(input.bcc) || input.bcc.length > 0)) {
    headers.push(["Bcc", formatMimeAddressList(input.bcc)]);
  }
  headers.push(["Subject", encodeHeaderText(input.subject)]);
  headers.push(["Message-ID", angleBracketMessageId(input.messageId)]);
  headers.push(["Date", new Date().toUTCString()]);
  if (input.replyTo && input.replyTo.length > 0) {
    headers.push(["Reply-To", formatMimeAddressList(input.replyTo)]);
  }
  if (input.inReplyTo) {
    headers.push(["In-Reply-To", angleBracketMessageId(input.inReplyTo)]);
  }
  if (input.references && input.references.length > 0) {
    headers.push([
      "References",
      input.references.map(angleBracketMessageId).join(" "),
    ]);
  }
  for (const [name, value] of Object.entries(input.headers || {})) {
    headers.push([name, String(value)]);
  }

  const bodies: MimePart[] = [];
  if (input.text !== undefined) bodies.push(textPart(input.text, "text/plain"));
  if (input.html !== undefined) bodies.push(textPart(input.html, "text/html"));
  let content: MimePart =
    bodies.length > 1
      ? multipart("alternative", bodies)
      : bodies[0] || textPart("", "text/plain");

  const attachments = input.attachments || [];
  const inline = attachments.filter((attachment) => attachment.isInline);
  const regular = attachments.filter((attachment) => !attachment.isInline);
  if (inline.length > 0) {
    content = multipart("related", [content, ...inline.map(attachmentPart)]);
  }
  if (regular.length > 0) {
    content = multipart("mixed", [content, ...regular.map(attachmentPart)]);
  }

  return renderPart({
    headers: [...headers, ...content.headers],
    body: content.body,
  });
};

const qEncodingToBytes = (text: string): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === "_") {
      out.push(0x20);
    } else if (char === "=" && /^[0-9a-f]{2}$/i.test(text.slice(i + 1, i + 3))) {
      out.push(parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(char.charCodeAt(0));
    }
  }
  return Uint8Array.from(out);
};

/** Decode RFC 2047 encoded words in a header value (UTF-8/latin1 charsets). */
export const decodeEncodedWords = (value: string): string =>
  value.replace(
    /=\?([^?\s]+)\?([bBqQ])\?([^?\s]*)\?=/g,
    (match, charset: string, encoding: string, text: string) => {
      try {
        const bytes = /b/i.test(encoding)
          ? base64ToBytes(text)
          : qEncodingToBytes(text);
        return new TextDecoder(charset.toLowerCase()).decode(bytes);
      } catch {
        return match;
      }
    },
  );

const parseSingleAddress = (part: string): EmailAddress | undefined => {
  const trimmed = part.trim();
  if (!trimmed) return undefined;

  const angle = trimmed.match(/<([^<>]*)>\s*$/);
  if (angle) {
    const email = angle[1]!.trim();
    if (!email) return undefined;
    const name = decodeEncodedWords(
      trimmed
        .slice(0, angle.index)
        .trim()
        .replace(/^"(.*)"$/s, "$1")
        .replace(/\\(.)/g, "$1")
        .trim(),
    );
    return { email, ...(name ? { name } : {}) };
  }

  return /^\S+@\S+$/.test(trimmed) ? { email: trimmed } : undefined;
};

/** Parse an RFC 5322 address-list header value into EmailKit addresses. */
export const parseAddressListHeader = (
  value: string | undefined,
): EmailAddress[] => {
  if (!value) return [];

  const parts: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const char of value) {
    if (char === '"' && !inAngle) inQuotes = !inQuotes;
    if (!inQuotes) {
      if (char === "<") inAngle = true;
      else if (char === ">") inAngle = false;
      else if (char === "," && !inAngle) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    current += char;
  }
  parts.push(current);

  return parts
    .map(parseSingleAddress)
    .filter((address): address is EmailAddress => Boolean(address));
};

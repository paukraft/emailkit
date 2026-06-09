import type { EmailAddress, ReplyContext } from "../types";

const isReplyContext = (value: unknown): value is ReplyContext => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    "addresses" in record ||
    "messageId" in record ||
    "references" in record ||
    "threadId" in record ||
    "isReply" in record
  );
};

const normalizeEmailAddress = (address: EmailAddress): EmailAddress => {
  return {
    email: address.email.trim(),
    ...(address.name ? { name: address.name.trim() } : {}),
  };
};

const normalizeAddresses = (
  addresses?: EmailAddress | EmailAddress[] | null,
): EmailAddress[] => {
  if (!addresses) return [];
  const list = Array.isArray(addresses) ? addresses : [addresses];
  const normalized = list
    .filter((addr): addr is EmailAddress => Boolean(addr?.email))
    .map((addr) => normalizeEmailAddress(addr));

  const seen = new Set<string>();
  const deduped: EmailAddress[] = [];
  for (const addr of normalized) {
    const key = addr.email.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(addr);
    }
  }

  return deduped;
};

const normalizeReferences = (
  references?: string[] | string | null,
): string[] | undefined => {
  if (!references) return undefined;
  const refs = Array.isArray(references)
    ? references
    : references.split(/\s+/g);

  const trimmed = refs.map((ref) => ref.trim()).filter((ref) => ref.length > 0);

  const unique = Array.from(new Set(trimmed));
  return unique.length > 0 ? unique : undefined;
};

type ReplyParts = {
  addresses?: EmailAddress | EmailAddress[] | null;
  messageId?: string | null;
  references?: string[] | string | null;
  threadId?: string | null;
  isReply?: boolean | null;
};

export const buildReplyContext = (parts: ReplyParts): ReplyContext => {
  const addresses = normalizeAddresses(parts.addresses);
  const messageId = parts.messageId?.trim() || undefined;
  const references = normalizeReferences(parts.references);
  const threadId = parts.threadId?.trim() || undefined;

  const context: ReplyContext = {};

  if (addresses.length > 0) {
    context.addresses = addresses;
  }

  if (messageId) {
    context.messageId = messageId;
  }

  if (references) {
    context.references = references;
  }

  if (threadId) {
    context.threadId = threadId;
  }

  const inferredIsReply =
    parts.isReply ??
    Boolean(messageId || (references && references.length > 0));

  if (inferredIsReply) {
    context.isReply = true;
  }

  return context;
};

type ReplyInput = ReplyContext | undefined | null;

export const hasReplyData = (reply: ReplyContext): boolean => {
  const addresses = reply.addresses;
  return Boolean(
    (addresses && addresses.length > 0) ||
      reply.messageId ||
      (reply.references && reply.references.length > 0) ||
      reply.threadId ||
      reply.isReply,
  );
};

export const normalizeReplyInput = (input: ReplyInput): ReplyContext => {
  if (!input) return {};
  if (isReplyContext(input)) {
    return buildReplyContext({
      addresses: input.addresses,
      messageId: input.messageId,
      references: input.references,
      threadId: input.threadId,
      isReply: input.isReply,
    });
  }
  return {};
};

export const resolveMessageReplyContext = (message: {
  reply?: ReplyContext | Pick<ReplyContext, "addresses">;
}): ReplyContext => {
  return normalizeReplyInput(message.reply as ReplyContext | undefined);
};

export const replyAddressesAsArray = (
  reply?: ReplyContext | null,
): EmailAddress[] => {
  if (!reply?.addresses) return [];
  return reply.addresses;
};

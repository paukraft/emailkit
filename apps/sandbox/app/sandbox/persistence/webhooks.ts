import type {
  Webhook,
  WebhookEventType,
  WebhookScope,
  WebhookStatus,
} from "emailkit"
import { Prisma } from "../../../generated/prisma/client"

import { prisma } from "./prisma"

const WEBHOOK_STATUSES: WebhookStatus[] = [
  "active",
  "pending",
  "disabled",
  "deleted",
  "expired",
  "unknown",
]
const WEBHOOK_SCOPES: WebhookScope[] = [
  "account",
  "mailbox",
  "domain",
]

const toStatus = (value: string): WebhookStatus =>
  (WEBHOOK_STATUSES as string[]).includes(value)
    ? (value as WebhookStatus)
    : "unknown"

const isWebhookScope = (value: string): value is WebhookScope =>
  WEBHOOK_SCOPES.some((scope) => scope === value)

const toScope = (value: string): WebhookScope =>
  isWebhookScope(value) ? value : "account"

const jsonValue = (
  value: unknown
): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined => {
  if (value === undefined) return undefined
  if (value === null) return Prisma.JsonNull
  const serialized = JSON.stringify(value)
  if (serialized === undefined) return undefined
  return JSON.parse(serialized) as Prisma.InputJsonValue
}

const optionalString = (value: string | null | undefined) =>
  typeof value === "string" && value ? value : undefined

const optionalDate = (value: Date | null | undefined) => value ?? undefined

type WebhookRow = {
  id: string
  emailDriver: string
  scope: string
  providerId: string | null
  url: string
  events: Prisma.JsonValue | null
  status: string
  expiresAt: Date | null
  renewAfter: Date | null
  mailboxId: string | null
  mailboxEmail: string | null
  domain: string | null
  raw: Prisma.JsonValue | null
  createdAt: Date
  updatedAt: Date
}

export type SandboxWebhook = Webhook & {
  rowId: string
  mailboxId?: string
  mailboxEmail?: string
  domain?: string
}

export const toSandboxWebhook = (row: WebhookRow): SandboxWebhook => ({
  rowId: row.id,
  id: row.providerId ?? row.id,
  emailDriver: row.emailDriver,
  scope: toScope(row.scope),
  url: row.url,
  events: Array.isArray(row.events)
    ? (row.events as WebhookEventType[])
    : undefined,
  status: toStatus(row.status),
  providerId: optionalString(row.providerId),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  expiresAt: optionalDate(row.expiresAt),
  renewAfter: optionalDate(row.renewAfter),
  raw: row.raw ?? undefined,
  mailboxId: optionalString(row.mailboxId),
  mailboxEmail: optionalString(row.mailboxEmail),
  domain: optionalString(row.domain),
})

type UpsertInput = {
  emailDriver: string
  webhook: Webhook
  mailboxId?: string
  mailboxEmail?: string
  domain?: string
}

const mailboxEmailFromRaw = (raw: unknown): string | undefined => {
  if (!raw || typeof raw !== "object") return undefined
  const record = raw as Record<string, unknown>
  const mailbox = record.mailbox as { email?: unknown } | undefined
  if (typeof mailbox?.email === "string") return mailbox.email

  const user = record.user as
    | { mail?: unknown; userPrincipalName?: unknown }
    | undefined
  if (typeof user?.mail === "string") return user.mail
  if (typeof user?.userPrincipalName === "string") return user.userPrincipalName
}

const targetFromContext = (
  context: unknown,
  raw?: unknown,
  webhook?: Webhook
): { mailboxEmail?: string; domain?: string } => {
  if (!context || typeof context !== "object") {
    return {
      mailboxEmail:
        webhook?.scope === "mailbox" ? mailboxEmailFromRaw(raw) : undefined,
    }
  }
  const record = context as Record<string, unknown>
  const mailbox = record.mailbox as { email?: unknown } | undefined
  const mailboxEmail =
    typeof mailbox?.email === "string"
      ? mailbox.email
      : webhook?.scope === "mailbox"
        ? mailboxEmailFromRaw(raw)
        : undefined
  const domain =
    typeof record.domain === "string"
      ? record.domain
      : typeof (record.domain as { domain?: unknown } | undefined)?.domain ===
          "string"
        ? (record.domain as { domain: string }).domain
        : undefined
  return { mailboxEmail, domain }
}

export const upsertWebhook = async (input: UpsertInput) => {
  const { emailDriver, webhook } = input
  if (!webhook.providerId) {
    throw new Error("Cannot persist webhook without a providerId")
  }

  const mailbox = input.mailboxEmail
    ? await prisma.connectedMailbox.findUnique({
        where: {
          emailDriver_email: {
            emailDriver,
            email: input.mailboxEmail.toLowerCase(),
          },
        },
      })
    : null

  const data = {
    emailDriver,
    scope: webhook.scope,
    providerId: webhook.providerId,
    url: webhook.url,
    events: jsonValue(webhook.events ?? null) ?? Prisma.JsonNull,
    status: webhook.status,
    expiresAt: webhook.expiresAt ?? null,
    renewAfter: webhook.renewAfter ?? null,
    mailboxId: input.mailboxId ?? mailbox?.id ?? null,
    mailboxEmail: input.mailboxEmail?.toLowerCase() ?? null,
    domain: input.domain?.toLowerCase() ?? null,
    raw: jsonValue(webhook.raw ?? null) ?? Prisma.JsonNull,
  }

  return prisma.webhook.upsert({
    where: {
      emailDriver_scope_providerId: {
        emailDriver,
        scope: webhook.scope,
        providerId: webhook.providerId,
      },
    },
    create: data,
    update: data,
  })
}

export const deleteWebhookByProviderId = async (input: {
  emailDriver: string
  scope: WebhookScope
  providerId: string
}) =>
  prisma.webhook.deleteMany({
    where: {
      emailDriver: input.emailDriver,
      scope: input.scope,
      providerId: input.providerId,
    },
  })

export const findWebhookByRowId = async (rowId: string) => {
  const row = await prisma.webhook.findUnique({ where: { id: rowId } })
  return row ? toSandboxWebhook(row) : undefined
}

export const findWebhookByProviderId = async (input: {
  emailDriver: string
  scope?: WebhookScope
  providerId: string
}) => {
  const row = await prisma.webhook.findFirst({
    where: {
      emailDriver: input.emailDriver,
      providerId: input.providerId,
      ...(input.scope ? { scope: input.scope } : {}),
    },
  })
  return row ? toSandboxWebhook(row) : undefined
}

export const listWebhooks = async (emailDriver: string) => {
  const rows = await prisma.webhook.findMany({
    where: { emailDriver },
    orderBy: [{ scope: "asc" }, { updatedAt: "desc" }],
  })
  return rows.map(toSandboxWebhook)
}

export const listExpiringWebhooks = async (
  emailDriver: string,
  before: Date = new Date()
) => {
  const rows = await prisma.webhook.findMany({
    where: {
      emailDriver,
      OR: [{ renewAfter: { lte: before } }, { expiresAt: { lte: before } }],
    },
    orderBy: { expiresAt: "asc" },
  })
  return rows.map(toSandboxWebhook)
}

export const persistWebhookFromHook = async (event: {
  emailDriver: string
  webhook?: Webhook
  context?: unknown
  raw?: unknown
}) => {
  if (!event.webhook?.providerId) return
  const { mailboxEmail, domain } = targetFromContext(
    event.context,
    event.raw,
    event.webhook
  )
  await upsertWebhook({
    emailDriver: event.emailDriver,
    webhook: event.webhook,
    mailboxEmail,
    domain,
  })
}

export const findOutlookMailboxIdForSubscription = async (
  subscriptionId: string
) => {
  const row = await prisma.webhook.findFirst({
    where: {
      emailDriver: "outlook",
      scope: "mailbox",
      providerId: subscriptionId,
    },
    include: { mailbox: true },
  })
  return row?.mailbox ?? undefined
}

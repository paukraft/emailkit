import type { Mailbox } from "emailkit"
import { Prisma } from "../../../generated/prisma/client"

import { prisma } from "./prisma"

const OUTLOOK_DRIVER = "outlook"

const isMailboxStatus = (status: string | null): status is NonNullable<Mailbox["status"]> =>
  status === "connected" || status === "pending" || status === "disabled" || status === "unknown"

const jsonValue = (value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | undefined => {
  if (value === undefined) return undefined
  if (value === null) return Prisma.JsonNull

  const serialized = JSON.stringify(value)
  if (serialized === undefined) return undefined
  return JSON.parse(serialized) as Prisma.InputJsonValue
}

type MailboxRow = {
  providerMailboxId: string | null
  email: string
  displayName: string | null
  status: string
  auth: Prisma.JsonValue | null
  raw: Prisma.JsonValue | null
  createdAt: Date
  updatedAt: Date
}

const toMailbox = (record: MailboxRow): Mailbox => ({
  id: record.providerMailboxId ?? record.email,
  email: record.email,
  displayName: record.displayName ?? undefined,
  status: isMailboxStatus(record.status) ? record.status : "unknown",
  raw: record.raw ?? undefined,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
})

export type PersistedMailboxRecord = {
  emailDriver: string
  rowId: string
  mailbox: Mailbox
  auth?: Prisma.JsonValue
}

const toRecord = (
  record: MailboxRow & { emailDriver: string; id: string }
): PersistedMailboxRecord => ({
  emailDriver: record.emailDriver,
  rowId: record.id,
  mailbox: toMailbox(record),
  auth: record.auth ?? undefined,
})

export const persistOutlookMailbox = async (
  emailDriver: string,
  mailbox: Mailbox,
  auth?: unknown,
) => {
  if (emailDriver !== OUTLOOK_DRIVER) return

  const email = mailbox.email.toLowerCase()
  await prisma.connectedMailbox.upsert({
    where: {
      emailDriver_email: { emailDriver, email },
    },
    create: {
      emailDriver,
      email,
      providerMailboxId: mailbox.id,
      displayName: mailbox.displayName,
      status: mailbox.status ?? "unknown",
      auth: jsonValue(auth),
      raw: jsonValue(mailbox.raw),
    },
    update: {
      providerMailboxId: mailbox.id,
      displayName: mailbox.displayName,
      status: mailbox.status ?? "unknown",
      ...(auth !== undefined ? { auth: jsonValue(auth) } : {}),
      raw: jsonValue(mailbox.raw),
    },
  })
}

export const findPersistedMailbox = async (
  email: string,
  emailDriver?: string
): Promise<PersistedMailboxRecord | undefined> => {
  const record = await prisma.connectedMailbox.findFirst({
    where: {
      email: email.toLowerCase(),
      ...(emailDriver ? { emailDriver } : {}),
    },
    orderBy: { updatedAt: "desc" },
  })
  return record ? toRecord(record) : undefined
}

export const deletePersistedMailbox = async (emailDriver: string, idOrEmail: string) => {
  const key = idOrEmail.toLowerCase()
  const result = await prisma.connectedMailbox.deleteMany({
    where: {
      emailDriver,
      OR: [{ email: key }, { providerMailboxId: idOrEmail }, { id: idOrEmail }],
    },
  })
  return result.count > 0
}

export const listPersistedMailboxes = async (
  emailDriver: string
): Promise<PersistedMailboxRecord[]> => {
  const records = await prisma.connectedMailbox.findMany({
    where: { emailDriver },
    orderBy: { updatedAt: "desc" },
  })
  return records.map(toRecord)
}

export const findPersistedOutlookMailboxForWebhook = async (input: {
  subscriptionId?: string
  providerMailboxId?: string
}): Promise<PersistedMailboxRecord | undefined> => {
  const mailboxes = await prisma.connectedMailbox.findMany({
    where: { emailDriver: OUTLOOK_DRIVER },
    orderBy: { updatedAt: "desc" },
  })

  const match = mailboxes.find((record) => {
    if (input.providerMailboxId && record.providerMailboxId === input.providerMailboxId) {
      return true
    }

    const raw = record.raw as
      | {
          user?: { id?: string }
          id?: string
          inboundSubscription?: { id?: string }
        }
      | null
    if (input.providerMailboxId && raw?.user?.id === input.providerMailboxId) {
      return true
    }
    if (input.providerMailboxId && raw?.id === input.providerMailboxId) {
      return true
    }
    return Boolean(input.subscriptionId && raw?.inboundSubscription?.id === input.subscriptionId)
  })

  return match ? toRecord(match) : undefined
}

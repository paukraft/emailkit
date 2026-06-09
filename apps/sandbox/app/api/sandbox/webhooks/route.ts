import type { WebhookEventSelection } from "emailkit"

import { handleWebhookAction, jsonError, jsonOk } from "@/app/sandbox/actions"
import type { WebhookSetupTarget } from "@/app/sandbox/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
const arr = (value: unknown) =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined

const parseEvents = (value: unknown): WebhookEventSelection | undefined => {
  if (value === "all") return "all"
  const events = arr(value)
  return events && events.length ? (events as WebhookEventSelection) : undefined
}

const parseTarget = (body: Record<string, unknown>): WebhookSetupTarget => {
  const scope = str(body.scope) ?? "account"
  if (scope === "mailbox") {
    const mailboxEmail = str(body.mailboxEmail)
    if (!mailboxEmail) throw new Error("mailboxEmail is required for mailbox-scoped webhooks.")
    return { scope: "mailbox", mailboxEmail }
  }
  if (scope === "domain") {
    const domain = str(body.domain)
    if (!domain) throw new Error("domain is required for domain-scoped webhooks.")
    return { scope: "domain", domain }
  }
  return { scope: "account" }
}

export async function GET(request: Request) {
  const url = new URL(request.url)
  const emailDriver = str(url.searchParams.get("emailDriver"))
  if (!emailDriver) return jsonError(new Error("emailDriver is required."))
  try {
    return jsonOk(await handleWebhookAction({ action: "list", emailDriver }))
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const action = str(body.action) ?? "list"
    const emailDriver = str(body.emailDriver)
    if (!emailDriver) throw new Error("emailDriver is required.")

    if (action === "list" || action === "renew-expiring") {
      return jsonOk(await handleWebhookAction({ action, emailDriver }))
    }

    if (action === "setup") {
      return jsonOk(
        await handleWebhookAction({
          action,
          emailDriver,
          target: parseTarget(body),
          url: str(body.url),
          events: parseEvents(body.events),
        }),
      )
    }

    if (action === "refresh" || action === "delete") {
      const rowId = str(body.rowId)
      if (!rowId) throw new Error("rowId is required.")
      return jsonOk(await handleWebhookAction({ action, emailDriver, rowId }))
    }

    throw new Error(`Unknown webhook action: ${action}`)
  } catch (error) {
    return jsonError(error)
  }
}

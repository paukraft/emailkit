import { handleSyncAction, jsonError, jsonOk } from "@/app/sandbox/actions"
import type { SyncTarget } from "@/app/sandbox/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined

const parseTarget = (body: Record<string, unknown>): SyncTarget => {
  const scope = str(body.scope) ?? "account"
  if (scope === "account") return { scope }
  if (scope === "mailbox") {
    const mailboxEmail = str(body.mailboxEmail)
    if (!mailboxEmail) throw new Error("mailboxEmail is required for mailbox sync.")
    return { scope, mailboxEmail }
  }
  if (scope === "domain") {
    const domain = str(body.domain)
    if (!domain) throw new Error("domain is required for domain sync.")
    return { scope, domain }
  }
  throw new Error(`Unknown sync scope: ${scope}`)
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const emailDriver = str(body.emailDriver)
    if (!emailDriver) throw new Error("emailDriver is required.")
    const since = str(body.since)
    if (!since) throw new Error("since is required.")

    const result = await handleSyncAction({
      emailDriver,
      target: parseTarget(body),
      since,
      until: str(body.until),
      context: body.context,
    })
    return jsonOk({ result })
  } catch (error) {
    return jsonError(error)
  }
}

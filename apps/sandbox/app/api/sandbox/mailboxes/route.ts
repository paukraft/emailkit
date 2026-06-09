import { handleMailboxAction, jsonError, jsonOk } from "@/app/sandbox/actions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const str = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined
const obj = <T extends Record<string, unknown>>(value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as T)
    : undefined
const arr = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined

export async function GET(request: Request) {
  const url = new URL(request.url)
  const emailDriver = str(url.searchParams.get("emailDriver"))
  if (!emailDriver) return jsonError(new Error("emailDriver is required."))

  try {
    return jsonOk(await handleMailboxAction({ action: "list", emailDriver }))
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

    if (action === "connect") {
      return jsonOk(
        await handleMailboxAction({
          action,
          emailDriver,
          input: {
            email: str(body.email),
            callbackUrl: str(body.callbackUrl),
            scopes: arr(body.scopes),
            context: body.context,
            provider: obj(body.provider),
          },
        })
      )
    }

    if (action === "create") {
      const email = str(body.email)
      if (!email) throw new Error("email is required.")
      return jsonOk(
        await handleMailboxAction({
          action,
          emailDriver,
          input: {
            email,
            displayName: str(body.displayName),
            auth: body.auth,
            context: body.context,
            provider: obj(body.provider),
          },
        })
      )
    }

    if (action === "get" || action === "delete") {
      const idOrEmail = str(body.idOrEmail)
      if (!idOrEmail) throw new Error("idOrEmail is required.")
      return jsonOk(
        await handleMailboxAction({ action, emailDriver, idOrEmail })
      )
    }

    if (action === "list") {
      return jsonOk(
        await handleMailboxAction({
          action,
          emailDriver,
          options: obj(body.options),
        })
      )
    }

    throw new Error(`Unknown mailbox action: ${action}`)
  } catch (error) {
    return jsonError(error)
  }
}

import { handleDomainAction, jsonError, jsonOk, parseDomainIdentifier } from "@/app/sandbox/actions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const str = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)
const obj = <T extends Record<string, unknown>>(value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as T) : undefined

export async function GET(request: Request) {
  const url = new URL(request.url)
  const emailDriver = str(url.searchParams.get("emailDriver"))
  if (!emailDriver) return jsonError(new Error("emailDriver is required."))

  try {
    return jsonOk(await handleDomainAction({ action: "list", emailDriver }))
  } catch (error) {
    return jsonError(error)
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    const action = str(body.action) ?? "create"
    const emailDriver = str(body.emailDriver)
    if (!emailDriver) throw new Error("emailDriver is required.")

    if (action === "create" || action === "ensure") {
      const domain = str(body.domain)
      if (!domain) throw new Error("domain is required.")
      return jsonOk(
        await handleDomainAction({
          action,
          emailDriver,
          input: {
            domain,
            dkimSelector: str(body.dkimSelector),
            returnPathSubdomain: str(body.returnPathSubdomain),
            region: str(body.region),
            tracking: obj(body.tracking),
            provider: obj(body.provider),
          },
        }),
      )
    }

    if (action === "get" || action === "verify" || action === "delete") {
      return jsonOk(
        await handleDomainAction({
          action,
          emailDriver,
          identifier: parseDomainIdentifier(body),
        }),
      )
    }

    if (action === "update") {
      return jsonOk(
        await handleDomainAction({
          action,
          emailDriver,
          identifier: parseDomainIdentifier(body),
          patch: {
            dkimSelector: str(body.dkimSelector),
            returnPathSubdomain: str(body.returnPathSubdomain),
            tracking: obj(body.tracking),
            provider: obj(body.provider),
          },
        }),
      )
    }

    throw new Error(`Unknown domain action: ${action}`)
  } catch (error) {
    return jsonError(error)
  }
}

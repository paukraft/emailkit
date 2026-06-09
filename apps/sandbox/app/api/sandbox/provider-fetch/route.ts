import { jsonError, jsonOk, runProviderFetch } from "@/app/sandbox/actions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    if (typeof body.emailDriver !== "string" || typeof body.path !== "string") {
      throw new Error("emailDriver and path are required.")
    }
    return jsonOk({
      result: await runProviderFetch({
        emailDriver: body.emailDriver,
        path: body.path,
        init:
          body.init && typeof body.init === "object" && !Array.isArray(body.init)
            ? body.init
            : undefined,
      }),
    })
  } catch (error) {
    return jsonError(error)
  }
}

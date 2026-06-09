import { getAttachmentContent, jsonError, jsonOk } from "@/app/sandbox/actions"
import type { AttachmentInput } from "@/app/sandbox/types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>
    if (typeof body.emailDriver !== "string" || !body.attachment || typeof body.attachment !== "object") {
      throw new Error("emailDriver and attachment are required.")
    }
    return jsonOk({
      result: await getAttachmentContent({
        emailDriver: body.emailDriver,
        attachment: body.attachment as AttachmentInput["attachment"],
      }),
    })
  } catch (error) {
    return jsonError(error)
  }
}

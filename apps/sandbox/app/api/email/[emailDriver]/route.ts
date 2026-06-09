import {
  toEmailKitRequest,
  toNextResponse,
} from "emailkit/nextjs"
import type { NextRequest } from "next/server"

import { handleSandboxWebhook } from "@/app/sandbox/actions"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ emailDriver: string }> },
) {
  return handle(request, context)
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ emailDriver: string }> },
) {
  return handle(request, context)
}

async function handle(
  request: NextRequest,
  context: { params: Promise<{ emailDriver: string }> },
) {
  const { emailDriver } = await context.params
  const webhookRequest = await toEmailKitRequest(request, { emailDriver })
  const webhookResponse = await handleSandboxWebhook(emailDriver, webhookRequest)
  return toNextResponse(webhookResponse)
}

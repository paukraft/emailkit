import {
  nextRequestToWebhookRequest,
  webhookResponseToNextResponse,
} from "emailkit/nextjs";
import { notFound } from "next/navigation";
import type { NextRequest } from "next/server";

import { getSandboxProviderRuntime } from "@/lib/sandbox-providers";
import { recordSandboxEvent, runSandboxTrace } from "@/lib/sandbox-state";
import type { SandboxProviderId } from "@/lib/sandbox-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isProvider = (value: string): value is SandboxProviderId =>
  value === "mailgun" || value === "resend" || value === "aiinbx";

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;

  if (!isProvider(provider)) {
    notFound();
  }

  const response = await runSandboxTrace(provider, async () => {
    const runtime = getSandboxProviderRuntime(provider);
    const webhookRequest = await nextRequestToWebhookRequest(request);

    recordSandboxEvent({
      provider,
      category: "webhook",
      kind: "webhook-request",
      summary: `${runtime.info.label} webhook received`,
      details: {
        method: webhookRequest.method,
        query: webhookRequest.query,
        headers: webhookRequest.headers,
        body: webhookRequest.body,
      },
    });

    const response = await runtime.handleWebhook(webhookRequest);

    recordSandboxEvent({
      provider,
      category: "webhook",
      kind: "webhook-response",
      summary: `${runtime.info.label} webhook responded ${response.status}`,
      details: response,
    });

    return response;
  });

  return webhookResponseToNextResponse(response);
}

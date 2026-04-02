import { NextResponse } from "next/server";

import {
  getSandboxProviderRuntime,
  getSandboxProviders,
} from "@/lib/sandbox-providers";
import {
  buildSandboxSnapshot,
  recordSandboxEvent,
  runSandboxTrace,
} from "@/lib/sandbox-state";
import {
  SANDBOX_PROVIDERS,
  type SandboxProviderId,
  type SandboxSendPayload,
} from "@/lib/sandbox-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isProvider = (value: unknown): value is SandboxProviderId =>
  SANDBOX_PROVIDERS.includes(value as SandboxProviderId);

const parsePayload = (body: unknown): SandboxSendPayload => {
  if (!body || typeof body !== "object")
    throw new Error("Request body must be an object.");

  const b = body as Record<string, unknown>;

  if (!isProvider(b.provider)) throw new Error("Unknown provider.");

  const str = (key: string) => String(b[key] ?? "").trim() || undefined;
  const fromEmail = str("fromEmail");
  const toEmail = str("toEmail");
  const subject = str("subject");

  if (!fromEmail || !toEmail || !subject)
    throw new Error("fromEmail, toEmail, and subject are required.");

  return {
    provider: b.provider,
    fromEmail,
    fromName: str("fromName"),
    toEmail,
    ccEmail: str("ccEmail"),
    bccEmail: str("bccEmail"),
    subject,
    text: str("text"),
    html: str("html"),
    replyToEmail: str("replyToEmail"),
    inReplyToMessageId: str("inReplyToMessageId"),
    trackOpens: typeof b.trackOpens === "boolean" ? b.trackOpens : undefined,
    trackClicks: typeof b.trackClicks === "boolean" ? b.trackClicks : undefined,
    sendAt: str("sendAt"),
    unsubscribeGlobal: b.unsubscribeGlobal === true ? true : undefined,
    tags: Array.isArray(b.tags)
      ? b.tags.filter(
          (t): t is string => typeof t === "string" && t.trim() !== "",
        )
      : undefined,
    metadata:
      b.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata)
        ? (b.metadata as Record<string, string>)
        : undefined,
    headers:
      b.headers && typeof b.headers === "object" && !Array.isArray(b.headers)
        ? (b.headers as Record<string, string>)
        : undefined,
    templateId: str("templateId"),
    templateData:
      b.templateData && typeof b.templateData === "object"
        ? (b.templateData as Record<string, unknown>)
        : undefined,
    idempotencyKey: str("idempotencyKey"),
    tenantId: str("tenantId"),
  };
};

export async function POST(request: Request) {
  let provider: SandboxProviderId = "mailgun";
  let result: unknown;

  try {
    const payload = parsePayload(await request.json());
    provider = payload.provider;
    await runSandboxTrace(provider, async () => {
      const providerRuntime = getSandboxProviderRuntime(provider);
      result = await providerRuntime.send(payload);

      recordSandboxEvent({
        provider,
        category: "send",
        kind: "send-email",
        summary: `Sent "${payload.subject}" via ${providerRuntime.info.label}`,
        details: {
          to: payload.toEmail,
          from: payload.fromEmail,
          subject: payload.subject,
          result,
        },
      });
    });

    return NextResponse.json({
      ok: true,
      result,
      snapshot: buildSandboxSnapshot(getSandboxProviders()),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown send error";

    recordSandboxEvent({
      provider,
      category: "send",
      kind: "send-email-error",
      summary: "Send failed",
      details: { error: message },
    });

    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }
}

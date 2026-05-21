import { NextResponse } from "next/server";

import { getSandboxProviderRuntime } from "@/lib/sandbox-providers";
import { SANDBOX_PROVIDERS, type SandboxProviderId } from "@/lib/sandbox-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const isProvider = (value: unknown): value is SandboxProviderId =>
  SANDBOX_PROVIDERS.includes(value as SandboxProviderId);

const err = (message: string, status = 400) =>
  NextResponse.json({ ok: false, error: message }, { status });

/** GET /api/sandbox/domains?provider=mailgun */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const provider = searchParams.get("provider");
  if (!isProvider(provider)) return err("Unknown provider.");

  const { domains } = getSandboxProviderRuntime(provider);
  if (!domains) return err(`${provider} does not support domains.`);

  try {
    const list = await domains.list();
    return NextResponse.json({ ok: true, domains: list });
  } catch (error) {
    return err(error instanceof Error ? error.message : "Failed to list domains", 500);
  }
}

/** POST /api/sandbox/domains — create or action (verify/delete) */
export async function POST(request: Request) {
  const body = (await request.json()) as Record<string, unknown>;
  const provider = body.provider;
  if (!isProvider(provider)) return err("Unknown provider.");

  const { domains } = getSandboxProviderRuntime(provider);
  if (!domains) return err(`${provider} does not support domains.`);

  const action = (body.action as string) ?? "create";

  try {
    switch (action) {
      case "create": {
        const name = body.name as string | undefined;
        if (!name?.trim()) return err("Domain name is required.");
        const domain = await domains.create({ name: name.trim() });
        return NextResponse.json({ ok: true, domain });
      }

      case "get": {
        const identifier = body.identifier as { domain?: string; domainId?: string } | undefined;
        if (!identifier?.domain && !identifier?.domainId) return err("Domain identifier required.");
        const domain = await domains.get(identifier);
        return NextResponse.json({ ok: true, domain });
      }

      case "verify": {
        const identifier = body.identifier as { domain?: string; domainId?: string } | undefined;
        if (!identifier?.domain && !identifier?.domainId) return err("Domain identifier required.");
        const verification = await domains.verify(identifier);
        return NextResponse.json({ ok: true, verification });
      }

      case "delete": {
        const identifier = body.identifier as { domain?: string; domainId?: string } | undefined;
        if (!identifier?.domain && !identifier?.domainId) return err("Domain identifier required.");
        const result = await domains.delete(identifier);
        return NextResponse.json({ ok: true, ...result });
      }

      default:
        return err(`Unknown action: ${action}`);
    }
  } catch (error) {
    return err(error instanceof Error ? error.message : `Domain ${action} failed`, 500);
  }
}

import { NextResponse } from "next/server";

import { buildSandboxSnapshot, clearSandboxEvents } from "@/lib/sandbox-state";
import { getSandboxProviders } from "@/lib/sandbox-providers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(buildSandboxSnapshot(getSandboxProviders()));
}

export async function DELETE() {
  clearSandboxEvents();
  return NextResponse.json(buildSandboxSnapshot(getSandboxProviders()));
}

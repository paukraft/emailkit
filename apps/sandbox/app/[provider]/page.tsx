import { notFound } from "next/navigation";
import { SandboxClient } from "../sandbox-client";
import { getSandboxProviders } from "@/lib/sandbox-providers";
import { buildSandboxSnapshot } from "@/lib/sandbox-state";
import { SANDBOX_PROVIDERS, type SandboxProviderId } from "@/lib/sandbox-types";

export const dynamic = "force-dynamic";

export default async function Page({
  params,
}: {
  params: Promise<{ provider: string }>;
}) {
  const { provider } = await params;
  if (!SANDBOX_PROVIDERS.includes(provider as SandboxProviderId)) notFound();

  return (
    <SandboxClient
      initialSnapshot={buildSandboxSnapshot(getSandboxProviders())}
      selectedProvider={provider as SandboxProviderId}
    />
  );
}

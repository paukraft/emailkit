import { SandboxClient } from "./sandbox-client";
import { getSandboxProviders } from "@/lib/sandbox-providers";
import { buildSandboxSnapshot } from "@/lib/sandbox-state";

export const dynamic = "force-dynamic";

export default function Page() {
  return <SandboxClient initialSnapshot={buildSandboxSnapshot(getSandboxProviders())} />;
}

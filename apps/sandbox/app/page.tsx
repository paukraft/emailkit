import { SandboxClient } from "./sandbox-client"
import { getSandboxSnapshot } from "./sandbox/store"

export const dynamic = "force-dynamic"

export default function Page() {
  return <SandboxClient initialSnapshot={getSandboxSnapshot()} />
}

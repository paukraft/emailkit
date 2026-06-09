import { clearSandbox, getSandboxSnapshot } from "@/app/sandbox/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export function GET() {
  return Response.json(getSandboxSnapshot())
}

export function DELETE() {
  clearSandbox()
  return Response.json(getSandboxSnapshot())
}

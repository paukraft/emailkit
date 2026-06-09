import { getSandboxSnapshot, subscribeToSandbox } from "@/app/sandbox/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const encoder = new TextEncoder()
const event = (name: string, data: unknown) =>
  encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
const comment = (value: string) => encoder.encode(`: ${value}\n\n`)

export function GET(request: Request) {
  let closed = false
  let unsubscribe = () => {}
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const close = () => {
        if (closed) return
        closed = true
        unsubscribe()
        if (heartbeat) clearInterval(heartbeat)
        try {
          controller.close()
        } catch {}
      }
      const send = () => {
        if (!closed) controller.enqueue(event("snapshot", getSandboxSnapshot()))
      }

      request.signal.addEventListener("abort", close)
      controller.enqueue(encoder.encode("retry: 2000\n\n"))
      controller.enqueue(comment("connected"))
      send()
      unsubscribe = subscribeToSandbox(send)
      heartbeat = setInterval(() => {
        if (!closed) controller.enqueue(comment("heartbeat"))
      }, 15000)
    },
    cancel() {
      closed = true
      unsubscribe()
      if (heartbeat) clearInterval(heartbeat)
    },
  })

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  })
}

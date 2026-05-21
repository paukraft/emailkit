import { getSandboxProviders } from "@/lib/sandbox-providers";
import {
  buildSandboxSnapshot,
  subscribeToSandboxUpdates,
} from "@/lib/sandbox-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const encoder = new TextEncoder();
const HEARTBEAT_INTERVAL_MS = 15000;

const encodeEvent = (event: string, data: unknown): Uint8Array =>
  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const encodeComment = (comment: string): Uint8Array =>
  encoder.encode(`: ${comment}\n\n`);

export async function GET(request: Request) {
  const providers = getSandboxProviders();

  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;

    unsubscribe();
    request.signal.removeEventListener("abort", close);

    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }

    if (controllerRef) {
      try {
        controllerRef.close();
      } catch {}
      controllerRef = null;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller;

      const sendSnapshot = () => {
        if (closed || !controllerRef) return;
        controllerRef.enqueue(
          encodeEvent("snapshot", buildSandboxSnapshot(providers)),
        );
      };

      request.signal.addEventListener("abort", close);
      controller.enqueue(encoder.encode("retry: 2000\n\n"));
      controller.enqueue(encodeComment("connected"));
      sendSnapshot();

      unsubscribe = subscribeToSandboxUpdates(() => {
        try {
          sendSnapshot();
        } catch {
          close();
        }
      });

      heartbeat = setInterval(() => {
        if (closed || !controllerRef) return;

        try {
          controllerRef.enqueue(encodeComment("heartbeat"));
        } catch {
          close();
        }
      }, HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      close();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}

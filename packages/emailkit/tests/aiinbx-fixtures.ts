import { createHmac } from "node:crypto";

export const API = "https://api.aiinbx.com/api/v2";
export const WEBHOOK_SECRET = "aiinbx-webhook-secret";

export const jsonResponse = (
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) =>
  new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...init.headers },
  });

export const problemResponse = (
  status: number,
  code: string,
  detail: string,
  issues?: Array<{ path: string; message: string }>,
) =>
  new Response(
    JSON.stringify({
      type: `https://docs.aiinbx.com/problems/${code}`,
      title: "Error",
      status,
      detail,
      code,
      request_id: "req_1",
      ...(issues ? { issues } : {}),
    }),
    { status, headers: { "content-type": "application/problem+json" } },
  );

export const emailId = (n: number) => `eml_${String(n).padStart(32, "0")}`;
export const THREAD_ID = `thr_${"0".repeat(31)}1`;

/** `Email` schema — list item / send response base. */
export const listEmail = (
  id: string,
  createdAt: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  thread_id: THREAD_ID,
  space_id: null,
  direction: "inbound",
  status: "received",
  from: { name: "Buyer", address: "buyer@example.net" },
  to: ["agent@example.com"],
  subject: `Subject ${id}`,
  snippet: `Body ${id}`,
  category: "human",
  suppression_key: null,
  message_id: `<${id}@example.net>`,
  in_reply_to: null,
  verdicts: { spam: "PASS", spf: "PASS", dkim: "PASS", dmarc: null },
  idempotency_key: null,
  created_at: createdAt,
  scheduled_at: null,
  sent_at: null,
  ...overrides,
});

/** `FullEmail` schema — `GET /emails/{id}`. */
export const fullEmail = (
  id: string,
  createdAt: string,
  overrides: Record<string, unknown> = {},
) => ({
  ...listEmail(id, createdAt),
  cc: [],
  bcc: [],
  reply_to: [],
  html: null,
  text: `Body ${id}`,
  attachments: [],
  stripped_text: `Body ${id}`,
  stripped_html: null,
  segments: [{ kind: "written", text: `Body ${id}` }],
  references: [],
  headers: [{ name: "X-Test", value: "1" }],
  events: [],
  engagements: [],
  ...overrides,
});

export const webhookEnvelope = (
  type: string,
  data: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) => ({
  id: `evt_${"a".repeat(32)}`,
  type,
  created_at: "2026-09-01T10:31:04Z",
  space_id: null,
  data,
  ...overrides,
});

export const signedWebhookRequest = (
  body: unknown,
  opts: { secret?: string; timestamp?: number } = {},
) => {
  const rawBody = JSON.stringify(body);
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", opts.secret ?? WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return {
    method: "POST",
    headers: { "aiinbx-signature": `t=${timestamp},v1=${signature}` },
    body,
    rawBody,
  };
};

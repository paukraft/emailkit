import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AIInbxDriver,
  EmailKit,
  EmailKitError,
  getAIInbxAttachment,
  getAIInbxInbound,
  getAIInbxOutbound,
} from "../src";
import {
  API,
  THREAD_ID,
  WEBHOOK_SECRET,
  emailId,
  fullEmail,
  jsonResponse,
  listEmail,
  problemResponse,
  signedWebhookRequest,
  webhookEnvelope,
} from "./aiinbx-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sendResponse = (overrides: Record<string, unknown> = {}) =>
  jsonResponse(
    {
      ...listEmail(emailId(1), "2026-09-01T10:00:00Z", {
        direction: "outbound",
        status: "queued",
        message_id: "sent-1@example.com",
      }),
      suppressed: [],
      pacing: null,
      ...overrides,
    },
    { status: 201, headers: { "x-request-id": "req_123" } },
  );

const sentRequest = (fetchMock: ReturnType<typeof vi.fn>, call = 0) => {
  const [url, init] = fetchMock.mock.calls[call] as [URL, RequestInit];
  return {
    url: url.toString(),
    headers: new Headers(init.headers),
    body: JSON.parse(init.body as string),
  };
};

describe("AIInbxDriver sendEmail", () => {
  it("advertises the v2 capability model", () => {
    const driver = AIInbxDriver({ apiKey: "ai_test" });

    expect(driver.capabilities).toMatchObject({
      replyTo: true,
      replyHeaders: false,
      replyThreadId: true,
      customHeaders: true,
      scheduling: true,
      unsubscribe: true,
      sendIdempotency: true,
      eventTracking: { opens: true, clicks: true },
      providerFetch: true,
      webhooks: { account: true },
      sync: { account: true },
    });
    expect(driver.capabilities).not.toHaveProperty("sendTracking");
  });

  it("maps a message to POST /emails", async () => {
    const fetchMock = vi.fn(async (input: string | URL) =>
      input.toString() === "https://files.example.com/report.txt"
        ? new Response("from-url")
        : sendResponse({ suppressed: ["blocked@example.net"] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sendAt = new Date("2026-09-15T09:00:00.000Z");
    const result = await AIInbxDriver({ apiKey: "ai_test" }).sendEmail({
      from: { email: "agent@example.com", name: "Agent" },
      to: [{ email: "buyer@example.net" }, { email: "blocked@example.net" }],
      cc: { email: "cc@example.net" },
      subject: "Hello",
      text: "Plain",
      reply: { addresses: [{ email: "replies@example.com" }] },
      headers: { "X-Campaign-ID": "spring" },
      attachments: [
        {
          filename: "inline.png",
          content: "png",
          isInline: true,
          contentId: "logo",
        },
        { filename: "report.txt", url: "https://files.example.com/report.txt" },
      ],
      sendAt,
      unsubscribe: { listId: "product-updates" },
      idempotencyKey: "order-1",
      provider: { pacing: { skip: true } },
    });

    const { url, headers, body } = sentRequest(fetchMock, 1);
    expect(url).toBe(`${API}/emails`);
    expect(headers.get("authorization")).toBe("Bearer ai_test");
    expect(headers.get("idempotency-key")).toBe("order-1");
    expect(body).toEqual({
      from: { address: "agent@example.com", name: "Agent" },
      to: ["buyer@example.net", "blocked@example.net"],
      cc: ["cc@example.net"],
      subject: "Hello",
      text: "Plain",
      reply_to: ["replies@example.com"],
      headers: { "X-Campaign-ID": "spring" },
      attachments: [
        {
          filename: "inline.png",
          content_type: "application/octet-stream",
          content: Buffer.from("png").toString("base64"),
          cid: "logo",
        },
        {
          filename: "report.txt",
          content_type: "application/octet-stream",
          content: Buffer.from("from-url").toString("base64"),
        },
      ],
      scheduled_at: sendAt.toISOString(),
      unsubscribe: true,
      suppression_key: "product-updates",
      pacing: { skip: true },
    });
    expect(result).toEqual({
      messageId: "sent-1@example.com",
      provider: "aiinbx",
      providerId: emailId(1),
      threadId: THREAD_ID,
      requestId: "req_123",
      rejected: ["blocked@example.net"],
    });
  });

  it("authenticates AIInbx attachment URLs when forwarding, never external ones", async () => {
    const fetchMock = vi.fn(async (input: string | URL) =>
      input.toString() === `${API}/emails`
        ? sendResponse()
        : new Response("bytes"),
    );
    vi.stubGlobal("fetch", fetchMock);

    await AIInbxDriver({ apiKey: "ai_test" }).sendEmail({
      from: { email: "agent@example.com" },
      to: [{ email: "buyer@example.net" }],
      subject: "Fwd",
      text: "See attached",
      attachments: [
        { filename: "a.pdf", url: `${API}/attachments/att_1` },
        { filename: "b.pdf", url: "https://files.example.com/b.pdf" },
      ],
    });

    const authFor = (target: string) => {
      const call = fetchMock.mock.calls.find(
        ([input]) => input.toString() === target,
      ) as unknown as [URL, RequestInit];
      return new Headers(call[1].headers).get("authorization");
    };
    expect(authFor(`${API}/attachments/att_1`)).toBe("Bearer ai_test");
    expect(authFor("https://files.example.com/b.pdf")).toBeNull();
  });

  it("replies on the thread so AIInbx derives the reply headers", async () => {
    const fetchMock = vi.fn(async () => sendResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await AIInbxDriver({ apiKey: "ai_test" }).sendEmail({
      from: { email: "agent@example.com" },
      to: { email: "buyer@example.net" },
      subject: "Re: Hello",
      html: "<p>Thanks</p>",
      reply: { threadId: THREAD_ID },
    });

    const { url, body } = sentRequest(fetchMock);
    expect(url).toBe(`${API}/threads/${THREAD_ID}/reply`);
    expect(body).toEqual({
      from: { address: "agent@example.com" },
      to: ["buyer@example.net"],
      subject: "Re: Hello",
      html: "<p>Thanks</p>",
    });
    expect(result).toMatchObject({
      messageId: "sent-1@example.com",
      providerId: emailId(1),
      threadId: THREAD_ID,
    });
  });

  it("rejects reply.isReply without a thread id", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      AIInbxDriver({ apiKey: "ai_test" }).sendEmail({
        from: { email: "agent@example.com" },
        to: { email: "buyer@example.net" },
        subject: "Re: Hello",
        text: "Thanks",
        reply: { isReply: true },
      }),
    ).rejects.toMatchObject({ code: "INVALID_REPLY_CONTEXT" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces problem+json failures as EmailKitError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        problemResponse(422, "invalid_request", "Request body is invalid", [
          { path: "to.0", message: "Invalid email address" },
        ]),
      ),
    );

    const error = await AIInbxDriver({ apiKey: "ai_test" })
      .sendEmail({
        from: { email: "agent@example.com" },
        to: { email: "nope" },
        subject: "Hello",
        text: "Plain",
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(EmailKitError);
    expect(error).toMatchObject({
      message: "Request body is invalid (to.0: Invalid email address)",
      provider: "aiinbx",
      code: "invalid_request",
      httpStatus: 422,
      raw: { request_id: "req_1" },
    });
  });
});

describe("AIInbxDriver webhooks", () => {
  const createClient = (
    hooks: Record<string, ReturnType<typeof vi.fn>>,
    config: Partial<Parameters<typeof AIInbxDriver>[0]> = {},
  ) =>
    EmailKit({
      emailDrivers: [
        AIInbxDriver({
          id: "support-aiinbx",
          apiKey: "ai_test",
          webhookSecret: WEBHOOK_SECRET,
          ...config,
        }),
      ],
      hooks: { email: hooks },
    });

  it("rejects unsigned, mis-signed, and stale webhooks", async () => {
    const onAll = vi.fn();
    const body = webhookEnvelope("email.opened", { email_id: emailId(1) });
    const handler = createClient({ onAll }).handler();

    const responses = await Promise.all([
      handler({ method: "POST", headers: {}, body, rawBody: "{}" }),
      handler(signedWebhookRequest(body, { secret: "wrong" })),
      handler(
        signedWebhookRequest(body, {
          timestamp: Math.floor(Date.now() / 1000) - 3600,
        }),
      ),
    ]);

    expect(responses.map((response) => response.status)).toEqual([
      401, 401, 401,
    ]);
    expect(onAll).not.toHaveBeenCalled();
  });

  it("rejects every webhook when no signing secret is configured", async () => {
    const driver = AIInbxDriver({ apiKey: "ai_test" });
    const body = webhookEnvelope("email.opened", { email_id: emailId(1) });

    expect(await driver.verifyWebhook!(signedWebhookRequest(body))).toBe(false);
  });

  it.each([[""], [["", WEBHOOK_SECRET]]])(
    "rejects signatures forged with an empty secret (%j)",
    async (webhookSecret) => {
      const driver = AIInbxDriver({ apiKey: "ai_test", webhookSecret });
      const body = webhookEnvelope("email.opened", { email_id: emailId(1) });

      expect(
        await driver.verifyWebhook!(signedWebhookRequest(body, { secret: "" })),
      ).toBe(false);
    },
  );

  it("verifies against every secret during a rotation grace period", async () => {
    const driver = AIInbxDriver({
      apiKey: "ai_test",
      webhookSecret: ["new-secret", WEBHOOK_SECRET],
    });
    const body = webhookEnvelope("email.opened", { email_id: emailId(1) });

    expect(await driver.verifyWebhook!(signedWebhookRequest(body))).toBe(true);
  });

  it("requires rawBody for signature verification", async () => {
    const driver = AIInbxDriver({
      apiKey: "ai_test",
      webhookSecret: WEBHOOK_SECRET,
    });
    const { rawBody: _rawBody, ...request } = signedWebhookRequest(
      webhookEnvelope("email.opened", { email_id: emailId(1) }),
    );

    await expect(driver.verifyWebhook!(request)).rejects.toMatchObject({
      code: "MISSING_RAW_BODY",
    });
  });

  it("loads the full email for email.received and exposes AIInbx extras", async () => {
    const downloadUrl = "https://signed.example.com/report.pdf?sig=abc";
    const fetchMock = vi.fn(async (input: string | URL) => {
      if (input.toString() === downloadUrl) return new Response("pdf-bytes");
      return jsonResponse(
        fullEmail(emailId(7), "2026-09-01T10:31:00Z", {
          cc: ["cc@example.net"],
          reply_to: ["replies@example.net"],
          in_reply_to: "<previous@example.com>",
          references: ["<first@example.com>", "<previous@example.com>"],
          category: "out_of_office",
          attachments: [
            {
              id: "att_1",
              filename: "report.pdf",
              content_type: "application/pdf",
              size: 9,
              cid: null,
              download_url: downloadUrl,
              preparation: {
                status: "ready",
                format: "markdown",
                pages: 2,
                warnings: [],
                content_url: "https://signed.example.com/report.md",
                text: "# Report",
              },
            },
          ],
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const onInbound = vi.fn();
    const client = createClient({ onInbound });
    const verdicts = { spam: "PASS", spf: "PASS", dkim: "PASS", dmarc: "FAIL" };
    const body = webhookEnvelope("email.received", {
      email_id: emailId(7),
      thread_id: THREAD_ID,
      domain_id: "dom_1",
      mailbox_id: null,
      verdicts,
    });

    const response = await client.handler()(signedWebhookRequest(body));

    expect(response.status).toBe(204);
    expect(fetchMock.mock.calls[0]![0].toString()).toBe(
      `${API}/emails/${emailId(7)}?include=attachment_content`,
    );

    const inbound = onInbound.mock.calls[0]![0];
    expect(inbound).toMatchObject({
      emailDriver: "support-aiinbx",
      eventId: body.id,
      messageId: `<${emailId(7)}@example.net>`,
      providerId: emailId(7),
      from: { email: "buyer@example.net", name: "Buyer" },
      to: [{ email: "agent@example.com" }],
      cc: [{ email: "cc@example.net" }],
      reply: {
        addresses: [{ email: "replies@example.net" }],
        messageId: "<previous@example.com>",
        references: ["<first@example.com>", "<previous@example.com>"],
        threadId: THREAD_ID,
        isReply: true,
      },
      strippedText: `Body ${emailId(7)}`,
      headers: { "X-Test": "1" },
      timestamp: new Date("2026-09-01T10:31:00Z"),
      raw: body,
    });
    expect(getAIInbxInbound(inbound)).toEqual({
      emailId: emailId(7),
      threadId: THREAD_ID,
      spaceId: null,
      domainId: "dom_1",
      mailboxId: null,
      category: "out_of_office",
      snippet: `Body ${emailId(7)}`,
      segments: [{ kind: "written", text: `Body ${emailId(7)}` }],
      verdicts,
    });

    const [attachment] = inbound.attachments;
    expect(attachment).toMatchObject({
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 9,
      isInline: false,
      url: `${API}/attachments/att_1`,
    });
    expect(new TextDecoder().decode(attachment.content)).toBe("pdf-bytes");
    expect(getAIInbxAttachment(attachment)).toEqual({
      attachmentId: "att_1",
      preparation: {
        status: "ready",
        format: "markdown",
        pages: 2,
        warnings: [],
        text: "# Report",
      },
    });

    // Signed storage URLs never see the API key.
    const download = fetchMock.mock.calls.find(
      ([input]) => input.toString() === downloadUrl,
    ) as unknown as [string, RequestInit];
    expect(new Headers(download[1].headers).get("authorization")).toBeNull();
  });

  it("serves lazy attachment content through the stable API URL", async () => {
    const fetchMock = vi.fn(async (input: string | URL) =>
      input.toString() === `${API}/attachments/att_1`
        ? new Response("via-api")
        : jsonResponse(
            fullEmail(emailId(7), "2026-09-01T10:31:00Z", {
              attachments: [
                {
                  id: "att_1",
                  filename: "image.png",
                  content_type: "image/png",
                  size: 7,
                  cid: "logo",
                  download_url: "https://signed.example.com/image.png",
                  preparation: null,
                },
              ],
            }),
          ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const onInbound = vi.fn();
    const client = createClient(
      { onInbound },
      { autoFetchInboundAttachments: false, inlineAttachmentText: false },
    );
    await client.handler()(
      signedWebhookRequest(
        webhookEnvelope("email.received", {
          email_id: emailId(7),
          thread_id: THREAD_ID,
        }),
      ),
    );

    expect(fetchMock.mock.calls[0]![0].toString()).toBe(
      `${API}/emails/${emailId(7)}`,
    );
    const [attachment] = onInbound.mock.calls[0]![0].attachments;
    expect(attachment).toMatchObject({ isInline: true, contentId: "logo" });
    expect(attachment.content).toBeUndefined();
    expect(getAIInbxAttachment(attachment)?.preparation).toBeNull();

    const content = await client.attachments.getContent(attachment);
    expect(new TextDecoder().decode(content as Uint8Array)).toBe("via-api");
    const [, init] = fetchMock.mock.calls[1] as unknown as [URL, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe(
      "Bearer ai_test",
    );
  });

  it("fans per-recipient delivery outcomes out into one event each", async () => {
    const onBounced = vi.fn();
    const body = webhookEnvelope(
      "email.bounced",
      {
        email_id: emailId(1),
        message_id: "sent-1@example.com",
        thread_id: THREAD_ID,
        domain_id: "dom_1",
        mailbox_id: null,
        suppression_key: "product-updates",
        recipients: ["a@example.net", "b@example.org"],
        permanent: true,
        reason: "550 no such user",
      },
      { space_id: "spc_1" },
    );

    await createClient({ onBounced }).handler()(signedWebhookRequest(body));

    expect(onBounced).toHaveBeenCalledTimes(2);
    expect(onBounced.mock.calls[1]![0]).toMatchObject({
      eventId: `${body.id}:b@example.org`,
      messageId: "sent-1@example.com",
      providerId: emailId(1),
      recipient: "b@example.org",
      recipientDomain: "example.org",
      status: "bounced",
      severity: "permanent",
      reason: "550 no such user",
      timestamp: new Date(body.created_at),
    });
    expect(getAIInbxOutbound(onBounced.mock.calls[1]![0])).toEqual({
      emailId: emailId(1),
      threadId: THREAD_ID,
      spaceId: "spc_1",
      domainId: "dom_1",
      mailboxId: null,
      suppressionKey: "product-updates",
    });
  });

  it("normalizes the remaining email events onto their hooks", async () => {
    const hooks = {
      onOutbound: vi.fn(),
      onDelivered: vi.fn(),
      onComplained: vi.fn(),
      onRejected: vi.fn(),
      onOpened: vi.fn(),
      onClicked: vi.fn(),
      onUnsubscribed: vi.fn(),
      onUnknown: vi.fn(),
    };
    const handler = createClient(hooks).handler();
    const base = {
      email_id: emailId(1),
      message_id: "sent-1@example.com",
      thread_id: THREAD_ID,
    };

    const events: Array<[string, Record<string, unknown>]> = [
      [
        "email.sent",
        {
          ...base,
          from: "agent@example.com",
          to: ["a@example.net", "b@example.net"],
          subject: "Hello",
        },
      ],
      ["email.delivered", { ...base, recipients: ["a@example.net"] }],
      [
        "email.complained",
        { ...base, recipients: ["a@example.net"], reason: "abuse" },
      ],
      ["email.failed", { ...base, reason: "virus" }],
      [
        "email.opened",
        {
          ...base,
          user_agent: "Mozilla/5.0",
          bot: true,
          bot_reason: "privacy_proxy",
        },
      ],
      [
        "email.clicked",
        {
          ...base,
          url: "https://example.com/i/42",
          user_agent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
          bot: true,
          bot_reason: "too_fast",
        },
      ],
      [
        "email.unsubscribed",
        {
          email_id: emailId(1),
          message_id: null,
          address: "a@example.net",
          key: "product-updates",
          scope: "optional",
          source: "one_click",
        },
      ],
      ["thread.created", { thread_id: THREAD_ID }],
    ];
    for (const [type, data] of events) {
      const response = await handler(
        signedWebhookRequest(webhookEnvelope(type, data)),
      );
      expect(response.status).toBe(204);
    }

    expect(hooks.onOutbound.mock.calls[0]![0]).toMatchObject({
      status: "sent",
      recipient: "a@example.net",
      from: { email: "agent@example.com" },
      to: [{ email: "a@example.net" }, { email: "b@example.net" }],
      subject: "Hello",
    });
    expect(hooks.onDelivered.mock.calls[0]![0]).toMatchObject({
      eventId: `evt_${"a".repeat(32)}`,
      messageId: "sent-1@example.com",
      providerId: emailId(1),
      recipient: "a@example.net",
    });
    expect(hooks.onComplained.mock.calls[0]![0]).toMatchObject({
      recipient: "a@example.net",
      feedback: "abuse",
    });
    expect(hooks.onRejected.mock.calls[0]![0]).toMatchObject({
      recipient: "",
      reason: "virus",
    });
    // AIInbx's verdict stands: it timed the click against the delivery, where
    // emailkit's own reading of that user-agent says a person.
    expect(hooks.onOpened.mock.calls[0]![0]).toMatchObject({
      userAgent: "Mozilla/5.0",
      botDetection: { isBot: true, reason: "privacy_proxy" },
    });
    expect(hooks.onClicked.mock.calls[0]![0]).toMatchObject({
      url: "https://example.com/i/42",
      botDetection: { isBot: true, reason: "too_fast" },
    });
    const unsubscribed = hooks.onUnsubscribed.mock.calls[0]![0];
    expect(unsubscribed).toMatchObject({
      status: "unsubscribed",
      recipient: "a@example.net",
      listId: "product-updates",
      source: "one_click",
    });
    expect(getAIInbxOutbound(unsubscribed)).toMatchObject({
      suppressionKey: "product-updates",
      unsubscribeScope: "optional",
    });
    expect(hooks.onUnknown.mock.calls[0]![0].data).toMatchObject({
      type: "thread.created",
    });
  });
});

describe("AIInbxDriver webhook management", () => {
  const endpoint = (overrides: Record<string, unknown> = {}) => ({
    id: "whk_1",
    url: "https://app.example.com/api/email/aiinbx",
    enabled: true,
    format: "v2",
    subscriptions: ["email.received", "email.bounced"],
    routing: [],
    max_concurrency: 16,
    previous_secret_expires_at: null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: "2026-09-01T10:00:00Z",
    ...overrides,
  });

  it("creates an endpoint and returns the one-time signing secret", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(endpoint({ secret: "whsec_1" }), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { webhook } = await AIInbxDriver({
      apiKey: "ai_test",
    }).webhooks!.account!.setup!({
      url: "https://app.example.com/api/email/aiinbx",
      events: ["inbound", "bounced"],
      inbound: { recipients: "support@example.com" },
    });

    expect(sentRequest(fetchMock)).toMatchObject({
      url: `${API}/webhook-endpoints`,
      body: {
        url: "https://app.example.com/api/email/aiinbx",
        subscriptions: ["email.received", "email.bounced"],
        routing: [
          { effect: "allow", field: "to", pattern: "support@example.com" },
        ],
      },
    });
    expect(webhook).toMatchObject({
      id: "whk_1",
      providerId: "whk_1",
      scope: "account",
      events: ["inbound", "bounced"],
      status: "active",
      provider: { signingSecret: "whsec_1" },
    });
  });

  it("subscribes to every email event by default", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(endpoint()));
    vi.stubGlobal("fetch", fetchMock);

    await AIInbxDriver({ apiKey: "ai_test" }).webhooks!.account!.setup!({
      url: "https://app.example.com/api/email/aiinbx",
    });

    const { body } = sentRequest(fetchMock);
    expect(body.subscriptions).toEqual([
      "email.received",
      "email.sent",
      "email.delivered",
      "email.opened",
      "email.clicked",
      "email.bounced",
      "email.complained",
      "email.failed",
      "email.unsubscribed",
      "mailbox.connected",
      "mailbox.needs_reauth",
      "mailbox.disconnected",
    ]);
    expect(body).not.toHaveProperty("routing");
  });

  it("refreshes and deletes by webhook id", async () => {
    const fetchMock = vi.fn(async (_input: string | URL, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Response(null, { status: 204 })
        : jsonResponse(endpoint({ enabled: false })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const account = AIInbxDriver({ apiKey: "ai_test" }).webhooks!.account!;

    const refreshed = await account.refresh!({
      webhookId: "whk_1",
      webhook: {
        id: "whk_1",
        scope: "account",
        url: "",
        status: "active",
        provider: { signingSecret: "whsec_1" },
      },
    });
    expect(refreshed.webhook).toMatchObject({
      status: "disabled",
      provider: { signingSecret: "whsec_1" },
    });

    const deleted = await account.delete!({ webhookId: "whk_1" });
    expect(deleted).toMatchObject({
      deleted: true,
      webhook: { id: "whk_1", status: "deleted" },
    });
    expect(fetchMock.mock.calls[1]![0].toString()).toBe(
      `${API}/webhook-endpoints/whk_1`,
    );
  });
});

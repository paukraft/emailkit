import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  EmailKit,
  EmailKitError,
  GMAIL_CAPABILITIES,
  GmailDriver,
  type ConnectMailboxInput,
  type GmailInboundDriverConfig,
  type GmailMailboxAuth,
  type GmailSendEmailResult,
  type SyncStream,
  type WebhookDriverEvent,
  type WebhookRequest,
} from "../src";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const CALLBACK_URL = "https://app.example.com/api/email/gmail";
const WEBHOOK_URL = "https://app.example.com/api/email/gmail";
const TOPIC = "projects/proj/topics/emailkit-gmail";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

const connectInput = (input: ConnectMailboxInput = {}) =>
  ({
    callbackUrl: CALLBACK_URL,
    ...input,
  }) as ConnectMailboxInput & { callbackUrl: string };

const createDriver = (
  overrides: Partial<GmailInboundDriverConfig<"gmail">> = {},
) =>
  GmailDriver({
    clientId: "client_123",
    clientSecret: "secret_123",
    pubsubTopic: TOPIC,
    verificationToken: "tok_123",
    ...overrides,
  });

const auth = (overrides: Partial<GmailMailboxAuth> = {}): GmailMailboxAuth => ({
  accessToken: "access_123",
  refreshToken: "refresh_123",
  expiresAt: Date.now() + 3600_000,
  tokenType: "Bearer",
  ...overrides,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const b64url = (value: string) =>
  Buffer.from(value, "utf8").toString("base64url");

const pubsubRequest = (
  notification: { emailAddress?: string; historyId?: number | string },
  extra: Partial<WebhookRequest> = {},
): WebhookRequest => ({
  method: "POST",
  headers: {},
  body: {
    message: {
      data: b64url(JSON.stringify(notification)),
      messageId: "pubsub-1",
      publishTime: "2026-07-01T10:00:00.000Z",
    },
    subscription: "projects/proj/subscriptions/emailkit-gmail-push",
  },
  ...extra,
});

const gmailMessage = (overrides: Record<string, unknown> = {}) => ({
  id: "msg_1",
  threadId: "thread_1",
  labelIds: ["INBOX", "UNREAD"],
  internalDate: "1751364000000",
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: "Ada Lovelace <ada@example.com>" },
      { name: "To", value: "Pau <pau@gmail.com>, second@example.com" },
      { name: "Cc", value: "cc@example.com" },
      { name: "Reply-To", value: "replies@example.com" },
      { name: "Subject", value: "Hello Gmail" },
      { name: "Message-ID", value: "<orig-1@example.com>" },
      { name: "In-Reply-To", value: "<parent-1@example.com>" },
      { name: "References", value: "<root-1@example.com> <parent-1@example.com>" },
    ],
    parts: [
      {
        mimeType: "multipart/alternative",
        parts: [
          {
            mimeType: "text/plain",
            body: { data: b64url("plain body") },
          },
          {
            mimeType: "text/html",
            body: { data: b64url("<p>html body</p>") },
          },
        ],
      },
      {
        partId: "2",
        mimeType: "application/pdf",
        filename: "invoice.pdf",
        headers: [
          { name: "Content-Disposition", value: 'attachment; filename="invoice.pdf"' },
        ],
        body: { attachmentId: "att_1", size: 1234 },
      },
    ],
  },
  ...overrides,
});

const fetchRouter = (
  routes: Array<
    [RegExp, (url: string, init?: RequestInit) => Response | Promise<Response>]
  >,
) => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, init });
    for (const [pattern, handler] of routes) {
      if (pattern.test(url)) return handler(url, init);
    }
    throw new Error(`Unmatched fetch: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return { mock, calls };
};

const drainSyncStream = async (
  stream: SyncStream,
): Promise<{ events: WebhookDriverEvent[]; result: { syncedFrom: Date } }> => {
  const events: WebhookDriverEvent[] = [];
  while (true) {
    const next = await stream.next();
    if (next.done) return { events, result: next.value };
    events.push(next.value);
  }
};

const decodeSentMime = (init: RequestInit | undefined): string => {
  const body = JSON.parse(String(init?.body)) as { raw: string };
  return Buffer.from(body.raw, "base64url").toString("utf8");
};

describe("GmailDriver", () => {
  it("defaults to the gmail literal id and preserves custom literal ids", () => {
    const defaultDriver = createDriver();
    const customDriver = GmailDriver({
      id: "tenant-gmail",
      clientId: "client_123",
      clientSecret: "secret_123",
    });

    expect(defaultDriver.id).toBe("gmail");
    expect(customDriver.id).toBe("tenant-gmail");
    expectTypeOf(defaultDriver.id).toEqualTypeOf<"gmail">();
    expectTypeOf(customDriver.id).toEqualTypeOf<"tenant-gmail">();
    expectTypeOf<GmailMailboxAuth>().toMatchTypeOf<{
      accessToken: string;
      historyId?: string;
    }>();
    expectTypeOf<GmailSendEmailResult>().toMatchTypeOf<{
      messageId: string;
      provider: string;
    }>();
  });

  it("declares only Gmail-supported EmailKit capabilities", () => {
    const driver = createDriver();

    expect(GMAIL_CAPABILITIES).toEqual({
      cc: true,
      bcc: true,
      replyTo: true,
      replyHeaders: true,
      replyThreadId: true,
      attachments: true,
      customHeaders: true,
      providerFetch: true,
      senderAuth: true,
      senderMailbox: true,
      requiresSecret: true,
      mailboxConnect: true,
      webhooks: {
        mailbox: true,
      },
      sync: {
        mailbox: true,
      },
      publicRoutes: {
        webhook: true,
        connectCallback: true,
        connectLanding: true,
      },
    });
    expect(driver.capabilities).toBe(GMAIL_CAPABILITIES);
    expect(driver.capabilities.nativeReplyThreading).toBeUndefined();
    expect(driver.capabilities.sendTracking).toBeUndefined();
    expect(driver.capabilities.tags).toBeUndefined();
    expect(driver.capabilities.templates).toBeUndefined();
    expect(driver.mailboxes?.connect).toBeTypeOf("function");
    expect(driver.webhooks?.mailbox?.setup).toBeTypeOf("function");
    expect(driver.webhooks?.mailbox?.refresh).toBeTypeOf("function");
    expect(driver.webhooks?.mailbox?.delete).toBeTypeOf("function");
    expect(driver.sync?.mailbox).toBeTypeOf("function");

    const emailkit = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
    });
    expect(emailkit.mailboxes.webhooks.setup).toBeTypeOf("function");
  });

  it("builds a Google OAuth authorization URL with PKCE, offline access, and encrypted state", async () => {
    const driver = createDriver();

    const result = await driver.mailboxes!.connect!(
      connectInput({
        email: "pau@gmail.com",
        context: { tenantId: "tenant_123" },
      }),
      { secret: "emailkit-secret" },
    );

    expect(result.context).toEqual({ tenantId: "tenant_123" });
    expect(result.state!.split(".")).toHaveLength(3);
    const readableStateParts = result
      .state!.split(".")
      .map((part) => Buffer.from(part, "base64url").toString("utf8"))
      .join("");
    expect(readableStateParts).not.toContain("codeVerifier");
    expect(readableStateParts).not.toContain("pau@gmail.com");

    const url = new URL(result.redirectUrl!);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe("client_123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("login_hint")).toBe("pau@gmail.com");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTypeOf("string");
    expect(url.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
    );
    expect(url.searchParams.get("state")).toBe(result.state);
  });

  it("requires the EmailKit secret for connect and callback", async () => {
    const driver = createDriver();

    await expect(
      driver.mailboxes!.connect!(connectInput(), {}),
    ).rejects.toMatchObject({ code: "MISSING_SECRET" });
    await expect(
      driver.handleCallback!(
        { method: "GET", headers: {}, body: null, query: { code: "x" } },
        {},
      ),
    ).rejects.toMatchObject({ code: "MISSING_SECRET" });
  });

  it("exchanges an OAuth callback code and seeds the history cursor from the profile", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
    const { calls } = fetchRouter([
      [
        /oauth2\.googleapis\.com\/token/,
        () =>
          json({
            access_token: "access_123",
            refresh_token: "refresh_123",
            expires_in: 3600,
            scope:
              "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send",
            token_type: "Bearer",
          }),
      ],
      [
        /\/users\/me\/profile/,
        () =>
          json({
            emailAddress: "pau@gmail.com",
            messagesTotal: 100,
            historyId: "5000",
          }),
      ],
    ]);

    const driver = createDriver();
    const connect = await driver.mailboxes!.connect!(
      connectInput({ context: { tenantId: "tenant_123" } }),
      { secret: "emailkit-secret" },
    );
    const callback = await driver.handleCallback!(
      {
        method: "GET",
        headers: {},
        query: { code: "code_123", state: connect.state! },
        body: null,
      },
      { secret: "emailkit-secret" },
    );

    const tokenCall = calls.find((call) => call.url.includes("/token"))!;
    const form = new URLSearchParams(String(tokenCall.init?.body));
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code_123");
    expect(form.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(form.get("code_verifier")).toBeTypeOf("string");

    expect(callback).toMatchObject({
      context: { tenantId: "tenant_123" },
      mailbox: {
        id: "pau@gmail.com",
        email: "pau@gmail.com",
        status: "connected",
      },
      auth: {
        accessToken: "access_123",
        refreshToken: "refresh_123",
        expiresAt: Date.parse("2026-07-01T11:00:00.000Z"),
        tokenType: "Bearer",
        historyId: "5000",
      },
    });
    const raw = callback.raw as { token?: Record<string, unknown> };
    expect(raw.token).not.toHaveProperty("access_token");
    expect(raw.token).not.toHaveProperty("refresh_token");
  });

  it("auto-subscribes inbound after callback: starts a watch and returns the normalized webhook", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
    const expiration = Date.parse("2026-07-08T10:00:00.000Z");
    const { calls } = fetchRouter([
      [
        /oauth2\.googleapis\.com\/token/,
        () =>
          json({
            access_token: "access_123",
            refresh_token: "refresh_123",
            expires_in: 3600,
            token_type: "Bearer",
          }),
      ],
      [
        /\/users\/me\/profile/,
        () => json({ emailAddress: "pau@gmail.com", historyId: "5000" }),
      ],
      [
        /\/users\/me\/watch/,
        () => json({ historyId: "5001", expiration: String(expiration) }),
      ],
    ]);

    const driver = createDriver({ autoSubscribeInbound: true });
    const connect = await driver.mailboxes!.connect!(connectInput(), {
      secret: "emailkit-secret",
      publicRoutes: { webhook: { url: WEBHOOK_URL } },
    });
    const callback = await driver.handleCallback!(
      {
        method: "GET",
        headers: {},
        query: { code: "code_123", state: connect.state! },
        body: null,
      },
      { secret: "emailkit-secret" },
    );

    const watchCall = calls.find((call) => call.url.includes("/watch"))!;
    expect(JSON.parse(String(watchCall.init?.body))).toEqual({
      topicName: TOPIC,
      labelIds: ["INBOX"],
      labelFilterBehavior: "INCLUDE",
    });

    expect(callback.auth).toMatchObject({
      historyId: "5001",
      watchExpiresAt: expiration,
    });
    expect(callback.webhooks).toHaveLength(1);
    const webhook = callback.webhooks![0]!;
    expect(webhook).toMatchObject({
      id: "watch:pau@gmail.com",
      scope: "mailbox",
      url: WEBHOOK_URL,
      status: "active",
      events: ["inbound"],
      provider: { topicName: TOPIC, labelIds: ["INBOX"] },
    });
    expect(webhook.expiresAt?.getTime()).toBe(expiration);
    expect(webhook.renewAfter!.getTime()).toBe(
      expiration - 24 * 60 * 60 * 1000,
    );
  });

  describe("sendEmail", () => {
    it("requires mailbox auth and body content", async () => {
      const driver = createDriver();
      await expect(
        driver.sendEmail({
          from: { email: "pau@gmail.com" },
          to: { email: "to@example.com" },
          subject: "Hi",
          text: "Hello",
        }),
      ).rejects.toMatchObject({ code: "MISSING_AUTH" });

      await expect(
        driver.sendEmail(
          {
            from: { email: "pau@gmail.com" },
            to: { email: "to@example.com" },
            subject: "Hi",
          },
          { auth: auth() },
        ),
      ).rejects.toMatchObject({ code: "MISSING_REQUIRED_FIELD" });
    });

    it("sends a raw MIME message and returns the stored Message-ID plus Gmail ids", async () => {
      const { calls } = fetchRouter([
        [
          /\/users\/me\/messages\/send/,
          () => json({ id: "gm_1", threadId: "gt_1", labelIds: ["SENT"] }),
        ],
        [
          // Consumer Gmail rewrites the Message-ID; the driver reads it back.
          /\/users\/me\/messages\/gm_1/,
          () =>
            json({
              id: "gm_1",
              payload: {
                headers: [
                  { name: "Message-ID", value: "<rewritten@mail.gmail.com>" },
                ],
              },
            }),
        ],
      ]);

      const driver = createDriver();
      const result = (await driver.sendEmail(
        {
          from: { email: "pau@gmail.com", name: "Pau" },
          to: [{ email: "to@example.com", name: "Recipient" }],
          cc: { email: "cc@example.com" },
          subject: "Hello ✓ world",
          text: "plain content",
          html: "<p>html content</p>",
          headers: { "X-Campaign": "launch" },
        },
        { auth: auth() },
      )) as GmailSendEmailResult;

      expect(calls[0]!.url).toBe(`${GMAIL_BASE}/users/me/messages/send`);
      const readback = new URL(calls[1]!.url);
      expect(readback.pathname).toContain("/users/me/messages/gm_1");
      expect(readback.searchParams.get("format")).toBe("metadata");
      expect(
        new Headers(calls[0]!.init?.headers).get("authorization"),
      ).toBe("Bearer access_123");

      const mime = decodeSentMime(calls[0]!.init);
      expect(mime).toContain("From: Pau <pau@gmail.com>");
      expect(mime).toContain("To: Recipient <to@example.com>");
      expect(mime).toContain("Cc: cc@example.com");
      expect(mime).toContain("Subject: =?UTF-8?B?");
      expect(mime).toContain("X-Campaign: launch");
      expect(mime).toContain("multipart/alternative");
      expect(mime).toContain("Content-Type: text/plain; charset=UTF-8");
      expect(mime).toContain("Content-Type: text/html; charset=UTF-8");
      expect(mime).toContain(
        Buffer.from("plain content", "utf8").toString("base64"),
      );

      expect(result.provider).toBe("gmail");
      expect(result.providerId).toBe("gm_1");
      expect(result.threadId).toBe("gt_1");
      // The MIME carries a generated Message-ID, but the result reports the
      // one Gmail actually stored (consumer accounts rewrite it).
      expect(mime).toMatch(/Message-ID: <[0-9a-f-]+@gmail\.com>/);
      expect(result.messageId).toBe("<rewritten@mail.gmail.com>");
      expect(result.replyThreading).toBeUndefined();
    });

    it("threads replies natively: reply headers in the MIME plus a threadId lookup", async () => {
      const { calls } = fetchRouter([
        [
          /\/users\/me\/messages\?/,
          () => json({ messages: [{ id: "gm_0", threadId: "gt_0" }] }),
        ],
        [
          /\/users\/me\/messages\/send/,
          () => json({ id: "gm_2", threadId: "gt_0" }),
        ],
      ]);

      const driver = createDriver();
      const result = await driver.sendEmail(
        {
          from: { email: "pau@gmail.com" },
          to: { email: "to@example.com" },
          subject: "Re: Hello",
          text: "reply content",
          reply: {
            messageId: "<orig-1@example.com>",
            references: ["<root-1@example.com>", "<orig-1@example.com>"],
          },
        },
        { auth: auth() },
      );

      const lookup = calls.find((call) => call.url.includes("/messages?"))!;
      const lookupUrl = new URL(lookup.url);
      expect(lookupUrl.searchParams.get("q")).toBe(
        "rfc822msgid:orig-1@example.com",
      );

      const send = calls.find((call) => call.url.includes("/send"))!;
      expect(JSON.parse(String(send.init?.body)).threadId).toBe("gt_0");
      const mime = decodeSentMime(send.init);
      expect(mime).toContain("In-Reply-To: <orig-1@example.com>");
      expect(mime).toContain(
        "References: <root-1@example.com> <orig-1@example.com>",
      );
      expect(result.threadId).toBe("gt_0");
    });

    it("uses reply.threadId directly without a lookup and survives failed lookups", async () => {
      const direct = fetchRouter([
        [/\/users\/me\/messages\/send/, () => json({ id: "gm_3" })],
      ]);
      const driver = createDriver();
      await driver.sendEmail(
        {
          from: { email: "pau@gmail.com" },
          to: { email: "to@example.com" },
          subject: "Re: Hello",
          text: "reply",
          reply: { threadId: "gt_9", messageId: "<orig-1@example.com>" },
        },
        { auth: auth() },
      );
      expect(
        direct.calls.filter((call) => call.url.includes("/messages?")),
      ).toHaveLength(0);
      expect(
        JSON.parse(String(direct.calls[0]!.init?.body)).threadId,
      ).toBe("gt_9");

      vi.unstubAllGlobals();
      const failing = fetchRouter([
        [/\/users\/me\/messages\?/, () => json({ error: { message: "boom" } }, 500)],
        [/\/users\/me\/messages\/send/, () => json({ id: "gm_4" })],
      ]);
      const result = (await driver.sendEmail(
        {
          from: { email: "pau@gmail.com" },
          to: { email: "to@example.com" },
          subject: "Re: Hello",
          text: "reply",
          reply: { messageId: "<orig-1@example.com>" },
        },
        { auth: auth() },
      )) as GmailSendEmailResult;
      const send = failing.calls.find((call) => call.url.includes("/send"))!;
      expect(JSON.parse(String(send.init?.body)).threadId).toBeUndefined();
      const mime = decodeSentMime(send.init);
      expect(mime).toContain("In-Reply-To: <orig-1@example.com>");
      expect(result.raw?.threadLookup).toMatchObject({ error: "boom" });
    });

    it("rejects unsupported EmailKit send fields, reserved headers, and foreign senders", async () => {
      const driver = createDriver();

      await expect(
        driver.sendEmail(
          {
            from: { email: "pau@gmail.com" },
            to: { email: "to@example.com" },
            subject: "Hi",
            text: "x",
            ...({ tags: ["nope"], sendAt: new Date() } as object),
          },
          { auth: auth() },
        ),
      ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });

      await expect(
        driver.sendEmail(
          {
            from: { email: "pau@gmail.com" },
            to: { email: "to@example.com" },
            subject: "Hi",
            text: "x",
            headers: { Subject: "override" },
          },
          { auth: auth() },
        ),
      ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });

      await expect(
        driver.sendEmail(
          {
            from: { email: "other@gmail.com" },
            to: { email: "to@example.com" },
            subject: "Hi",
            text: "x",
          },
          {
            auth: auth(),
            mailbox: { id: "pau@gmail.com", email: "pau@gmail.com" },
          },
        ),
      ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    });

    it("builds multipart/mixed for attachments and rejects URL-only attachments", async () => {
      const { calls } = fetchRouter([
        [/\/users\/me\/messages\/send/, () => json({ id: "gm_5" })],
      ]);
      const driver = createDriver();

      await driver.sendEmail(
        {
          from: { email: "pau@gmail.com" },
          to: { email: "to@example.com" },
          subject: "Files",
          text: "see attached",
          attachments: [
            {
              filename: "hello.txt",
              content: "hello file",
              contentType: "text/plain",
            },
            {
              filename: "logo.png",
              content: new Uint8Array([1, 2, 3]),
              contentType: "image/png",
              isInline: true,
              contentId: "logo-cid",
            },
          ],
        },
        { auth: auth() },
      );

      const mime = decodeSentMime(calls[0]!.init);
      expect(mime).toContain("multipart/mixed");
      expect(mime).toContain("multipart/related");
      expect(mime).toContain('Content-Disposition: attachment; filename="hello.txt"');
      expect(mime).toContain('Content-Disposition: inline; filename="logo.png"');
      expect(mime).toContain("Content-ID: <logo-cid>");
      expect(mime).toContain(
        Buffer.from("hello file", "utf8").toString("base64"),
      );

      await expect(
        driver.sendEmail(
          {
            from: { email: "pau@gmail.com" },
            to: { email: "to@example.com" },
            subject: "Files",
            text: "see attached",
            attachments: [
              { filename: "remote.pdf", url: "https://files.example.com/x" },
            ],
          },
          { auth: auth() },
        ),
      ).rejects.toMatchObject({ code: "INVALID_ATTACHMENT" });
    });

    it("rejects invalid custom header names with an EmailKitError", async () => {
      const driver = createDriver();
      await expect(
        driver.sendEmail(
          {
            from: { email: "pau@gmail.com" },
            to: { email: "to@example.com" },
            subject: "Hi",
            text: "x",
            headers: { "X-My Header": "v" },
          },
          { auth: auth() },
        ),
      ).rejects.toMatchObject({ code: "INVALID_HEADER", provider: "gmail" });
    });

    it("refreshes expired auth before sending and reports it through onAuthUpdated", async () => {
      const { calls } = fetchRouter([
        [
          /oauth2\.googleapis\.com\/token/,
          () =>
            json({
              access_token: "access_fresh",
              expires_in: 3600,
              token_type: "Bearer",
            }),
        ],
        [/\/users\/me\/messages\/send/, () => json({ id: "gm_6" })],
      ]);

      const onAuthUpdated = vi.fn();
      const driver = createDriver();
      await driver.sendEmail(
        {
          from: { email: "pau@gmail.com" },
          to: { email: "to@example.com" },
          subject: "Hi",
          text: "x",
        },
        {
          auth: auth({
            expiresAt: Date.now() - 1000,
            historyId: "4000",
            watchExpiresAt: 1234,
          }),
          mailbox: { id: "pau@gmail.com", email: "pau@gmail.com" },
          onAuthUpdated,
        },
      );

      const tokenCall = calls.find((call) => call.url.includes("/token"))!;
      const form = new URLSearchParams(String(tokenCall.init?.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("refresh_123");

      expect(onAuthUpdated).toHaveBeenCalledOnce();
      const update = onAuthUpdated.mock.calls[0]![0];
      // Refresh must preserve the refresh token and Gmail cursor fields.
      expect(update.auth).toMatchObject({
        accessToken: "access_fresh",
        refreshToken: "refresh_123",
        historyId: "4000",
        watchExpiresAt: 1234,
      });

      const send = calls.find((call) => call.url.includes("/send"))!;
      expect(new Headers(send.init?.headers).get("authorization")).toBe(
        "Bearer access_fresh",
      );
    });
  });

  describe("handleWebhook", () => {
    it("returns unknown for non-Pub/Sub payloads", async () => {
      const driver = createDriver();
      const result = await driver.handleWebhook({
        method: "POST",
        headers: {},
        body: { hello: "world" },
      });
      expect(result).toEqual({ type: "unknown", data: { hello: "world" } });
    });

    it("enforces the verification token via verifyWebhook", async () => {
      const driver = createDriver({ verificationToken: "tok_123" });

      await expect(
        driver.verifyWebhook!(
          pubsubRequest({ emailAddress: "pau@gmail.com", historyId: 2000 }),
        ),
      ).resolves.toBe(false);
      await expect(
        driver.verifyWebhook!(
          pubsubRequest(
            { emailAddress: "pau@gmail.com", historyId: 2000 },
            { query: { token: "wrong" } },
          ),
        ),
      ).resolves.toBe(false);
      await expect(
        driver.verifyWebhook!(
          pubsubRequest(
            { emailAddress: "pau@gmail.com", historyId: 2000 },
            { query: { token: "tok_123" } },
          ),
        ),
      ).resolves.toBe(true);
      // OAuth callback GETs validate through encrypted state, not the token.
      await expect(
        driver.verifyWebhook!({ method: "GET", headers: {}, body: null }),
      ).resolves.toBe(true);
    });

    it("rejects inbound configuration without a verificationToken at construction", () => {
      expect(() =>
        GmailDriver({
          clientId: "client_123",
          clientSecret: "secret_123",
          pubsubTopic: TOPIC,
          // @ts-expect-error inbound config requires verificationToken
          verificationToken: undefined,
        }),
      ).toThrowError(
        expect.objectContaining({ code: "MISSING_VERIFICATION_TOKEN" }),
      );
      expect(() =>
        GmailDriver({
          clientId: "client_123",
          clientSecret: "secret_123",
          webhookAuth: auth(),
          verificationToken: [],
        }),
      ).toThrowError(
        expect.objectContaining({ code: "MISSING_VERIFICATION_TOKEN" }),
      );
    });

    it("rejects webhook POSTs on drivers without inbound configuration", async () => {
      const onInbound = vi.fn();
      const sendOnly = GmailDriver({
        clientId: "client_123",
        clientSecret: "secret_123",
      });

      await expect(
        sendOnly.verifyWebhook!(
          pubsubRequest({ emailAddress: "pau@gmail.com", historyId: 2000 }),
        ),
      ).resolves.toBe(false);
      // OAuth callback GETs validate through encrypted state, not the token.
      await expect(
        sendOnly.verifyWebhook!({ method: "GET", headers: {}, body: null }),
      ).resolves.toBe(true);

      const client = EmailKit({
        emailDrivers: [sendOnly],
        secret: "emailkit-secret",
        hooks: { email: { onInbound } },
      });
      const response = await client.handler()(
        pubsubRequest({ emailAddress: "pau@gmail.com", historyId: 2000 }),
      );

      expect(response.status).toBe(401);
      expect(onInbound).not.toHaveBeenCalled();
    });

    it("hydrates history into inbound events and advances the cursor through onAuthUpdated", async () => {
      const onAuthUpdated = vi.fn();
      const { calls } = fetchRouter([
        [
          /\/users\/me\/history/,
          () =>
            json({
              historyId: "2100",
              history: [
                {
                  id: "2050",
                  messagesAdded: [
                    {
                      message: {
                        id: "msg_1",
                        threadId: "thread_1",
                        labelIds: ["INBOX"],
                      },
                    },
                    {
                      message: {
                        id: "msg_1",
                        threadId: "thread_1",
                        labelIds: ["INBOX"],
                      },
                    },
                  ],
                },
              ],
            }),
        ],
        [/\/users\/me\/messages\/msg_1/, () => json(gmailMessage())],
      ]);

      const driver = createDriver({
        verificationToken: "tok_123",
        webhookAuthResolver: async ({ mailboxEmail }) =>
          mailboxEmail === "pau@gmail.com"
            ? auth({ historyId: "1000", watchExpiresAt: Date.now() + 6 * 24 * 60 * 60 * 1000 })
            : undefined,
        onAuthUpdated,
      });

      const result = await driver.handleWebhook(
        pubsubRequest(
          { emailAddress: "pau@gmail.com", historyId: 2000 },
          { query: { token: "tok_123" } },
        ),
      );

      const historyCall = calls.find((call) => call.url.includes("/history"))!;
      const historyUrl = new URL(historyCall.url);
      expect(historyUrl.searchParams.get("startHistoryId")).toBe("1000");
      expect(historyUrl.searchParams.get("historyTypes")).toBe("messageAdded");
      expect(historyUrl.searchParams.get("labelId")).toBe("INBOX");

      // Duplicate messagesAdded entries collapse into a single event.
      expect(Array.isArray(result)).toBe(false);
      const event = result as WebhookDriverEvent;
      expect(event.type).toBe("inbound");
      if (event.type !== "inbound") throw new Error("expected inbound");
      expect(event.data).toMatchObject({
        eventId: "pau@gmail.com:msg_1:added",
        messageId: "<orig-1@example.com>",
        providerId: "msg_1",
        from: { email: "ada@example.com", name: "Ada Lovelace" },
        to: [
          { email: "pau@gmail.com", name: "Pau" },
          { email: "second@example.com" },
        ],
        cc: [{ email: "cc@example.com" }],
        subject: "Hello Gmail",
        text: "plain body",
        html: "<p>html body</p>",
      });
      expect(event.data.reply).toMatchObject({
        addresses: [{ email: "replies@example.com" }],
        messageId: "<parent-1@example.com>",
        references: ["<root-1@example.com>", "<parent-1@example.com>"],
        threadId: "thread_1",
        isReply: true,
      });
      expect(event.data.timestamp.getTime()).toBe(1751364000000);
      expect(event.data.attachments).toHaveLength(1);
      expect(event.data.attachments![0]).toMatchObject({
        filename: "invoice.pdf",
        contentType: "application/pdf",
        size: 1234,
        url: `${GMAIL_BASE}/users/me/messages/msg_1/attachments/att_1`,
        provider: {
          gmail: {
            mailboxEmail: "pau@gmail.com",
            messageId: "msg_1",
            attachmentId: "att_1",
          },
        },
      });

      expect(onAuthUpdated).toHaveBeenCalledOnce();
      expect(onAuthUpdated.mock.calls[0]![0]).toMatchObject({
        auth: { historyId: "2100" },
        previousAuth: { historyId: "1000" },
        mailbox: { email: "pau@gmail.com" },
      });
    });

    it("hydrates multiple history messages concurrently without reordering events", async () => {
      let activeMessageFetches = 0;
      let maxActiveMessageFetches = 0;
      const delayedMessage = async (id: string) => {
        activeMessageFetches += 1;
        maxActiveMessageFetches = Math.max(
          maxActiveMessageFetches,
          activeMessageFetches,
        );
        await Promise.resolve();
        activeMessageFetches -= 1;
        return json(gmailMessage({ id }));
      };

      fetchRouter([
        [
          /\/users\/me\/history/,
          () =>
            json({
              historyId: "2100",
              history: [
                {
                  id: "2050",
                  messagesAdded: [
                    { message: { id: "msg_1", labelIds: ["INBOX"] } },
                    { message: { id: "msg_2", labelIds: ["INBOX"] } },
                    { message: { id: "msg_3", labelIds: ["INBOX"] } },
                  ],
                },
              ],
            }),
        ],
        [/\/users\/me\/messages\/msg_1/, () => delayedMessage("msg_1")],
        [/\/users\/me\/messages\/msg_2/, () => delayedMessage("msg_2")],
        [/\/users\/me\/messages\/msg_3/, () => delayedMessage("msg_3")],
      ]);

      const driver = createDriver({
        webhookAuth: auth({
          historyId: "1000",
          watchExpiresAt: Date.now() + 6 * 24 * 60 * 60 * 1000,
        }),
      });

      const result = await driver.handleWebhook(
        pubsubRequest({ emailAddress: "pau@gmail.com", historyId: 2000 }),
      );

      expect(Array.isArray(result)).toBe(true);
      const events = result as WebhookDriverEvent[];
      expect(events.map((event) => event.data.providerId)).toEqual([
        "msg_1",
        "msg_2",
        "msg_3",
      ]);
      expect(maxActiveMessageFetches).toBeGreaterThan(1);
    });

    it("degrades to sync_required when the cursor is missing and seeds it from the notification", async () => {
      const onAuthUpdated = vi.fn();
      const driver = createDriver({
        webhookAuth: auth(),
        onAuthUpdated,
      });

      const result = await driver.handleWebhook(
        pubsubRequest({ emailAddress: "pau@gmail.com", historyId: 2000 }),
      );

      expect(result).toMatchObject({
        type: "webhook.lifecycle",
        data: {
          action: "sync_required",
          reason: "notifications_missed",
          recommendedActions: ["sync"],
          scope: "mailbox",
          target: { mailboxEmail: "pau@gmail.com" },
        },
      });
      expect(onAuthUpdated).toHaveBeenCalledOnce();
      expect(onAuthUpdated.mock.calls[0]![0].auth.historyId).toBe("2000");
    });

    it("degrades to sync_required on an expired cursor (history 404) and resets it", async () => {
      const onAuthUpdated = vi.fn();
      fetchRouter([
        [
          /\/users\/me\/history/,
          () => json({ error: { code: 404, message: "Start history ID is too old" } }, 404),
        ],
      ]);
      const driver = createDriver({
        webhookAuth: auth({ historyId: "1" }),
        onAuthUpdated,
      });

      const result = await driver.handleWebhook(
        pubsubRequest({ emailAddress: "pau@gmail.com", historyId: 2000 }),
      );

      expect(result).toMatchObject({
        type: "webhook.lifecycle",
        data: { action: "sync_required", reason: "history_gap" },
      });
      expect(onAuthUpdated.mock.calls[0]![0].auth.historyId).toBe("2000");
    });

    it("renews the watch opportunistically when it is close to expiring", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
      const oldExpiry = Date.now() + 60 * 60 * 1000;
      const newExpiry = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const onAuthUpdated = vi.fn();
      fetchRouter([
        [/\/users\/me\/history/, () => json({ historyId: "2100", history: [] })],
        [
          /\/users\/me\/watch/,
          () => json({ historyId: "2100", expiration: String(newExpiry) }),
        ],
      ]);

      const driver = createDriver({
        webhookAuth: auth({ historyId: "1000", watchExpiresAt: oldExpiry }),
        onAuthUpdated,
      });

      const result = await driver.handleWebhook(
        pubsubRequest({ emailAddress: "pau@gmail.com", historyId: 2000 }),
      );

      expect(result).toMatchObject({
        type: "webhook.lifecycle",
        data: {
          action: "updated",
          reason: "renewed",
          recommendedActions: ["persist"],
          webhook: { id: "watch:pau@gmail.com", status: "active" },
        },
      });
      expect(onAuthUpdated).toHaveBeenCalledOnce();
      expect(onAuthUpdated.mock.calls[0]![0].auth).toMatchObject({
        historyId: "2100",
        watchExpiresAt: newExpiry,
      });
    });

    it("returns unknown when no auth can be resolved", async () => {
      const driver = createDriver();
      const result = await driver.handleWebhook(
        pubsubRequest({ emailAddress: "pau@gmail.com", historyId: 2000 }),
      );
      expect(result).toMatchObject({ type: "unknown" });
    });

    it("acknowledges Pub/Sub pushes with a 200 webhook response", async () => {
      const driver = createDriver();
      await expect(
        driver.webhookResponse!(
          { method: "POST", headers: {}, body: null },
          true,
        ),
      ).resolves.toEqual({ status: 200, body: { success: true } });
    });
  });

  describe("webhooks.mailbox", () => {
    it("setup starts a watch, seeds the cursor, and returns a normalized webhook", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-07-01T10:00:00.000Z"));
      const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const onAuthUpdated = vi.fn();
      fetchRouter([
        [
          /\/users\/me\/watch/,
          () => json({ historyId: "3000", expiration: String(expiration) }),
        ],
      ]);

      const driver = createDriver();
      const result = await driver.webhooks!.mailbox!.setup!(
        {
          mailbox: { id: "pau@gmail.com", email: "pau@gmail.com" },
          auth: auth(),
          url: WEBHOOK_URL,
          events: ["inbound"],
        },
        { onAuthUpdated },
      );

      expect(result.webhook).toMatchObject({
        id: "watch:pau@gmail.com",
        scope: "mailbox",
        url: WEBHOOK_URL,
        status: "active",
        provider: { topicName: TOPIC, labelIds: ["INBOX"] },
      });
      expect(result.webhook.expiresAt?.getTime()).toBe(expiration);
      expect(onAuthUpdated).toHaveBeenCalledOnce();
      expect(onAuthUpdated.mock.calls[0]![0].auth).toMatchObject({
        historyId: "3000",
        watchExpiresAt: expiration,
      });
    });

    it("setup fails without a Pub/Sub topic", async () => {
      const driver = createDriver({ pubsubTopic: undefined });
      await expect(
        driver.webhooks!.mailbox!.setup!({
          email: "pau@gmail.com",
          auth: auth(),
          url: WEBHOOK_URL,
        }),
      ).rejects.toMatchObject({ code: "MISSING_PUBSUB_TOPIC" });
    });

    it("refresh re-watches and delete stops the watch", async () => {
      const expiration = Date.now() + 7 * 24 * 60 * 60 * 1000;
      const { calls } = fetchRouter([
        [
          /\/users\/me\/watch/,
          () => json({ historyId: "3000", expiration: String(expiration) }),
        ],
        [/\/users\/me\/stop/, () => new Response(null, { status: 204 })],
      ]);

      const driver = createDriver();
      const refreshed = await driver.webhooks!.mailbox!.refresh!({
        email: "pau@gmail.com",
        auth: auth({ historyId: "2000" }),
        webhookId: "watch:pau@gmail.com",
      });
      expect(refreshed.webhook.status).toBe("active");
      expect(calls.some((call) => call.url.includes("/watch"))).toBe(true);

      const deleted = await driver.webhooks!.mailbox!.delete!({
        email: "pau@gmail.com",
        auth: auth(),
        webhookId: "watch:pau@gmail.com",
      });
      expect(deleted.deleted).toBe(true);
      expect(deleted.webhook?.status).toBe("deleted");
      expect(calls.some((call) => call.url.includes("/stop"))).toBe(true);
    });
  });

  describe("sync.mailbox", () => {
    it("replays a time window oldest-first, filtering self-sent mail", async () => {
      const since = new Date("2026-06-30T00:00:00.000Z");
      const until = new Date("2026-07-01T00:00:00.000Z");
      let activeMessageFetches = 0;
      let maxActiveMessageFetches = 0;
      const delayedMessage = async (overrides: Record<string, unknown>) => {
        activeMessageFetches += 1;
        maxActiveMessageFetches = Math.max(
          maxActiveMessageFetches,
          activeMessageFetches,
        );
        await Promise.resolve();
        activeMessageFetches -= 1;
        return json(gmailMessage(overrides));
      };
      const { calls } = fetchRouter([
        [
          /\/users\/me\/messages\?/,
          () =>
            json({
              messages: [{ id: "msg_new" }, { id: "msg_self" }, { id: "msg_old" }],
            }),
        ],
        [
          /\/users\/me\/messages\/msg_new/,
          () =>
            delayedMessage({
              id: "msg_new",
              internalDate: String(Date.parse("2026-06-30T20:00:00.000Z")),
            }),
        ],
        [
          /\/users\/me\/messages\/msg_self/,
          () =>
            delayedMessage({
              id: "msg_self",
              internalDate: String(Date.parse("2026-06-30T12:00:00.000Z")),
              payload: {
                mimeType: "text/plain",
                headers: [
                  { name: "From", value: "pau@gmail.com" },
                  { name: "To", value: "someone@example.com" },
                  { name: "Subject", value: "self" },
                ],
                body: { data: b64url("self body") },
              },
            }),
        ],
        [
          /\/users\/me\/messages\/msg_old/,
          () =>
            delayedMessage({
              id: "msg_old",
              internalDate: String(Date.parse("2026-06-30T08:00:00.000Z")),
            }),
        ],
      ]);

      const driver = createDriver();
      const { events, result } = await drainSyncStream(
        driver.sync!.mailbox!({
          since,
          until,
          email: "pau@gmail.com",
          auth: auth(),
        }),
      );

      const listCall = calls.find((call) => call.url.includes("/messages?"))!;
      const listUrl = new URL(listCall.url);
      expect(listUrl.searchParams.get("q")).toBe(
        `after:${Math.floor(since.getTime() / 1000)} before:${
          Math.ceil(until.getTime() / 1000) + 1
        }`,
      );
      expect(listUrl.searchParams.get("labelIds")).toBe("INBOX");

      // Oldest first, self-sent filtered out.
      expect(events).toHaveLength(2);
      expect(events.map((event) => (event as { data: { providerId?: string } }).data.providerId)).toEqual([
        "msg_old",
        "msg_new",
      ]);
      expect(maxActiveMessageFetches).toBeGreaterThan(1);
      expect(
        (events[0] as { data: { eventId?: string } }).data.eventId,
      ).toBe("sync:msg_old");
      expect(result.syncedFrom).toEqual(since);
    });

    it("skips messages outside the precise time window", async () => {
      const since = new Date("2026-06-30T00:00:00.000Z");
      const until = new Date("2026-07-01T00:00:00.000Z");
      fetchRouter([
        [/\/users\/me\/messages\?/, () => json({ messages: [{ id: "msg_late" }] })],
        [
          /\/users\/me\/messages\/msg_late/,
          () =>
            json(
              gmailMessage({
                id: "msg_late",
                internalDate: String(Date.parse("2026-07-01T00:00:00.500Z")),
              }),
            ),
        ],
      ]);

      const driver = createDriver();
      const { events } = await drainSyncStream(
        driver.sync!.mailbox!({
          since,
          until,
          email: "pau@gmail.com",
          auth: auth(),
        }),
      );
      expect(events).toHaveLength(0);
    });
  });

  describe("providerFetch", () => {
    it("normalizes Gmail attachment JSON into raw bytes", async () => {
      const bytes = Uint8Array.from([1, 2, 3, 4, 5]);
      fetchRouter([
        [
          /\/attachments\/att_1/,
          () =>
            json({
              size: bytes.length,
              data: Buffer.from(bytes).toString("base64url"),
            }),
        ],
      ]);

      const driver = createDriver({ webhookAuth: auth() });
      const response = await driver.providerFetch!(
        `${GMAIL_BASE}/users/me/messages/msg_1/attachments/att_1`,
        { provider: { gmail: { mailboxEmail: "pau@gmail.com" } } },
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/octet-stream",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    });

    it("passes through non-attachment endpoints and validates the origin", async () => {
      fetchRouter([
        [/\/users\/me\/profile/, () => json({ emailAddress: "pau@gmail.com" })],
      ]);
      const driver = createDriver({ webhookAuth: auth() });

      const response = await driver.providerFetch!("users/me/profile");
      expect(await response.json()).toEqual({ emailAddress: "pau@gmail.com" });

      await expect(
        driver.providerFetch!("https://evil.example.com/users/me/profile"),
      ).rejects.toMatchObject({ code: "INVALID_PROVIDER_FETCH_URL" });

      const noAuthDriver = createDriver();
      await expect(
        noAuthDriver.providerFetch!("users/me/profile"),
      ).rejects.toMatchObject({ code: "MISSING_AUTH" });
    });

    it("resolves attachment auth through the webhookAuthResolver metadata", async () => {
      const bytes = Uint8Array.from([9, 9, 9]);
      const { calls } = fetchRouter([
        [
          /\/attachments\/att_2/,
          () =>
            json({
              size: bytes.length,
              data: Buffer.from(bytes).toString("base64url"),
            }),
        ],
      ]);
      const resolver = vi.fn(async ({ mailboxEmail }: { mailboxEmail?: string }) =>
        mailboxEmail === "pau@gmail.com" ? auth({ accessToken: "resolved_token" }) : undefined,
      );
      const driver = createDriver({ webhookAuthResolver: resolver });

      const response = await driver.providerFetch!(
        `${GMAIL_BASE}/users/me/messages/msg_1/attachments/att_2`,
        {
          provider: {
            gmail: { mailboxEmail: "pau@gmail.com", messageId: "msg_1" },
          },
        },
      );

      expect(resolver).toHaveBeenCalled();
      expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBe(
        "Bearer resolved_token",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    });
  });

  it("EmailKitError from Gmail API failures carries status and body", async () => {
    fetchRouter([
      [
        /\/users\/me\/messages\/send/,
        () =>
          json(
            { error: { code: 403, message: "Insufficient Permission" } },
            403,
          ),
      ],
    ]);
    const driver = createDriver();

    await expect(
      driver.sendEmail(
        {
          from: { email: "pau@gmail.com" },
          to: { email: "to@example.com" },
          subject: "Hi",
          text: "x",
        },
        { auth: auth() },
      ),
    ).rejects.toMatchObject({
      message: "Insufficient Permission",
      provider: "gmail",
      httpStatus: 403,
    });

    await expect(
      driver.sendEmail(
        {
          from: { email: "pau@gmail.com" },
          to: { email: "to@example.com" },
          subject: "Hi",
          text: "x",
        },
        { auth: auth() },
      ),
    ).rejects.toBeInstanceOf(EmailKitError);
  });
});

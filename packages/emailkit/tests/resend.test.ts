import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { EmailKit, EmailKitError, ResendDriver } from "../src";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ResendDriver", () => {
  it("defaults to the resend literal id and preserves custom literal ids", () => {
    const defaultDriver = ResendDriver({ apiKey: "re_test" });
    const customDriver = ResendDriver({
      id: "transactional-resend",
      apiKey: "re_test",
    });

    expect(defaultDriver.id).toBe("resend");
    expect(customDriver.id).toBe("transactional-resend");
    expectTypeOf(defaultDriver.id).toEqualTypeOf<"resend">();
    expectTypeOf(customDriver.id).toEqualTypeOf<"transactional-resend">();
  });

  it("declares only Resend-supported EmailKit capabilities", () => {
    const driver = ResendDriver({ apiKey: "re_test" });

    expect(driver.capabilities.domains).toMatchObject({
      list: true,
      create: true,
      get: true,
      update: true,
      verify: true,
      delete: true,
      identifier: "domainId",
    });
    expect(driver.capabilities.webhooks?.account).toBe(true);
    expect(driver.capabilities.publicRoutes).toEqual({ webhook: true });
    expect(driver.capabilities.requiresSecret).toBe(false);
    expect(driver.capabilities.replyTo).toBe(true);
    expect(driver.capabilities.replyHeaders).toBe(true);
    expect(driver.capabilities.providerFetch).toBe(true);
    expect(driver.capabilities.senderAuth).toBeUndefined();
    expect(driver.capabilities.senderMailbox).toBeUndefined();
    expect(driver.capabilities.replyThreadId).toBeUndefined();
    expect(driver.capabilities.sendTracking).toBeUndefined();
    expect(driver.capabilities.eventTracking).toEqual({
      opens: true,
      clicks: true,
    });
    expect(driver.capabilities.mailboxConnect).toBeUndefined();
    expect(driver.capabilities.publicRoutes?.connectCallback).toBeUndefined();
    expect(driver.capabilities.mailboxCreate).toBeUndefined();
    expect(driver.capabilities.mailboxList).toBeUndefined();
    expect(driver.capabilities.mailboxGet).toBeUndefined();
    expect(driver.capabilities.mailboxDelete).toBeUndefined();
    expect(driver.mailboxes).toBeUndefined();
  });

  it("gates account webhook facade support from Resend capabilities", () => {
    const client = EmailKit({
      emailDrivers: [ResendDriver({ apiKey: "re_test" })],
    });

    expect("webhooks" in client).toBe(true);
    expect("webhooks" in client.mailboxes).toBe(false);
    expect("webhooks" in client.domains).toBe(false);
  });

  it("maps send options to Resend and ignores EmailKit-only sender/auth fields", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "email_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({
      id: "transactional-resend",
      apiKey: "re_test",
    });
    const result = await driver.sendEmail(
      {
        from: { email: "sender@example.com", name: "Sender" },
        to: { email: "recipient@example.com" },
        cc: { email: "copy@example.com" },
        subject: "Hello",
        html: "<p>Hello</p>",
        reply: { addresses: [{ email: "reply@example.com" }] },
        attachments: [
          {
            filename: "receipt.txt",
            content: "paid",
            contentType: "text/plain",
          },
          {
            filename: "invoice.pdf",
            url: "https://example.com/invoice.pdf",
          },
        ],
        tags: ["welcome", { name: "cohort", value: "a_1" }],
        tenantId: "tenant-123",
        idempotencyKey: "idem_123",
        sendAt: new Date("2026-06-01T12:00:00.000Z"),
        metadata: { plan: "pro" },
      },
      {
        auth: { accessToken: "also-ignored" },
      },
    );

    expect(result).toEqual({
      messageId: "email_123",
      provider: "transactional-resend",
      providerId: "email_123",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      from: "Sender <sender@example.com>",
      to: ["recipient@example.com"],
      cc: ["copy@example.com"],
      subject: "Hello",
      html: "<p>Hello</p>",
      reply_to: "reply@example.com",
      scheduled_at: "2026-06-01T12:00:00.000Z",
      tags: [
        { name: "welcome", value: "true" },
        { name: "cohort", value: "a_1" },
        { name: "plan", value: "pro" },
        { name: "tenant", value: "tenant-123" },
      ],
      headers: {
        "X-Tenant-Id": "tenant-123",
      },
    });
    expect(body.attachments).toEqual([
      {
        filename: "receipt.txt",
        content_type: "text/plain",
        content: "cGFpZA==",
      },
      {
        filename: "invoice.pdf",
        path: "https://example.com/invoice.pdf",
      },
    ]);
    expect(body).not.toHaveProperty("sender");
    expect(body).not.toHaveProperty("auth");
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: "Bearer re_test",
      "Content-Type": "application/json",
      "Idempotency-Key": "idem_123",
    });
  });

  it("preserves Resend API EmailKitError details from send failures", async () => {
    const raw = { message: "The from address is invalid" };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response(JSON.stringify(raw), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    const driver = ResendDriver({ apiKey: "re_test" });

    try {
      await driver.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        html: "<p>Hello</p>",
      });
      throw new Error("Expected sendEmail to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(EmailKitError);
      expect((error as EmailKitError).httpStatus).toBe(400);
      expect((error as EmailKitError).raw).toEqual(raw);
      expect((error as EmailKitError).message).toContain("Bad Request");
      expect((error as EmailKitError).message).not.toContain(
        "Failed to send email",
      );
    }
  });

  it("does not send Resend API authorization to external attachment URLs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    const client = EmailKit({ emailDrivers: [driver] });

    await client.attachments.getContent({
      filename: "invoice.pdf",
      url: "https://cdn.example.com/resend/attachments/invoice.pdf?signature=abc",
      emailDriver: "resend",
    });
    await driver.providerFetch!("/emails/receiving/email_123");
    await driver.providerFetch!(
      "https://api.resend.com/emails/receiving/email_123",
    );

    const [, externalInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const [, relativeApiInit] = fetchMock.mock.calls[1] as [URL, RequestInit];
    const [, absoluteApiInit] = fetchMock.mock.calls[2] as [URL, RequestInit];

    expect(new Headers(externalInit.headers).get("authorization")).toBeNull();
    expect(new Headers(relativeApiInit.headers).get("authorization")).toBe(
      "Bearer re_test",
    );
    expect(new Headers(absoluteApiInit.headers).get("authorization")).toBe(
      "Bearer re_test",
    );
  });

  it("rejects Resend tags and metadata that cannot be represented as provider tags", async () => {
    const driver = ResendDriver({ apiKey: "re_test" });
    const baseMessage = {
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Hello",
      html: "<p>Hello</p>",
    };

    await expect(
      driver.sendEmail({
        ...baseMessage,
        tags: [{ name: "bad tag", value: "true" }],
      }),
    ).rejects.toMatchObject({
      code: "INVALID_TAG",
      message: expect.stringContaining("ASCII letters"),
    });

    await expect(
      driver.sendEmail({
        ...baseMessage,
        metadata: { plan: "pro plan" },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_TAG",
      message: expect.stringContaining("message.metadata"),
    });
  });

  it("rejects send-time tracking controls because Resend only exposes tracking events", async () => {
    const driver = ResendDriver({ apiKey: "re_test" });

    await expect(
      driver.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        html: "<p>Hello</p>",
        track: { opens: false, clicks: true },
      } as any),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_SEND_TRACKING",
    });
  });

  it("rejects provider thread ids and reply flags that Resend cannot map", async () => {
    const driver = ResendDriver({ apiKey: "re_test" });
    const baseMessage = {
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Hello",
      html: "<p>Hello</p>",
    };

    await expect(
      driver.sendEmail({
        ...baseMessage,
        reply: { threadId: "thread_123" },
      } as any),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_REPLY_THREAD_ID",
    });

    await expect(
      driver.sendEmail({
        ...baseMessage,
        reply: { isReply: true },
      } as any),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_REPLY_FLAG",
    });
  });

  it("omits html and text when sending a Resend template", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "email_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    await driver.sendEmail({
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Hello",
      html: "<p>Ignored</p>",
      text: "Ignored",
      templateId: "tpl_123",
      templateData: { CTA: "Go" },
    });

    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body).toMatchObject({
      template: {
        id: "tpl_123",
        variables: { CTA: "Go" },
      },
    });
    expect(body).not.toHaveProperty("html");
    expect(body).not.toHaveProperty("text");
  });

  it("creates account webhooks with mapped Resend events", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "wh_123",
          signing_secret: "whsec_test",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    const result = await driver.webhooks!.account!.setup!({
      url: "https://example.com/webhooks/resend",
      events: ["outbound", "clicked", "inbound"],
    });

    expect(result).toMatchObject({
      webhook: {
        id: "wh_123",
        providerId: "wh_123",
        scope: "account",
        url: "https://example.com/webhooks/resend",
        events: ["outbound", "clicked", "inbound"],
        status: "active",
        provider: { signingSecret: "whsec_test" },
      },
      raw: {
        id: "wh_123",
        signing_secret: "whsec_test",
      },
    });
    expect(result.webhook).not.toHaveProperty("secret");
    expect(result.webhook).not.toHaveProperty("auth");

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.resend.com/webhooks",
    );
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer re_test",
        "Content-Type": "application/json",
      },
    });
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      endpoint: "https://example.com/webhooks/resend",
      events: ["email.sent", "email.clicked", "email.received"],
    });
  });

  it("requires the core-injected account webhook url before calling Resend", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });

    await expect(
      driver.webhooks!.account!.setup!({
        events: ["outbound"],
      }),
    ).rejects.toMatchObject({
      provider: "resend",
      code: "MISSING_REQUIRED_FIELD",
      message: "Webhook setup requires input.url",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses default account webhook events when no events are provided", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "wh_default" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    await driver.webhooks!.account!.setup!({
      url: "https://example.com/webhooks/resend",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      endpoint: "https://example.com/webhooks/resend",
      events: [
        "email.sent",
        "email.delivered",
        "email.delivery_delayed",
        "email.failed",
        "email.opened",
        "email.clicked",
        "email.bounced",
        "email.complained",
        "email.unsubscribed",
        "email.received",
        "email.scheduled",
        "email.suppressed",
      ],
    });
  });

  it("expands events all to every Resend webhook event EmailKit supports", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "wh_all" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    await driver.webhooks!.account!.setup!({
      url: "https://example.com/webhooks/resend",
      events: "all",
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      endpoint: "https://example.com/webhooks/resend",
      events: [
        "email.sent",
        "email.delivered",
        "email.delivery_delayed",
        "email.failed",
        "email.opened",
        "email.clicked",
        "email.bounced",
        "email.complained",
        "email.unsubscribed",
        "email.received",
        "email.scheduled",
        "email.suppressed",
      ],
    });
  });

  it("maps EmailKit webhook event requests to all normalized Resend email events", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "wh_events" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    await driver.webhooks!.account!.setup!({
      url: "https://example.com/webhooks/resend",
      events: ["delivered", "rejected"],
    });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      endpoint: "https://example.com/webhooks/resend",
      events: ["email.delivered", "email.failed", "email.suppressed"],
    });
  });

  it("refreshes account webhooks by provider id without renewal metadata", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "wh_123",
          endpoint: "https://example.com/webhooks/resend",
          status: "enabled",
          events: ["email.sent", "email.delivered", "email.opened"],
          created_at: "2026-05-01T12:00:00.000Z",
          signing_secret: "whsec_test",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    const result = await driver.webhooks!.account!.refresh!({
      webhook: {
        id: "local_wh",
        providerId: "wh_123",
        scope: "account",
        url: "https://old.example.com/resend",
        status: "pending",
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.resend.com/webhooks/wh_123",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: { Authorization: "Bearer re_test" },
    });
    expect(result.webhook).toMatchObject({
      id: "wh_123",
      providerId: "wh_123",
      scope: "account",
      url: "https://example.com/webhooks/resend",
      events: ["outbound", "delivered", "opened"],
      status: "active",
      provider: { signingSecret: "whsec_test" },
    });
    expect(result.webhook.createdAt).toEqual(
      new Date("2026-05-01T12:00:00.000Z"),
    );
    expect(result.webhook.renewAfter).toBeUndefined();
    expect(result.webhook.expiresAt).toBeUndefined();
  });

  it("deletes account webhooks by webhook id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ object: "webhook", id: "wh_123", deleted: true }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    const result = await driver.webhooks!.account!.delete!({
      webhookId: "wh_123",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.resend.com/webhooks/wh_123",
    );
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "DELETE",
      headers: { Authorization: "Bearer re_test" },
    });
    expect(result).toMatchObject({
      deleted: true,
      webhook: {
        id: "wh_123",
        providerId: "wh_123",
        scope: "account",
        status: "deleted",
      },
      raw: { object: "webhook", id: "wh_123", deleted: true },
    });
  });

  it("reports Resend account webhook delete failures with delete terminology", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 })),
    );

    const driver = ResendDriver({ apiKey: "re_test" });

    await expect(
      driver.webhooks!.account!.delete!({ webhookId: "wh_123" }),
    ).rejects.toMatchObject({
      provider: "resend",
      httpStatus: 500,
      message: expect.stringContaining("Failed to delete webhook"),
    });
  });

  it("rejects public Resend webhooks when no signing secret is configured", async () => {
    const onClicked = vi.fn();
    const client = EmailKit({
      emailDrivers: [ResendDriver({ apiKey: "re_test" })],
      hooks: { email: { onClicked } },
    });

    const response = await client.handler()({
      method: "POST",
      headers: {},
      body: {
        type: "email.clicked",
        created_at: "2026-02-22T23:41:12.126Z",
        data: {
          email_id: "email_123",
          from: "Sender <sender@example.com>",
          to: ["recipient@example.com"],
          subject: "Hello",
          created_at: "2026-02-22T23:41:11.894719+00:00",
        },
      },
    });

    expect(response.status).toBe(401);
    expect(onClicked).not.toHaveBeenCalled();
  });

  it("normalizes Resend outbound webhooks to EmailKit webhook events", async () => {
    const driver = ResendDriver({ apiKey: "re_test" });
    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        type: "email.clicked",
        created_at: "2026-02-22T23:41:12.126Z",
        data: {
          email_id: "email_123",
          from: "Sender <sender@example.com>",
          to: ["recipient@example.com"],
          subject: "Hello",
          created_at: "2026-02-22T23:41:11.894719+00:00",
          link: "https://example.com",
          ip_address: "127.0.0.1",
          user_agent: "test-agent",
          tags: {
            plan: "pro",
            category: "welcome",
          },
        },
      },
    });

    expect(event.type).toBe("clicked");
    expect(event.data).toMatchObject({
      schemaVersion: "1",
      eventId: "email_123:email.clicked:2026-02-22T23:41:12.126Z",
      providerId: "email_123",
      recipient: "recipient@example.com",
      recipientDomain: "example.com",
      status: "clicked",
      from: { name: "Sender", email: "sender@example.com" },
      to: [{ email: "recipient@example.com" }],
      subject: "Hello",
      url: "https://example.com",
      ip: "127.0.0.1",
      userAgent: "test-agent",
      tags: [
        { name: "plan", value: "pro" },
        { name: "category", value: "welcome" },
      ],
      metadata: {
        plan: "pro",
        category: "welcome",
      },
    });
  });

  it("normalizes Resend failed and suppressed webhook events as rejected", async () => {
    const driver = ResendDriver({ apiKey: "re_test" });

    const failedEvent = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        type: "email.failed",
        created_at: "2026-02-22T23:41:12.126Z",
        data: {
          email_id: "email_failed",
          from: "Sender <sender@example.com>",
          to: ["recipient@example.com"],
          subject: "Hello",
          created_at: "2026-02-22T23:41:11.894719+00:00",
          failed: { reason: "reached_daily_quota" },
        },
      },
    });

    expect(failedEvent.type).toBe("rejected");
    expect(failedEvent.data).toMatchObject({
      eventId: "email_failed:email.failed:2026-02-22T23:41:12.126Z",
      providerId: "email_failed",
      status: "rejected",
      reason: "reached_daily_quota",
    });

    const suppressedEvent = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        type: "email.suppressed",
        created_at: "2026-02-22T23:41:12.126Z",
        data: {
          email_id: "email_suppressed",
          from: "Sender <sender@example.com>",
          to: ["recipient@example.com"],
          subject: "Hello",
          created_at: "2026-02-22T23:41:11.894719+00:00",
          suppressed: {
            message: "Resend has suppressed sending to this address",
            type: "OnAccountSuppressionList",
          },
        },
      },
    });

    expect(suppressedEvent.type).toBe("rejected");
    expect(suppressedEvent.data).toMatchObject({
      eventId: "email_suppressed:email.suppressed:2026-02-22T23:41:12.126Z",
      providerId: "email_suppressed",
      status: "rejected",
      reason: "Resend has suppressed sending to this address",
      category: "OnAccountSuppressionList",
    });
  });

  it("normalizes Resend delivery delays as outbound, not delivered", async () => {
    const driver = ResendDriver({ apiKey: "re_test" });
    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        type: "email.delivery_delayed",
        created_at: "2026-02-22T23:41:12.126Z",
        data: {
          email_id: "email_delayed",
          from: "Sender <sender@example.com>",
          to: ["recipient@example.com"],
          subject: "Hello",
          created_at: "2026-02-22T23:41:11.894719+00:00",
          delayed: { reason: "Remote server deferred delivery" },
        },
      },
    });

    expect(event.type).toBe("outbound");
    expect(event.type).not.toBe("delivered");
    expect(event.data as any).toMatchObject({
      eventId: "email_delayed:email.delivery_delayed:2026-02-22T23:41:12.126Z",
      providerId: "email_delayed",
      status: "sent",
      category: "delivery_delayed",
      reason: "Remote server deferred delivery",
    });
  });
});

import { createHmac } from "node:crypto";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { EmailKit, EmailKitError, MailgunDriver } from "../src";
import type { SyncStream, WebhookDriverEvent } from "../src";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const testWebhookSigningKey = "key-test-webhook-signing";
let mailgunSignatureCounter = 0;

const signedMailgunEventBody = <T extends Record<string, unknown>>(body: T): T => {
  mailgunSignatureCounter += 1;
  const timestamp = String(1_529_006_854 + mailgunSignatureCounter);
  const token = `token-${mailgunSignatureCounter}`;
  return {
    ...body,
    signature: {
      timestamp,
      token,
      signature: createHmac("sha256", testWebhookSigningKey)
        .update(timestamp + token)
        .digest("hex"),
    },
  };
};

const signedMailgunRouteBody = <T extends Record<string, unknown>>(body: T): T => {
  mailgunSignatureCounter += 1;
  const timestamp = String(1_529_006_854 + mailgunSignatureCounter);
  const token = `token-${mailgunSignatureCounter}`;
  return {
    ...body,
    timestamp,
    token,
    signature: createHmac("sha256", testWebhookSigningKey)
      .update(timestamp + token)
      .digest("hex"),
  };
};

const mailgunDomainResponse = {
  domain: {
    id: "dom_123",
    name: "mg.example.com",
    state: "active",
    created_at: "Thu, 13 Oct 2011 18:02:00 GMT",
  },
  sending_dns_records: [
    {
      record_type: "TXT",
      name: "mg.example.com",
      value: "v=spf1 include:mailgun.org ~all",
      valid: "valid",
      is_active: true,
      cached: [],
    },
  ],
  receiving_dns_records: [
    {
      record_type: "MX",
      name: "mg.example.com",
      value: "mxa.mailgun.org",
      priority: "10",
      valid: "valid",
      is_active: true,
      cached: [],
    },
  ],
};

describe("MailgunDriver core API shape", () => {
  it("defaults to the mailgun id and preserves custom literal ids", () => {
    const defaultDriver = MailgunDriver({ apiKey: "key-test" });
    const customDriver = MailgunDriver({
      apiKey: "key-test",
      id: "mailgun-eu",
    });

    expect(defaultDriver.id).toBe("mailgun");
    expect(customDriver.id).toBe("mailgun-eu");
    expectTypeOf(customDriver.id).toEqualTypeOf<"mailgun-eu">();
    expect(customDriver.capabilities).toMatchObject({
      replyTo: true,
      replyHeaders: true,
      replyThreadId: false,
      templates: true,
      unsubscribe: false,
      sendTracking: { opens: true, clicks: true },
      eventTracking: { opens: true, clicks: true },
      sandbox: true,
      providerFetch: true,
      domains: {
        list: true,
        create: true,
        get: true,
        update: true,
        verify: true,
        delete: true,
        identifier: "domain",
      },
      webhooks: { account: true, domain: true },
      sync: { domain: true },
      publicRoutes: { webhook: true },
      requiresSecret: false,
    });
    expect(customDriver.capabilities).not.toHaveProperty("senderAuth");
    expect(customDriver.capabilities).not.toHaveProperty("senderMailbox");
    expect(customDriver.capabilities).not.toHaveProperty("mailboxConnect");
    expect(customDriver.capabilities).not.toHaveProperty("mailboxCreate");
    expect(customDriver.capabilities).not.toHaveProperty("mailboxList");
  });

  it("uses public domain input/output without name compatibility fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(mailgunDomainResponse), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const domain = await driver.domains!.create!({
      domain: "mg.example.com",
    });

    const formData = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(formData.get("name")).toBe("mg.example.com");
    expect(domain).toMatchObject({
      id: "dom_123",
      domain: "mg.example.com",
      status: "verified",
    });
    expect("name" in domain).toBe(false);
    expect(domain.verification?.records).toHaveLength(2);
  });

  it("rejects unsupported Mailgun domain update fields before calling the API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });

    await expect(
      driver.domains!.update!("mg.example.com", {
        tracking: { opens: false },
      }),
    ).rejects.toMatchObject({
      provider: "mailgun",
      code: "NOT_SUPPORTED",
    });
    await expect(
      driver.domains!.update!("mg.example.com", { dkimSelector: "s2" }),
    ).rejects.toMatchObject({
      provider: "mailgun",
      code: "NOT_SUPPORTED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("MailgunDriver sendEmail", () => {
  it("maps new send options to Mailgun form fields and ignores sender auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "<20260521120000.abc@mailgun.example>",
          message: "Queued. Thank you.",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test", id: "mailgun-eu" });
    const result = await driver.sendEmail(
      {
        from: { email: "sender@mg.example.com", name: "Sender" },
        to: [{ email: "recipient@example.com" }],
        subject: "Hello",
        text: "Text body",
        reply: {
          addresses: [{ email: "reply@mg.example.com" }],
          messageId: "<previous@example.com>",
          references: ["<root@example.com>", "<previous@example.com>"],
        },
        track: { opens: false, clicks: true },
        sendAt: new Date(Date.UTC(2011, 9, 14, 23, 10, 10)),
        tags: ["campaign", { name: "plan", value: "pro" }],
        sandbox: true,
        tenantId: "tenant-123",
        metadata: { orderId: "ord_123" },
        provider: { "require-tls": "yes" },
      },
      { auth: { ignored: true } },
    );

    expect(result).toMatchObject({
      provider: "mailgun-eu",
      providerId: "<20260521120000.abc@mailgun.example>",
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.mailgun.net/v3/mg.example.com/messages",
    );

    const formData = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(formData.get("from")).toBe("Sender <sender@mg.example.com>");
    expect(formData.get("to")).toBe("recipient@example.com");
    expect(formData.get("h:Reply-To")).toBe("reply@mg.example.com");
    expect(formData.get("h:In-Reply-To")).toBe("<previous@example.com>");
    expect(formData.get("h:References")).toBe(
      "<root@example.com> <previous@example.com>",
    );
    expect(formData.get("o:tracking-opens")).toBe("no");
    expect(formData.get("o:tracking-clicks")).toBe("yes");
    expect(formData.get("o:deliverytime")).toBe(
      "Fri, 14 Oct 2011 23:10:10 +0000",
    );
    expect(formData.getAll("o:tag")).toEqual([
      "campaign",
      "plan:pro",
      "tenant:tenant-123",
    ]);
    expect(formData.get("v:orderId")).toBe("ord_123");
    expect(formData.get("o:testmode")).toBe("yes");
    expect(formData.get("o:require-tls")).toBe("yes");
  });

  it("preserves Mailgun/domain tracking defaults when track is omitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "<id@mailgun.example>" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    await driver.sendEmail({
      from: { email: "sender@mg.example.com" },
      to: { email: "recipient@example.com" },
      subject: "Defaults",
      text: "Body",
    });

    const formData = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(formData.has("o:tracking")).toBe(false);
    expect(formData.has("o:tracking-opens")).toBe(false);
    expect(formData.has("o:tracking-clicks")).toBe(false);
  });

  it("maps Mailgun templates and sandbox mode", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "<tpl@mailgun.example>" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    await driver.sendEmail({
      from: { email: "sender@mg.example.com" },
      to: { email: "recipient@example.com" },
      subject: "Template",
      templateId: "welcome",
      templateData: { firstName: "Ada", plan: "pro" },
      sandbox: true,
    });

    const formData = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(formData.get("template")).toBe("welcome");
    expect(formData.get("t:variables")).toBe(
      JSON.stringify({ firstName: "Ada", plan: "pro" }),
    );
    expect(formData.get("o:testmode")).toBe("yes");
  });

  it("fetches URL-only outbound attachments before posting to Mailgun", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("attachment body", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "<att@mailgun.example>" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    await driver.sendEmail({
      from: { email: "sender@mg.example.com" },
      to: { email: "recipient@example.com" },
      subject: "Attachment",
      text: "Body",
      attachments: [
        {
          filename: "report.txt",
          url: "https://files.example.com/report.txt",
          contentType: "text/plain",
        },
      ],
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://files.example.com/report.txt",
    );
    const formData = fetchMock.mock.calls[1]?.[1]?.body as FormData;
    const attachment = formData.get("attachment") as File;
    expect(attachment.name).toBe("report.txt");
    await expect(attachment.text()).resolves.toBe("attachment body");
  });

  it("rejects URL-only outbound attachments when content cannot be fetched", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not found", {
        status: 404,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    await expect(
      driver.sendEmail({
        from: { email: "sender@mg.example.com" },
        to: { email: "recipient@example.com" },
        subject: "Attachment",
        text: "Body",
        attachments: [
          {
            filename: "missing.txt",
            url: "https://files.example.com/missing.txt",
          },
        ],
      }),
    ).rejects.toMatchObject({
      provider: "mailgun",
      code: "ATTACHMENT_FETCH_FAILED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects unsupported reply thread ids and reply flags without RFC headers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const baseMessage = {
      from: { email: "sender@mg.example.com" },
      to: { email: "recipient@example.com" },
      subject: "Reply",
      text: "Body",
    };

    await expect(
      driver.sendEmail({
        ...baseMessage,
        reply: { threadId: "thread_123" },
      } as any),
    ).rejects.toMatchObject({
      provider: "mailgun",
      code: "UNSUPPORTED_REPLY_THREAD_ID",
    });

    await expect(
      driver.sendEmail({
        ...baseMessage,
        reply: { isReply: true },
      } as any),
    ).rejects.toMatchObject({
      provider: "mailgun",
      code: "UNSUPPORTED_REPLY_FLAG",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects normalized unsubscribe and misleading idempotency options", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const baseMessage = {
      from: { email: "sender@mg.example.com" },
      to: { email: "recipient@example.com" },
      subject: "Unsupported",
      text: "Body",
    };

    await expect(
      driver.sendEmail({
        ...baseMessage,
        unsubscribe: { global: true },
      } as any),
    ).rejects.toMatchObject({
      provider: "mailgun",
      code: "UNSUPPORTED_UNSUBSCRIBE",
    });

    await expect(
      driver.sendEmail({
        ...baseMessage,
        provider: { idempotencyKey: "idem-123" },
      }),
    ).rejects.toMatchObject({
      provider: "mailgun",
      code: "UNSUPPORTED_IDEMPOTENCY_KEY",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("MailgunDriver webhooks", () => {
  it("sets up account delivery lifecycle webhooks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ webhook_id: "wh_account_123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({
      apiKey: "key-test",
      id: "mailgun-eu",
      region: "eu",
    });
    const result = await driver.webhooks!.account!.setup!({
      url: "https://hooks.example.com/mailgun",
      events: ["outbound", "delivered", "bounced"],
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.eu.mailgun.net/v1/webhooks",
    );
    const formData = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(formData.get("url")).toBe("https://hooks.example.com/mailgun");
    expect(formData.getAll("event_types")).toEqual([
      "accepted",
      "delivered",
      "permanent_fail",
      "temporary_fail",
    ]);
    expect(result.webhook).toMatchObject({
      id: "wh_account_123",
      scope: "account",
      url: "https://hooks.example.com/mailgun",
      providerId: "wh_account_123",
      events: ["outbound", "delivered", "bounced"],
      status: "active",
    });
  });

  it("sets up account delivery webhooks and explicit inbound routes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ webhook_id: "wh_account_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "Route has been created",
            route: {
              id: "route_account_123",
              expression: 'match_recipient(".*@example.com")',
              actions: ['forward("https://hooks.example.com/mailgun")'],
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const result = await driver.webhooks!.account!.setup!({
      url: "  https://hooks.example.com/mailgun  ",
      events: "all",
      inbound: {
        recipients: "all",
      },
      provider: {
        routePriority: 3,
        routeDescription: "EmailKit account inbound catch-all",
      },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.mailgun.net/v1/webhooks",
    );
    const webhookBody = fetchMock.mock.calls[0]?.[1]?.body as FormData;
    expect(webhookBody.get("url")).toBe("https://hooks.example.com/mailgun");
    expect(webhookBody.getAll("event_types")).toEqual([
      "accepted",
      "delivered",
      "opened",
      "clicked",
      "permanent_fail",
      "temporary_fail",
      "complained",
      "unsubscribed",
    ]);

    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.mailgun.net/v3/routes",
    );
    const routeBody = fetchMock.mock.calls[1]?.[1]?.body as URLSearchParams;
    expect(routeBody.get("priority")).toBe("3");
    expect(routeBody.get("description")).toBe(
      "EmailKit account inbound catch-all",
    );
    expect(routeBody.get("expression")).toBe('match_recipient(".*")');
    expect(routeBody.get("action")).toBe(
      'forward("https://hooks.example.com/mailgun")',
    );
    expect(result.webhook).toMatchObject({
      id: "wh_account_123",
      scope: "account",
      url: "https://hooks.example.com/mailgun",
      providerId: "wh_account_123",
      events: [
        "outbound",
        "delivered",
        "opened",
        "clicked",
        "bounced",
        "complained",
        "unsubscribed",
        "inbound",
      ],
      provider: {
        routeId: "route_account_123",
        deliveryEvents: [
          "accepted",
          "delivered",
          "opened",
          "clicked",
          "permanent_fail",
          "temporary_fail",
          "complained",
          "unsubscribed",
        ],
      },
    });
  });

  it("requires an injected account webhook url before Mailgun setup", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    await expect(
      driver.webhooks!.account!.setup!({
        url: "  ",
        events: ["delivered"],
      }),
    ).rejects.toThrow("Mailgun account webhook setup requires a url");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects account inbound setup without explicit Mailgun route options", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    await expect(
      driver.webhooks!.account!.setup!({
        url: "https://hooks.example.com/mailgun",
        events: ["inbound", "delivered"],
      }),
    ).rejects.toThrow(
      "Mailgun inbound route setup requires inbound.recipients",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes and deletes account webhooks by provider id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            webhook_id: "wh_account_123",
            url: "https://hooks.example.com/mailgun",
            event_types: ["accepted", "opened"],
            created_at: "2026-05-21T12:00:00Z",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const refreshed = await driver.webhooks!.account!.refresh!({
      providerId: "wh_account_123",
    });
    const deleted = await driver.webhooks!.account!.delete!({
      webhook: refreshed.webhook,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.mailgun.net/v1/webhooks/wh_account_123",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.mailgun.net/v1/webhooks/wh_account_123",
    );
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("DELETE");
    expect(refreshed.webhook.events).toEqual(["outbound", "opened"]);
    expect(deleted).toMatchObject({
      deleted: true,
      webhook: { status: "deleted", providerId: "wh_account_123" },
    });
  });

  it("refreshes and deletes account webhooks with inbound route ids", async () => {
    const webhook = {
      id: "wh_account_123",
      providerId: "wh_account_123",
      scope: "account" as const,
      url: "https://hooks.example.com/mailgun",
      events: ["outbound", "inbound"] as const,
      status: "active" as const,
      provider: {
        routeId: "route_account_123",
        deliveryEvents: ["accepted"],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            webhook_id: "wh_account_123",
            url: "https://hooks.example.com/mailgun",
            event_types: ["accepted", "delivered"],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ route: { id: "route_account_123", actions: [] } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "Route has been deleted",
            id: "route_account_123",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const refreshed = await driver.webhooks!.account!.refresh!({
      webhook,
    });
    const deleted = await driver.webhooks!.account!.delete!({
      webhook: refreshed.webhook,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.mailgun.net/v1/webhooks/wh_account_123",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.mailgun.net/v3/routes/route_account_123",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      "https://api.mailgun.net/v1/webhooks/wh_account_123",
    );
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("DELETE");
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "https://api.mailgun.net/v3/routes/route_account_123",
    );
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("DELETE");
    expect(refreshed.webhook.events).toEqual([
      "outbound",
      "delivered",
      "inbound",
    ]);
    expect(deleted).toMatchObject({
      deleted: true,
      webhook: {
        status: "deleted",
        provider: { routeId: "route_account_123" },
      },
    });
  });

  it("sets up domain delivery lifecycle webhooks with the v4 multi-event API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          webhooks: {
            accepted: { urls: ["https://hooks.example.com/mailgun"] },
            opened: { urls: ["https://hooks.example.com/mailgun"] },
            clicked: { urls: ["https://hooks.example.com/mailgun"] },
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const result = await driver.webhooks!.domain!.setup!({
      domain: "mg.example.com",
      url: "https://hooks.example.com/mailgun",
      events: ["outbound", "opened", "clicked", "bounced"],
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.mailgun.net/v4/domains/mg.example.com/webhooks",
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("url")).toBe("https://hooks.example.com/mailgun");
    expect(body.getAll("event_types")).toEqual([
      "accepted",
      "opened",
      "clicked",
      "permanent_fail",
      "temporary_fail",
    ]);
    expect(result.webhook).toMatchObject({
      scope: "domain",
      url: "https://hooks.example.com/mailgun",
      events: ["outbound", "opened", "clicked", "bounced"],
      status: "active",
      provider: {
        domain: "mg.example.com",
        deliveryEvents: [
          "accepted",
          "opened",
          "clicked",
          "permanent_fail",
          "temporary_fail",
        ],
      },
    });
  });

  it("sets up domain inbound webhooks only when route provider options are present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          message: "Route has been created",
          route: {
            id: "route_123",
            expression: 'match_recipient(".*@mg.example.com")',
            actions: ['forward("https://hooks.example.com/inbound")'],
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const result = await driver.webhooks!.domain!.setup!({
      domain: "mg.example.com",
      url: "https://hooks.example.com/inbound",
      events: ["inbound"],
      provider: { routeRecipient: ".*@mg.example.com" },
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.mailgun.net/v3/routes",
    );
    const body = fetchMock.mock.calls[0]?.[1]?.body as URLSearchParams;
    expect(body.get("expression")).toBe('match_recipient(".*@mg.example.com")');
    expect(body.get("action")).toBe(
      'forward("https://hooks.example.com/inbound")',
    );
    expect(result.webhook).toMatchObject({
      scope: "domain",
      events: ["inbound"],
      provider: { domain: "mg.example.com", routeId: "route_123" },
    });
  });

  it("rejects ambiguous domain inbound setup without Mailgun route options", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    await expect(
      driver.webhooks!.domain!.setup!({
        domain: "mg.example.com",
        url: "https://hooks.example.com/inbound",
        events: ["inbound"],
      }),
    ).rejects.toBeInstanceOf(EmailKitError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an injected domain webhook url before Mailgun setup", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    await expect(
      driver.webhooks!.domain!.setup!({
        domain: "mg.example.com",
        events: ["delivered"],
      }),
    ).rejects.toThrow("Mailgun domain webhook setup requires a url");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes and deletes domain delivery webhooks and inbound routes", async () => {
    const url = "https://hooks.example.com/mailgun";
    const webhook = {
      id: `domain:mg.example.com:${url}`,
      providerId: `domain:mg.example.com:${url}`,
      scope: "domain" as const,
      url,
      events: ["outbound", "inbound"] as const,
      status: "active" as const,
      provider: {
        domain: "mg.example.com",
        routeId: "route_123",
        deliveryEvents: ["accepted"],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            webhooks: {
              accepted: { urls: [url] },
              permanent_fail: { urls: [url] },
              clicked: { urls: [] },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ route: { id: "route_123", actions: [] } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            webhooks: {
              accepted: { urls: [] },
              permanent_fail: { urls: [] },
              clicked: { urls: [] },
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            message: "Route has been deleted",
            id: "route_123",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const refreshed = await driver.webhooks!.domain!.refresh!({
      domain: "mg.example.com",
      webhook,
    });
    const deleted = await driver.webhooks!.domain!.delete!({
      domain: "mg.example.com",
      webhook: refreshed.webhook,
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api.mailgun.net/v3/domains/mg.example.com/webhooks",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://api.mailgun.net/v3/routes/route_123",
    );
    expect(fetchMock.mock.calls[2]?.[0]).toBe(
      `https://api.mailgun.net/v4/domains/mg.example.com/webhooks?url=${encodeURIComponent(
        url,
      )}`,
    );
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("DELETE");
    expect(fetchMock.mock.calls[3]?.[0]).toBe(
      "https://api.mailgun.net/v3/routes/route_123",
    );
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("DELETE");
    expect(refreshed.webhook.events).toEqual([
      "outbound",
      "bounced",
      "inbound",
    ]);
    expect(deleted).toMatchObject({
      deleted: true,
      webhook: { status: "deleted" },
    });
  });

  it("normalizes lowercase inbound route payloads and parsed message headers", async () => {
    const driver = MailgunDriver({ apiKey: "key-test" });

    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        timestamp: "1710000000",
        from: "Alice <alice@example.com>",
        recipient: "reply@mg.example.com",
        subject: "Re: Hello",
        "body-plain": "Thanks",
        "stripped-text": "Thanks",
        "message-headers": JSON.stringify([
          ["Message-Id", "<reply@example.com>"],
          ["In-Reply-To", "<original@example.com>"],
          ["References", "<root@example.com> <original@example.com>"],
          ["Reply-To", "Alice Replies <replies@example.com>"],
        ]),
      },
    });

    expect(event.type).toBe("inbound");
    if (event.type !== "inbound") return;

    expect(event.data).toMatchObject({
      messageId: "<reply@example.com>",
      from: { name: "Alice", email: "alice@example.com" },
      to: [{ email: "reply@mg.example.com" }],
      subject: "Re: Hello",
      text: "Thanks",
      reply: {
        addresses: [{ name: "Alice Replies", email: "replies@example.com" }],
        messageId: "<original@example.com>",
        references: ["<root@example.com>", "<original@example.com>"],
        isReply: true,
      },
    });
  });

  it("lazily fetches stored inbound attachments with message-only metadata", async () => {
    const storageUrl =
      "https://storage.mailgun.net/v3/domains/mg.example.com/messages/msg_123";
    const attachmentUrl =
      "https://storage.mailgun.net/v3/domains/mg.example.com/messages/msg_123/attachments/0";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            attachments: [
              {
                filename: "invoice.pdf",
                url: attachmentUrl,
                "content-type": "application/pdf",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("invoice body", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({
      apiKey: "key-test",
      inboundAttachmentHandling: "stored",
      autoFetchInboundAttachments: false,
    });
    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        "body-plain": "See attached",
        "body-html": "<p>See attached</p>",
        "stripped-text": "See attached",
        "stripped-html": "<p>See attached</p>",
        "event-data": {
          message: {
            headers: {
              "message-id": "<stored@example.com>",
              from: "Sender <sender@example.com>",
              to: "inbound@mg.example.com",
              subject: "Stored",
            },
            storage: { url: storageUrl, key: "msg_123" },
            attachments: [
              {
                filename: "invoice.pdf",
                "content-type": "application/pdf",
                size: 42,
              },
            ],
          },
        },
      },
    });

    expect(event.type).toBe("inbound");
    if (event.type !== "inbound") return;
    const attachment = event.data.attachments![0]!;
    expect(attachment.url).toBeTruthy();
    expect(attachment.url).not.toBe(storageUrl);
    expect(attachment.provider).toMatchObject({
      mailgun: {
        kind: "stored-inbound-attachment",
        storageUrl,
        storageKey: "msg_123",
        filename: "invoice.pdf",
        index: 0,
      },
    });

    const emailkit = EmailKit({ emailDrivers: [driver] });
    const content = await emailkit.attachments.getContent(attachment);
    expect(new TextDecoder().decode(content as Uint8Array)).toBe(
      "invoice body",
    );
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      storageUrl,
      attachmentUrl,
    ]);
  });

  it("keeps lazy metadata when eager stored attachment fetching fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const storageUrl =
      "https://storage.mailgun.net/v3/domains/mg.example.com/messages/msg_456";
    const attachmentUrl =
      "https://storage.mailgun.net/v3/domains/mg.example.com/messages/msg_456/attachments/0";
    const storedMessage = {
      attachments: [
        {
          filename: "report.csv",
          url: attachmentUrl,
          "content-type": "text/csv",
        },
      ],
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(storedMessage), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("expired", { status: 410 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(storedMessage), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response("a,b\n1,2\n", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({
      apiKey: "key-test",
      inboundAttachmentHandling: "stored",
    });
    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        "body-plain": "See attached",
        "body-html": "<p>See attached</p>",
        "stripped-text": "See attached",
        "stripped-html": "<p>See attached</p>",
        storage: { url: storageUrl, key: "msg_456" },
        "attachment-count": "1",
        "attachment-1": "report.csv;12;text/csv",
        From: "Sender <sender@example.com>",
        To: "inbound@mg.example.com",
        Subject: "Stored",
      },
    });

    expect(event.type).toBe("inbound");
    if (event.type !== "inbound") return;
    const attachment = event.data.attachments![0]!;
    expect(attachment.content).toBeUndefined();
    expect(attachment.provider).toMatchObject({
      mailgun: { storageUrl, filename: "report.csv", index: 0 },
    });

    const emailkit = EmailKit({ emailDrivers: [driver] });
    const content = await emailkit.attachments.getContent(attachment);
    expect(new TextDecoder().decode(content as Uint8Array)).toBe("a,b\n1,2\n");
  });

  it("recognizes event-data.storage for stored inbound attachments", async () => {
    const storageUrl =
      "https://storage.mailgun.net/v3/domains/mg.example.com/messages/msg_789";
    const driver = MailgunDriver({
      apiKey: "key-test",
      inboundAttachmentHandling: "stored",
      autoFetchInboundAttachments: false,
    });

    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        "body-plain": "Stored through event data",
        "body-html": "<p>Stored through event data</p>",
        "stripped-text": "Stored through event data",
        "stripped-html": "<p>Stored through event data</p>",
        "event-data": {
          storage: { url: storageUrl, key: "msg_789" },
          message: {
            headers: {
              "message-id": "<stored-event-data@example.com>",
              from: "Sender <sender@example.com>",
              to: "inbound@mg.example.com",
              subject: "Stored",
            },
            attachments: [{ filename: "event-data.txt" }],
          },
        },
      },
    });

    expect(event.type).toBe("inbound");
    if (event.type !== "inbound") return;
    expect(event.data.attachments![0]).toMatchObject({
      filename: "event-data.txt",
      provider: {
        mailgun: {
          storageUrl,
          storageKey: "msg_789",
        },
      },
    });
  });

  it("accepts filename in flat stored attachments JSON", async () => {
    const storageUrl =
      "https://storage.mailgun.net/v3/domains/mg.example.com/messages/msg_flat";
    const driver = MailgunDriver({
      apiKey: "key-test",
      inboundAttachmentHandling: "stored",
      autoFetchInboundAttachments: false,
    });

    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        "body-plain": "Flat attachment JSON",
        "body-html": "<p>Flat attachment JSON</p>",
        "stripped-text": "Flat attachment JSON",
        "stripped-html": "<p>Flat attachment JSON</p>",
        storage: { url: storageUrl, key: "msg_flat" },
        attachments: JSON.stringify([
          {
            filename: "flat.pdf",
            "content-type": "application/pdf",
            size: 123,
          },
        ]),
        From: "Sender <sender@example.com>",
        To: "inbound@mg.example.com",
        Subject: "Stored",
      },
    });

    expect(event.type).toBe("inbound");
    if (event.type !== "inbound") return;
    expect(event.data.attachments![0]).toMatchObject({
      filename: "flat.pdf",
      contentType: "application/pdf",
      size: 123,
      provider: {
        mailgun: {
          storageUrl,
          filename: "flat.pdf",
          index: 0,
        },
      },
    });
  });

  it("verifies Mailgun event signatures from JSON payloads", async () => {
    const signingKey = "key-55c5c5c5c55f55ca5cd5f55d5c555c55";
    const timestamp = "1529006854";
    const token = "a8ce0edb2dd8301dee6c2405235584e45aa91d1e9f979f3de0";
    const signature = createHmac("sha256", signingKey)
      .update(timestamp + token)
      .digest("hex");

    const driver = MailgunDriver({
      apiKey: "key-test",
      webhookSigningKey: signingKey,
    });

    await expect(
      driver.verifyWebhook!({
        method: "POST",
        headers: {},
        body: {
          signature: { timestamp, token, signature },
          "event-data": { event: "opened" },
        },
      }),
    ).resolves.toBe(true);
  });

  it("rejects public Mailgun webhooks when no signing key is configured", async () => {
    const onOpened = vi.fn();
    const client = EmailKit({
      emailDrivers: [MailgunDriver({ apiKey: "key-test" })],
      hooks: { email: { onOpened } },
    });

    const response = await client.handler()({
      method: "POST",
      headers: {},
      body: {
        "event-data": {
          id: "evt_opened",
          event: "opened",
          timestamp: 1529006854,
        },
      },
    });

    expect(response.status).toBe(401);
    expect(onOpened).not.toHaveBeenCalled();
  });

  it("feeds normalized outbound events into grouped email hooks", async () => {
    const onOpened = vi.fn();
    const onAll = vi.fn();
    const client = EmailKit({
      emailDrivers: [
        MailgunDriver({
          apiKey: "key-test",
          webhookSigningKey: testWebhookSigningKey,
        }),
      ],
      hooks: {
        email: {
          onAll,
          onOpened,
        },
      },
    });

    const response = await client.handler()({
      method: "POST",
      headers: {},
      body: signedMailgunEventBody({
        "event-data": {
          id: "evt_opened",
          event: "opened",
          timestamp: 1529006854,
          recipient: "recipient@example.com",
          ip: "203.0.113.10",
          "client-info": {
            "user-agent": "Mozilla/5.0",
            "device-type": "desktop",
          },
          message: {
            headers: {
              "message-id": "<message@example.com>",
              from: "Sender <sender@mg.example.com>",
              to: "recipient@example.com",
              subject: "Hello",
            },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(onAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: "opened" }),
    );
    expect(onOpened).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt_opened",
        messageId: "<message@example.com>",
        recipient: "recipient@example.com",
        status: "opened",
        ip: "203.0.113.10",
        userAgent: "Mozilla/5.0",
      }),
    );
  });

  it("reports inbound-looking Mailgun accepted events without firing inbound hooks", async () => {
    const onAll = vi.fn();
    const onInbound = vi.fn();
    const onOutbound = vi.fn();
    const onUnknown = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = EmailKit({
      emailDrivers: [
        MailgunDriver({
          apiKey: "key-test",
          webhookSigningKey: testWebhookSigningKey,
        }),
      ],
      hooks: {
        email: {
          onAll,
          onInbound,
          onOutbound,
          onUnknown,
        },
      },
    });

    const handler = client.handler();
    const response = await handler({
      method: "POST",
      headers: {},
      body: signedMailgunEventBody({
        "event-data": {
          id: "evt_accepted_inbound",
          event: "accepted",
          timestamp: 1529006854,
          domain: { name: "ingredients-experts.de" },
          recipient: "tino.heiden@ingredients-experts.de",
          "recipient-domain": "ingredients-experts.de",
          storage: {
            key: "stored_message_123",
            url: "https://storage.mailgun.net/v3/domains/ingredients-experts.de/messages/stored_message_123",
          },
          message: {
            headers: {
              "message-id": "<reply@example.com>",
              from: "Sender <sender@example.com>",
              to: "Tino <tino.heiden@ingredients-experts.de>",
              subject: "Re: Supplier Inquiry",
            },
          },
        },
      }),
    });
    const routeResponse = await handler({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: signedMailgunRouteBody({
        "body-plain": "Route body should be delivered.",
        "body-html": "<p>Route body should be delivered.</p>",
        From: "Sender <sender@example.com>",
        To: "Tino <tino.heiden@ingredients-experts.de>",
        Subject: "Re: Supplier Inquiry",
        "Message-Id": "<reply@example.com>",
        recipient: "tino.heiden@ingredients-experts.de",
      }),
    });

    expect(response.status).toBe(200);
    expect(routeResponse.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(onAll).toHaveBeenCalledTimes(2);
    expect(onAll).toHaveBeenCalledWith(
      expect.objectContaining({ type: "unknown" }),
    );
    expect(onAll).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "inbound",
      }),
    );
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(onInbound).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Re: Supplier Inquiry" }),
    );
    expect(onOutbound).not.toHaveBeenCalled();
    expect(onUnknown).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "unknown",
        data: expect.objectContaining({
          reason: "mailgun.inbound_accepted_lifecycle",
          event: "accepted",
          eventId: "evt_accepted_inbound",
          messageId: "<reply@example.com>",
          providerId: "stored_message_123",
        }),
      }),
    );
  });

  it("keeps Mailgun accepted events for outbound delivery as outbound", async () => {
    const onInbound = vi.fn();
    const onOutbound = vi.fn();
    const client = EmailKit({
      emailDrivers: [
        MailgunDriver({
          apiKey: "key-test",
          webhookSigningKey: testWebhookSigningKey,
        }),
      ],
      hooks: {
        email: {
          onInbound,
          onOutbound,
        },
      },
    });

    const response = await client.handler()({
      method: "POST",
      headers: {},
      body: signedMailgunEventBody({
        "event-data": {
          id: "evt_accepted_outbound",
          event: "accepted",
          timestamp: 1529006854,
          domain: { name: "mail.example.com" },
          recipient: "recipient@example.net",
          "recipient-domain": "example.net",
          storage: {
            key: "outbound_message_123",
            url: "https://storage.mailgun.net/v3/domains/mail.example.com/messages/outbound_message_123",
          },
          message: {
            headers: {
              "message-id": "<sent@example.com>",
              from: "Sender <sender@mail.example.com>",
              to: "recipient@example.net",
              subject: "Hello",
            },
          },
        },
      }),
    });

    expect(response.status).toBe(200);
    expect(onInbound).not.toHaveBeenCalled();
    expect(onOutbound).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt_accepted_outbound",
        messageId: "<sent@example.com>",
        providerId: "outbound_message_123",
        recipient: "recipient@example.net",
        status: "sent",
      }),
    );
  });
});

describe("MailgunDriver sync", () => {
  const eventsUrl = "https://api.mailgun.net/v3/mg.example.com/events";
  const storageUrl =
    "https://storage.mailgun.net/v3/domains/mg.example.com/messages/stored_key_1";

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const syncWindow = () => {
    const now = Date.now();
    return {
      since: new Date(now - 60 * 60 * 1000),
      until: new Date(now - 60 * 1000),
    };
  };

  const deliveredItem = (id: string, timestamp: Date) => ({
    id,
    event: "delivered",
    timestamp: timestamp.getTime() / 1000,
    recipient: "recipient@example.com",
    message: {
      headers: {
        "message-id": "<sent@example.com>",
        from: "Sender <sender@mg.example.com>",
        to: "recipient@example.com",
        subject: "Hello",
      },
    },
  });

  const storedItem = (id: string, timestamp: Date) => ({
    id,
    event: "stored",
    timestamp: timestamp.getTime() / 1000,
    storage: { url: storageUrl, key: "stored_key_1" },
    message: {
      headers: {
        "message-id": "<stored@example.com>",
        from: "Sender <sender@example.com>",
        to: "inbox@mg.example.com",
        subject: "Stored message",
      },
    },
  });

  const inboundAcceptedItem = (id: string, timestamp: Date) => ({
    id,
    event: "accepted",
    timestamp: timestamp.getTime() / 1000,
    recipient: "inbox@mg.example.com",
    storage: { url: storageUrl, key: "stored_key_1" },
    message: {
      headers: {
        "message-id": "<stored@example.com>",
        from: "Sender <sender@example.com>",
        to: "inbox@mg.example.com",
        subject: "Stored message",
      },
    },
  });

  const storedMessageJson = {
    From: "Sender <sender@example.com>",
    To: "Recipient <inbox@mg.example.com>",
    Subject: "Stored message",
    "Message-Id": "<stored@example.com>",
    "body-plain": "Stored body",
    "body-html": "<p>Stored body</p>",
    "stripped-text": "Stored body",
    "stripped-html": "<p>Stored body</p>",
    "message-headers": [
      ["Message-Id", "<stored@example.com>"],
      ["From", "Sender <sender@example.com>"],
      ["To", "Recipient <inbox@mg.example.com>"],
      ["Subject", "Stored message"],
    ],
  };

  const drainSync = async (stream: SyncStream) => {
    const events: WebhookDriverEvent[] = [];
    while (true) {
      const next = await stream.next();
      if (next.done) return { events, result: next.value };
      events.push(next.value);
    }
  };

  it("replays account sync across all listed domains oldest-first", async () => {
    const { since, until } = syncWindow();
    const alphaEventsUrl = "https://api.mailgun.net/v3/alpha.example.com/events";
    const betaEventsUrl = "https://api.mailgun.net/v3/beta.example.com/events";
    const alphaDeliveredAt = new Date(since.getTime() + 120_000);
    const betaDeliveredAt = new Date(since.getTime() + 60_000);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith("https://api.mailgun.net/v4/domains")) {
        const request = new URL(href);
        expect(request.searchParams.get("limit")).toBe("100");
        return jsonResponse({
          items: [
            { id: "dom_alpha", name: "alpha.example.com", state: "active" },
            { id: "dom_beta", name: "beta.example.com", state: "active" },
          ],
        });
      }
      if (href.startsWith(`${alphaEventsUrl}?`)) {
        return jsonResponse({
          items: [deliveredItem("evt_alpha", alphaDeliveredAt)],
          paging: {},
        });
      }
      if (href.startsWith(`${betaEventsUrl}?`)) {
        return jsonResponse({
          items: [deliveredItem("evt_beta", betaDeliveredAt)],
          paging: {},
        });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const { events, result } = await drainSync(
      driver.sync!.account!({ since, until }),
    );

    expect(events.map((event) => event.data.eventId)).toEqual([
      "evt_beta",
      "evt_alpha",
    ]);
    expect(result.syncedFrom.getTime()).toBe(since.getTime());
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("/v3/alpha.example.com/events"),
        expect.stringContaining("/v3/beta.example.com/events"),
      ]),
    );
  });

  it("dispatches account sync through the top-level client API", async () => {
    const { since, until } = syncWindow();
    const alphaEventsUrl = "https://api.mailgun.net/v3/alpha.example.com/events";
    const betaEventsUrl = "https://api.mailgun.net/v3/beta.example.com/events";
    const alphaDeliveredAt = new Date(since.getTime() + 120_000);
    const betaDeliveredAt = new Date(since.getTime() + 60_000);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith("https://api.mailgun.net/v4/domains")) {
        return jsonResponse({
          items: [
            { id: "dom_alpha", name: "alpha.example.com", state: "active" },
            { id: "dom_beta", name: "beta.example.com", state: "active" },
          ],
        });
      }
      if (href.startsWith(`${alphaEventsUrl}?`)) {
        return jsonResponse({
          items: [deliveredItem("evt_alpha", alphaDeliveredAt)],
          paging: {},
        });
      }
      if (href.startsWith(`${betaEventsUrl}?`)) {
        return jsonResponse({
          items: [deliveredItem("evt_beta", betaDeliveredAt)],
          paging: {},
        });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onAll = vi.fn();
    const client = EmailKit({
      emailDrivers: [MailgunDriver({ apiKey: "key-test" })],
      hooks: { email: { onAll } },
    });

    const result = await client.sync({ since, until });

    expect(result).toEqual({ dispatched: 2, syncedFrom: since });
    expect(onAll.mock.calls.map(([event]) => event.data.eventId)).toEqual([
      "evt_beta",
      "evt_alpha",
    ]);
  });

  it("replays delivered and stored events oldest-first across pages", async () => {
    const { since, until } = syncWindow();
    const deliveredAt = new Date(since.getTime() + 60_000);
    const storedAt = new Date(since.getTime() + 120_000);
    const page2Url = `${eventsUrl}/page-2`;
    const page3Url = `${eventsUrl}/page-3`;

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith(`${eventsUrl}?`)) {
        return jsonResponse({
          items: [deliveredItem("evt_delivered_1", deliveredAt)],
          paging: { next: page2Url },
        });
      }
      if (href === page2Url) {
        return jsonResponse({
          items: [storedItem("evt_stored_1", storedAt)],
          paging: { next: page3Url },
        });
      }
      if (href === page3Url) {
        return jsonResponse({ items: [], paging: {} });
      }
      if (href === storageUrl) {
        return jsonResponse(storedMessageJson);
      }
      throw new Error(`Unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const { events, result } = await drainSync(
      driver.sync!.domain!({ domain: "mg.example.com", since, until }),
    );

    const firstRequest = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(firstRequest.pathname).toBe("/v3/mg.example.com/events");
    expect(firstRequest.searchParams.get("begin")).toBe(
      String(Math.floor(since.getTime() / 1000)),
    );
    expect(firstRequest.searchParams.get("end")).toBe(
      String(Math.floor(until.getTime() / 1000)),
    );
    expect(firstRequest.searchParams.get("ascending")).toBe("yes");
    expect(firstRequest.searchParams.get("limit")).toBe("300");

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "delivered",
      data: {
        eventId: "evt_delivered_1",
        messageId: "<sent@example.com>",
        recipient: "recipient@example.com",
        status: "delivered",
      },
    });
    expect((events[0].data as { timestamp: Date }).timestamp.getTime()).toBe(
      deliveredAt.getTime(),
    );
    expect(events[1]).toMatchObject({
      type: "inbound",
      data: {
        eventId: "evt_stored_1",
        messageId: "<stored@example.com>",
        subject: "Stored message",
        text: "Stored body",
        html: "<p>Stored body</p>",
      },
    });
    expect((events[1].data as { timestamp: Date }).timestamp.getTime()).toBe(
      storedAt.getTime(),
    );

    const storageCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === storageUrl,
    );
    expect(storageCall?.[1]?.headers).toMatchObject({
      Authorization: expect.stringContaining("Basic "),
    });
    expect(result.syncedFrom.getTime()).toBe(since.getTime());
  });

  it("dedupes repeated stored events for the same stored message", async () => {
    const { since, until } = syncWindow();
    const storedAt = new Date(since.getTime() + 120_000);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith(`${eventsUrl}?`)) {
        return jsonResponse({
          items: [
            storedItem("evt_stored_1", storedAt),
            storedItem("evt_stored_2", new Date(storedAt.getTime() + 2)),
            storedItem("evt_stored_3", new Date(storedAt.getTime() + 4)),
          ],
          paging: {},
        });
      }
      if (href === storageUrl) {
        return jsonResponse(storedMessageJson);
      }
      throw new Error(`Unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const { events, result } = await drainSync(
      driver.sync!.domain!({ domain: "mg.example.com", since, until }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "inbound",
      data: {
        eventId: "evt_stored_1",
        messageId: "<stored@example.com>",
        subject: "Stored message",
      },
    });
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url) === storageUrl),
    ).toHaveLength(1);
    expect(result.syncedFrom.getTime()).toBe(since.getTime());
  });

  it("does not replay inbound accepted lifecycle events as outbound", async () => {
    const { since, until } = syncWindow();
    const acceptedAt = new Date(since.getTime() + 60_000);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith(`${eventsUrl}?`)) {
        return jsonResponse({
          items: [inboundAcceptedItem("evt_accepted_inbound", acceptedAt)],
          paging: {},
        });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const { events, result } = await drainSync(
      driver.sync!.domain!({ domain: "mg.example.com", since, until }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "unknown",
      data: {
        reason: "mailgun.inbound_accepted_lifecycle",
        event: "accepted",
        eventId: "evt_accepted_inbound",
        messageId: "<stored@example.com>",
        providerId: "stored_key_1",
      },
    });
    expect(result.syncedFrom.getTime()).toBe(since.getTime());
  });

  it("skips events from earlier in the same second as a millisecond since", async () => {
    const { until } = syncWindow();
    // `begin` floors to whole seconds, so the API also returns beforeSince.
    const since = new Date(until.getTime() - 60_000 + 500);
    const beforeSince = new Date(since.getTime() - 200);
    const afterSince = new Date(since.getTime() + 200);

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        items: [
          deliveredItem("evt_before_since", beforeSince),
          deliveredItem("evt_after_since", afterSince),
        ],
        paging: {},
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const { events, result } = await drainSync(
      driver.sync!.domain!({ domain: "mg.example.com", since, until }),
    );

    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ eventId: "evt_after_since" });
    expect(result.syncedFrom.getTime()).toBe(since.getTime());
  });

  it("reports truncated coverage when since is past Mailgun retention", async () => {
    const now = Date.now();
    const since = new Date(now - 10 * 24 * 60 * 60 * 1000);
    const deliveredAt = new Date(now - 2 * 60 * 60 * 1000);

    const fetchMock = vi.fn(async () =>
      jsonResponse({
        items: [deliveredItem("evt_delivered_old", deliveredAt)],
        paging: {},
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const { events, result } = await drainSync(
      driver.sync!.domain!({ domain: "mg.example.com", since }),
    );

    expect(events).toHaveLength(1);
    expect(result.syncedFrom.getTime()).toBe(deliveredAt.getTime());
    expect(result.syncedFrom.getTime()).toBeGreaterThan(since.getTime());
  });

  it("honors configured eventsRetentionDays as the coverage floor", async () => {
    const now = Date.now();
    const since = new Date(now - 10 * 24 * 60 * 60 * 1000);

    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test", eventsRetentionDays: 30 });
    const { events, result } = await drainSync(
      driver.sync!.domain!({ domain: "mg.example.com", since }),
    );

    expect(events).toHaveLength(0);
    expect(result.syncedFrom.getTime()).toBe(since.getTime());
  });

  it("reports zero coverage for empty windows fully past retention", async () => {
    const now = Date.now();
    const since = new Date(now - 10 * 24 * 60 * 60 * 1000);
    const until = new Date(now - 5 * 24 * 60 * 60 * 1000);

    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const { events, result } = await drainSync(
      driver.sync!.domain!({ domain: "mg.example.com", since, until }),
    );

    expect(events).toHaveLength(0);
    expect(result.syncedFrom.getTime()).toBe(until.getTime());
  });

  it("reports lost coverage when stored messages are past storage retention", async () => {
    const { since, until } = syncWindow();
    const storedAt = new Date(since.getTime() + 60_000);
    const deliveredAt = new Date(since.getTime() + 120_000);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith(`${eventsUrl}?`)) {
        return jsonResponse({
          items: [
            storedItem("evt_stored_expired", storedAt),
            deliveredItem("evt_delivered_1", deliveredAt),
          ],
          paging: {},
        });
      }
      if (href === storageUrl) {
        return new Response("Message not found", { status: 404 });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const driver = MailgunDriver({ apiKey: "key-test" });
    const { events, result } = await drainSync(
      driver.sync!.domain!({ domain: "mg.example.com", since, until }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "delivered",
      data: { eventId: "evt_delivered_1" },
    });
    // The expired stored message could not be replayed, so the reported
    // coverage starts just after it instead of claiming the full window.
    expect(result.syncedFrom.getTime()).toBe(storedAt.getTime() + 1);
  });

  it("rejects the next page fetch when the sync is aborted", async () => {
    const { since, until } = syncWindow();
    const deliveredAt = new Date(since.getTime() + 60_000);
    const page2Url = `${eventsUrl}/page-2`;

    const fetchMock = vi.fn(
      async (_url: string | URL, init?: RequestInit) => {
        // Real fetch rejects when called with an already-aborted signal.
        if (init?.signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return jsonResponse({
          items: [deliveredItem("evt_delivered_1", deliveredAt)],
          paging: { next: page2Url },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const controller = new AbortController();
    const driver = MailgunDriver({ apiKey: "key-test" });
    const stream = driver.sync!.domain!({
      domain: "mg.example.com",
      since,
      until,
      signal: controller.signal,
    });

    const first = await stream.next();
    expect(first.done).toBe(false);
    controller.abort();

    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("dispatches replayed events through hooks via domains.sync", async () => {
    const { since, until } = syncWindow();
    const deliveredAt = new Date(since.getTime() + 60_000);
    const storedAt = new Date(since.getTime() + 120_000);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith(`${eventsUrl}?`)) {
        return jsonResponse({
          items: [
            deliveredItem("evt_delivered_1", deliveredAt),
            storedItem("evt_stored_1", storedAt),
          ],
          paging: {},
        });
      }
      if (href === storageUrl) {
        return jsonResponse(storedMessageJson);
      }
      throw new Error(`Unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onAll = vi.fn();
    const onInbound = vi.fn();
    const onDelivered = vi.fn();
    const client = EmailKit({
      emailDrivers: [MailgunDriver({ apiKey: "key-test" })],
      hooks: {
        email: { onAll, onInbound, onDelivered },
      },
    });

    const result = await client.domains.sync({
      domain: "mg.example.com",
      since,
      until,
      context: { runId: "replay-1" },
    });

    expect(result.dispatched).toBe(2);
    expect(result.syncedFrom.getTime()).toBe(since.getTime());
    expect(onDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt_delivered_1",
        messageId: "<sent@example.com>",
        status: "delivered",
      }),
    );
    expect(onInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        eventId: "evt_stored_1",
        messageId: "<stored@example.com>",
        subject: "Stored message",
      }),
    );
    expect(onAll).toHaveBeenCalledTimes(2);
    expect(onAll).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "delivered",
        context: { runId: "replay-1" },
      }),
    );
    expect(onAll).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "inbound",
        context: { runId: "replay-1" },
      }),
    );
  });

  it("resolves a domainId to the domain name for domains.sync", async () => {
    const { since, until } = syncWindow();
    const deliveredAt = new Date(since.getTime() + 60_000);

    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.startsWith("https://api.mailgun.net/v4/domains")) {
        return jsonResponse({
          items: [{ id: "dom_123", name: "mg.example.com", state: "active" }],
        });
      }
      if (href.startsWith(`${eventsUrl}?`)) {
        return jsonResponse({
          items: [deliveredItem("evt_delivered_1", deliveredAt)],
          paging: {},
        });
      }
      throw new Error(`Unexpected fetch ${href}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onDelivered = vi.fn();
    const client = EmailKit({
      emailDrivers: [MailgunDriver({ apiKey: "key-test" })],
      hooks: { email: { onDelivered } },
    });

    const result = await client.domains.sync({
      domainId: "dom_123",
      since,
      until,
    });

    expect(result.dispatched).toBe(1);
    expect(onDelivered).toHaveBeenCalledWith(
      expect.objectContaining({ eventId: "evt_delivered_1" }),
    );
    // The events API was queried by domain name, never by the provider id.
    const eventCalls = fetchMock.mock.calls
      .map(([url]) => String(url))
      .filter((href) => href.includes("/events"));
    expect(eventCalls).toHaveLength(1);
    expect(eventCalls[0]).toContain("/v3/mg.example.com/events");
  });

  it("throws NOT_FOUND when domains.sync gets an unknown domainId", async () => {
    const { since } = syncWindow();
    const fetchMock = vi.fn(async () => jsonResponse({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = EmailKit({
      emailDrivers: [MailgunDriver({ apiKey: "key-test" })],
    });

    await expect(
      client.domains.sync({ domainId: "dom_missing", since }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

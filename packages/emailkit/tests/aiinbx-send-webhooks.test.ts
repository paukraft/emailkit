import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AIInbxDriver, EmailKit, EmailKitError } from "../src";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const testAIInbxWebhookSecret = "aiinbx-webhook-secret";

const signAIInbxWebhookBody = (body: unknown, timestamp: string) =>
  `sha256=${createHmac("sha256", testAIInbxWebhookSecret)
    .update(`${timestamp}.${JSON.stringify(body)}`)
    .digest("hex")}`;

describe("AIInbxDriver sendEmail", () => {
  it("advertises the current reply and tracking capability model", () => {
    const driver = AIInbxDriver({ apiKey: "ai_test" });

    expect(driver.capabilities).toMatchObject({
      replyTo: true,
      replyHeaders: true,
      replyThreadId: true,
      sendTracking: {
        opens: true,
        clicks: true,
      },
      eventTracking: {
        opens: true,
        clicks: true,
      },
      providerFetch: true,
      customHeaders: false,
    });
    expect(driver.capabilities.senderAuth).toBeUndefined();
    expect(driver.capabilities.senderMailbox).toBeUndefined();
  });

  it("maps reply context, tracking overrides, and attachments to the OpenAPI shape", async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: string | URL) => {
      const url = input.toString();
      if (url === "https://files.example.com/report.txt") {
        return new Response("from-url", { status: 200 });
      }

      return new Response(
        JSON.stringify({
          emailId: "email_123",
          threadId: "thread_123",
          messageId: "<message-123@example.com>",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const driver = AIInbxDriver({
      id: "support-aiinbx",
      apiKey: "ai_test",
      apiBase: "https://api.example.com",
    });

    const result = await driver.sendEmail(
      {
        from: { email: "agent@example.com", name: "Agent" },
        to: [{ email: "buyer@example.net" }],
        cc: { email: "cc@example.net" },
        bcc: [{ email: "bcc@example.net" }],
        reply: {
          addresses: [{ email: "reply@example.com" }],
          messageId: "<original@example.net>",
          references: ["<root@example.net>", "<original@example.net>"],
          threadId: "thread_123",
        },
        subject: "Follow up",
        html: "<p>Hello</p>",
        text: "Hello",
        attachments: [
          {
            filename: "inline.txt",
            content: "inline",
            contentType: "text/plain",
            contentId: "cid-inline",
            isInline: true,
          },
          {
            filename: "report.txt",
            url: "https://files.example.com/report.txt",
            contentType: "text/plain",
          },
        ],
        track: {
          opens: false,
          clicks: true,
        },
      },
      { auth: { ignored: true } },
    );

    expect(result).toEqual({
      messageId: "<message-123@example.com>",
      provider: "support-aiinbx",
      providerId: "email_123",
      threadId: "thread_123",
    });

    const [sendUrl, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toBe("https://api.example.com/api/v1/emails/send");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer ai_test");

    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      from: "agent@example.com",
      from_name: "Agent",
      to: ["buyer@example.net"],
      cc: "cc@example.net",
      bcc: ["bcc@example.net"],
      reply_to: "reply@example.com",
      threadId: "thread_123",
      in_reply_to: "<original@example.net>",
      references: ["<root@example.net>", "<original@example.net>"],
      subject: "Follow up",
      html: "<p>Hello</p>",
      text: "Hello",
      track_opens: false,
      track_clicks: true,
    });
    expect(body.attachments).toEqual([
      {
        file_name: "inline.txt",
        content: "aW5saW5l",
        content_type: "text/plain",
        disposition: "inline",
        cid: "cid-inline",
      },
      {
        file_name: "report.txt",
        content: "ZnJvbS11cmw=",
        content_type: "text/plain",
        disposition: "attachment",
      },
    ]);
  });

  it("escapes text-only sends before using text as the required html body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          emailId: "email_123",
          messageId: "<message-123@example.com>",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = AIInbxDriver({
      apiKey: "ai_test",
      apiBase: "https://api.example.com",
    });

    await driver.sendEmail({
      from: { email: "agent@example.com" },
      to: { email: "buyer@example.net" },
      subject: "Escaped",
      text: "5 < 7 & \"safe\"\nnext line",
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.html).toBe(
      "5 &lt; 7 &amp; &quot;safe&quot;<br />next line",
    );
    expect(body.text).toBe("5 < 7 & \"safe\"\nnext line");
  });

  it("preserves normalized API failure details without wrapping twice", async () => {
    const errorBody = {
      message: "Invalid recipient",
      code: "invalid_recipient",
      details: { to: "not-an-email" },
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(errorBody), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = AIInbxDriver({
      apiKey: "ai_test",
      apiBase: "https://api.example.com",
    });

    let thrown: unknown;
    try {
      await driver.sendEmail({
        from: { email: "agent@example.com" },
        to: { email: "not-an-email" },
        subject: "Failure",
        html: "<p>Hello</p>",
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(EmailKitError);
    expect(thrown).toMatchObject({
      provider: "aiinbx",
      code: "invalid_recipient",
      httpStatus: 400,
      raw: errorBody,
    });
    expect((thrown as EmailKitError).cause).toBeUndefined();
    expect((thrown as Error).message).toContain("Invalid recipient");
  });

  it("rejects reply.isReply when no AIInbx reply identifier is provided", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const driver = AIInbxDriver({
      apiKey: "ai_test",
      apiBase: "https://api.example.com",
    });

    await expect(
      driver.sendEmail({
        from: { email: "agent@example.com" },
        to: { email: "buyer@example.net" },
        subject: "Reply",
        html: "<p>Hello</p>",
        reply: {
          isReply: true,
        },
      }),
    ).rejects.toThrow(/reply\.isReply alone/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects runtime custom headers and points callers to reply fields", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const driver = AIInbxDriver({
      apiKey: "ai_test",
      apiBase: "https://api.example.com",
    });

    await expect(
      driver.sendEmail({
        from: { email: "agent@example.com" },
        to: { email: "buyer@example.net" },
        subject: "Headers",
        html: "<p>Hello</p>",
        headers: {
          "In-Reply-To": "<original@example.net>",
        },
      } as Parameters<typeof driver.sendEmail>[0] & {
        headers: Record<string, string>;
      }),
    ).rejects.toThrow(/message\.reply\.messageId/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("AIInbxDriver webhooks", () => {
  it("rejects public AIInbx webhooks when no signing secret is configured", async () => {
    const onClicked = vi.fn();
    const client = EmailKit({
      emailDrivers: [AIInbxDriver({ apiKey: "ai_test" })],
      hooks: { email: { onClicked } },
    });

    const response = await client.handler()({
      method: "POST",
      headers: {},
      body: {
        event: "outbound.email.clicked",
        data: {
          emailId: "email_123",
          messageId: "<message-123@example.com>",
          clickedAt: "2026-04-02T10:00:00.000Z",
          link: "https://example.com/demo",
        },
        attempt: 1,
        timestamp: 1775124000,
      },
    });

    expect(response.status).toBe(401);
    expect(onClicked).not.toHaveBeenCalled();
  });

  it("fetches stored signed attachment URLs without AIInbx bearer auth", async () => {
    const signedUrl =
      "https://signed-bucket.s3.amazonaws.com/report.txt?X-Amz-Signature=abc";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("signed-content", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const onInbound = vi.fn();
    const driver = AIInbxDriver({
      id: "support-aiinbx",
      apiKey: "ai_test",
      webhookSecret: testAIInbxWebhookSecret,
      autoFetchInboundAttachments: false,
    });
    const client = EmailKit({
      emailDrivers: [driver],
      hooks: {
        email: {
          onInbound,
        },
      },
    });

    const body = {
      event: "inbound.email.received",
      data: {
        email: {
          id: "email_inbound_123",
          createdAt: "2026-04-02T10:00:00.000Z",
          messageId: "<inbound-123@example.com>",
          inReplyToId: null,
          references: [],
          subject: "Inbound",
          text: "Hello",
          html: null,
          strippedText: "Hello",
          strippedHtml: null,
          snippet: "Hello",
          fromName: null,
          fromAddress: "buyer@example.net",
          toAddresses: ["agent@example.com"],
          ccAddresses: [],
          bccAddresses: [],
          replyToAddresses: [],
          sentAt: null,
          receivedAt: "2026-04-02T10:00:00.000Z",
          direction: "INBOUND",
          status: "RECEIVED",
          threadId: "thread_123",
          attachments: [
            {
              id: "att_123",
              createdAt: "2026-04-02T10:00:00.000Z",
              fileName: "report.txt",
              contentType: "text/plain",
              sizeInBytes: 14,
              cid: null,
              disposition: "attachment",
              signedUrl,
              expiresAt: "2026-04-02T11:00:00.000Z",
            },
          ],
        },
        organization: {
          id: "org_123",
          slug: "org",
        },
      },
      attempt: 1,
      timestamp: 1775124000,
    };
    const timestamp = "1775124000";
    const response = await client.handler()({
      method: "POST",
      headers: {
        "x-aiinbx-timestamp": timestamp,
        "x-aiinbx-signature": signAIInbxWebhookBody(body, timestamp),
      },
      body,
    });

    expect(response.status).toBe(200);
    const inbound = onInbound.mock.calls[0][0];
    const content = await client.attachments.getContent(inbound.attachments[0]);
    expect(new TextDecoder().decode(content as Uint8Array)).toBe(
      "signed-content",
    );

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(signedUrl);
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("normalizes clicked webhooks for grouped EmailKit hooks", async () => {
    const onAll = vi.fn();
    const onClicked = vi.fn();
    const driver = AIInbxDriver({
      apiKey: "ai_test",
      webhookSecret: testAIInbxWebhookSecret,
    });
    const client = EmailKit({
      emailDrivers: [driver],
      hooks: {
        email: {
          onAll,
          onClicked,
        },
      },
    });

    const body = {
      event: "outbound.email.clicked",
      data: {
        emailId: "email_123",
        messageId: "<message-123@example.com>",
        clickedAt: "2026-04-02T10:00:00.000Z",
        link: "https://example.com/demo",
        linkDomain: "example.com",
        ipAddress: "203.0.113.10",
        userAgent: "Mozilla/5.0",
      },
      attempt: 1,
      timestamp: 1775124000,
    };
    const timestamp = "1775124000";
    const response = await client.handler()({
      method: "POST",
      headers: {
        "x-aiinbx-timestamp": timestamp,
        "x-aiinbx-signature": signAIInbxWebhookBody(body, timestamp),
      },
      body,
    });

    expect(response.status).toBe(200);
    expect(onAll).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "clicked",
        data: expect.objectContaining({
          status: "clicked",
          messageId: "<message-123@example.com>",
          providerId: "email_123",
          url: "https://example.com/demo",
          timestamp: new Date("2026-04-02T10:00:00.000Z"),
        }),
      }),
    );
    expect(onClicked).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "clicked",
        url: "https://example.com/demo",
        ip: "203.0.113.10",
        userAgent: "Mozilla/5.0",
      }),
    );
  });

  it("accepts the link_clicked event name from public webhook docs", async () => {
    const driver = AIInbxDriver({ apiKey: "ai_test" });
    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        event: "outbound.email.link_clicked",
        data: {
          messageId: "<message-123@example.com>",
          clickedAt: "2026-04-02T10:00:00.000Z",
          link: "https://example.com/demo",
        },
        attempt: 1,
        timestamp: 1775124000,
      },
    });

    expect(event).toMatchObject({
      type: "clicked",
      data: {
        status: "clicked",
        messageId: "<message-123@example.com>",
        providerId: "<message-123@example.com>",
        url: "https://example.com/demo",
      },
    });
  });
});

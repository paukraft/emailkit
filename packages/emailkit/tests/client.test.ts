import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { EmailKit, EmailKitError, EmailKitSyncError } from "../src";
import type {
  Domain,
  DomainOperationInput,
  DriverPublicRoutes,
  EmailDriver,
  EmailKitHooks,
  MailboxIdentity,
  OUTLOOK_CAPABILITIES,
  RESEND_CAPABILITIES,
  SendEmailResult,
} from "../src";

const originalEmailKitSecret = process.env.EMAILKIT_SECRET;
const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEmailKitSecret === undefined) {
    delete process.env.EMAILKIT_SECRET;
  } else {
    process.env.EMAILKIT_SECRET = originalEmailKitSecret;
  }
  if (originalPublicBaseUrl === undefined) {
    delete process.env.PUBLIC_BASE_URL;
  } else {
    process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
  }
});

const makeDomain = (overrides: Partial<Domain> = {}): Domain => ({
  id: "dom_123",
  domain: "mg.example.com",
  status: "pending",
  ...overrides,
});

const createTestClient = (overrides: Partial<EmailDriver<any, any>> = {}) => {
  const driver: EmailDriver<any, any> = {
    id: "test-provider",
    name: "test-provider",
    capabilities: {
      domains: {
        list: true,
        create: true,
        get: true,
        update: true,
        verify: true,
        delete: true,
        identifier: "domainId" as const,
      },
      providerFetch: true,
      senderAuth: true,
      senderMailbox: true,
    },
    sendEmail: vi.fn().mockResolvedValue({
      messageId: "msg_123",
      provider: "test-provider",
    }),
    handleWebhook: vi.fn().mockResolvedValue({
      type: "unknown",
      data: {},
    }),
    providerFetch: vi.fn(),
    domains: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      verify: vi.fn(),
      delete: vi.fn(),
    },
    ...overrides,
  };

  if (
    driver.capabilities.providerFetch !== true &&
    overrides.providerFetch === undefined
  ) {
    delete driver.providerFetch;
  }

  return {
    client: EmailKit({ emailDrivers: [driver] }),
    driver,
  };
};

const createDomainDriver = <const TId extends string>(
  id: TId,
  domains: Partial<NonNullable<EmailDriver["domains"]>>,
): EmailDriver<any, any, TId> => {
  const capabilities = {
    identifier: "both" as const,
    ...(domains.list ? { list: true as const } : {}),
    ...(domains.create ? { create: true as const } : {}),
    ...(domains.get ? { get: true as const } : {}),
    ...(domains.update ? { update: true as const } : {}),
    ...(domains.verify ? { verify: true as const } : {}),
    ...(domains.delete ? { delete: true as const } : {}),
  };

  return {
    id,
    name: id,
    capabilities: { domains: capabilities },
    sendEmail: vi
      .fn()
      .mockResolvedValue({ messageId: `msg_${id}`, provider: id }),
    handleWebhook: vi.fn().mockResolvedValue({ type: "unknown", data: {} }),
    domains,
  };
};

const createMailboxDriver = <const TId extends string>(
  id: TId,
  mailboxes: Partial<NonNullable<EmailDriver["mailboxes"]>>,
): EmailDriver<any, { mailboxGet: true; mailboxDelete: true }, TId> => ({
  id,
  name: id,
  capabilities: {
    mailboxGet: true,
    mailboxDelete: true,
  },
  sendEmail: vi
    .fn()
    .mockResolvedValue({ messageId: `msg_${id}`, provider: id }),
  handleWebhook: vi.fn().mockResolvedValue({ type: "unknown", data: {} }),
  mailboxes,
});

const createPlainDriver = <const TId extends string>(
  id: TId,
): EmailDriver<any, {}, TId> => ({
  id,
  name: id,
  capabilities: {},
  sendEmail: vi
    .fn()
    .mockResolvedValue({ messageId: `msg_${id}`, provider: id }),
  handleWebhook: vi.fn().mockResolvedValue({ type: "unknown", data: {} }),
});

describe("EmailKit client helpers", () => {
  it("types MailboxIdentity as id and/or email without auth", () => {
    expectTypeOf<{ id: string }>().toMatchTypeOf<MailboxIdentity>();
    expectTypeOf<{ email: string }>().toMatchTypeOf<MailboxIdentity>();
    expectTypeOf<{
      id: string;
      email: string;
    }>().toMatchTypeOf<MailboxIdentity>();
    expectTypeOf<{
      id: string;
      displayName: string;
    }>().toMatchTypeOf<MailboxIdentity>();
    expectTypeOf<{
      id: string;
      raw: unknown;
    }>().not.toMatchTypeOf<MailboxIdentity>();
    expectTypeOf<{}>().not.toMatchTypeOf<MailboxIdentity>();
    expectTypeOf<{ auth: unknown }>().not.toMatchTypeOf<MailboxIdentity>();
    expectTypeOf<{
      id: string;
      auth: unknown;
    }>().not.toMatchTypeOf<MailboxIdentity>();
  });

  it("allows sync hooks in EmailKitHooks", () => {
    const hooks: EmailKitHooks = {
      email: {
        onInbound: (event) => {
          expectTypeOf(event.subject).toEqualTypeOf<string>();
        },
      },
      mailbox: {
        onConnected: (event) => {
          expectTypeOf(event.emailDriver).toEqualTypeOf<string>();
        },
      },
      domain: {
        onCreated: (event) => {
          expectTypeOf(event.domain.domain).toEqualTypeOf<string>();
        },
      },
      webhook: {
        onAll: (event) => {
          expectTypeOf(event.emailDriver).toEqualTypeOf<string>();
        },
        onCreated: (event) => {
          expectTypeOf(event.action).toEqualTypeOf<"created">();
          expectTypeOf(event.webhook.id).toEqualTypeOf<string>();
        },
        onUpdated: (event) => {
          expectTypeOf(event.action).toEqualTypeOf<"updated">();
          expectTypeOf(event.reason).toEqualTypeOf<string>();
        },
        onDeleted: (event) => {
          expectTypeOf(event.action).toEqualTypeOf<"deleted">();
          expectTypeOf(event.recommendedActions).toEqualTypeOf<
            string[] | undefined
          >();
        },
      },
    };

    expect(hooks).toBeDefined();
  });

  it("narrows driver public routes by declared route capabilities", () => {
    const resendRoutes: DriverPublicRoutes<typeof RESEND_CAPABILITIES> = {
      webhookUrl: "https://app.example.com/api/email/resend",
    };
    const outlookRoutes: DriverPublicRoutes<typeof OUTLOOK_CAPABILITIES> = {
      webhookUrl: "https://app.example.com/api/email/outlook",
      lifecycleWebhookUrl: "https://app.example.com/api/email/outlook",
      connectCallbackUrl: "https://app.example.com/api/email/outlook",
      connectLandingUrl: "https://app.example.com/connected",
      connectFailureUrl: "https://app.example.com/failed",
    };

    if (false) {
      const badResendRoutes: DriverPublicRoutes<typeof RESEND_CAPABILITIES> = {
        webhookUrl: "https://app.example.com/api/email/resend",
        // @ts-expect-error Resend does not consume mailbox callback routes.
        connectCallbackUrl: "https://app.example.com/api/email/resend",
      };
      expect(badResendRoutes).toBeDefined();
    }

    expect(resendRoutes.webhookUrl).toContain("/resend");
    expect(outlookRoutes.connectCallbackUrl).toContain("/outlook");
  });

  it("narrows mailbox connect route inputs by selected driver", () => {
    const callbackDriver: EmailDriver<
      any,
      {
        mailboxConnect: true;
        publicRoutes: { connectCallback: true; connectLanding: true };
      },
      "oauth"
    > = {
      ...createPlainDriver("oauth"),
      capabilities: {
        mailboxConnect: true,
        publicRoutes: { connectCallback: true, connectLanding: true },
      },
      mailboxes: { connect: vi.fn() },
      handleCallback: vi.fn(),
    };
    const apiDriver: EmailDriver<any, { mailboxConnect: true }, "api"> = {
      ...createPlainDriver("api"),
      capabilities: { mailboxConnect: true },
      mailboxes: { connect: vi.fn() },
    };
    const client = EmailKit({
      emailDrivers: [callbackDriver, apiDriver],
      secret: "emailkit-secret",
      resolveEmailDriver: () => "api",
    });

    if (false) {
      client.mailboxes.connect("oauth", {
        callbackUrl: "https://app.example.com/api/email/oauth",
        landingUrl: "/connected",
      });
      client.mailboxes.connect("api", {
        email: "support@example.com",
        // @ts-expect-error API-style mailbox drivers do not consume callback routes.
        callbackUrl: "https://app.example.com/api/email/api",
      });
    }

    expect(client.mailboxes.connect).toBeTypeOf("function");
  });

  it("requires callback handlers to declare callback route support", () => {
    const driver: EmailDriver<any, { mailboxConnect: true }, "implicit-oauth"> =
      {
        ...createPlainDriver("implicit-oauth"),
        capabilities: { mailboxConnect: true },
        mailboxes: { connect: vi.fn() },
        handleCallback: vi.fn(),
      };

    expect(() =>
      EmailKit({
        emailDrivers: [driver],
        secret: "emailkit-secret",
      }),
    ).toThrow(/publicRoutes\.connectCallback/);
  });

  it("gates providerFetch by configured driver capabilities", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const fetchDriver: EmailDriver<
      any,
      { providerFetch: true },
      "fetch-driver"
    > = {
      ...createPlainDriver("fetch-driver"),
      capabilities: { providerFetch: true },
      providerFetch,
    };
    const plainDriver = createPlainDriver("plain-driver");
    const client = EmailKit({
      emailDrivers: [fetchDriver, plainDriver],
      resolveEmailDriver: () => "fetch-driver",
    });
    const plainClient = EmailKit({ emailDrivers: [plainDriver] });

    if (false) {
      await client.providerFetch("/v1/me", {
        emailDriver: "fetch-driver",
      });
      // @ts-expect-error providerFetch cannot select drivers that do not declare providerFetch.
      await client.providerFetch("/v1/me", { emailDriver: "plain-driver" });
      // @ts-expect-error providerFetch is absent without a supporting driver.
      await plainClient.providerFetch("/v1/me");
    }

    expect("providerFetch" in plainClient).toBe(false);
    await expect(client.providerFetch("/v1/me")).resolves.toBeInstanceOf(
      Response,
    );
    expect(providerFetch).toHaveBeenCalledWith("/v1/me", {});
  });

  it("validates providerFetch capabilities against implementation", () => {
    const declaredMissing: EmailDriver<
      any,
      { providerFetch: true },
      "declared-missing"
    > = {
      ...createPlainDriver("declared-missing"),
      capabilities: { providerFetch: true },
    };
    const implementedUndeclared: EmailDriver<any, {}, "implemented-missing"> = {
      ...createPlainDriver("implemented-missing"),
      capabilities: {},
      providerFetch: vi.fn(),
    };

    expect(() => EmailKit({ emailDrivers: [declaredMissing] })).toThrowError(
      /providerFetch is declared/,
    );
    expect(() =>
      EmailKit({ emailDrivers: [implementedUndeclared] }),
    ).toThrowError(/driver\.providerFetch is implemented/);
  });

  it("narrows send-only features by selected email driver", async () => {
    const scheduledDriver: EmailDriver<
      any,
      { scheduling: true; sendIdempotency: true },
      "scheduled"
    > = {
      ...createPlainDriver("scheduled"),
      capabilities: {
        scheduling: true,
        sendIdempotency: true,
      },
    };
    const plainDriver = createPlainDriver("plain");
    const client = EmailKit({
      emailDrivers: [scheduledDriver, plainDriver],
      resolveEmailDriver: () => "plain",
    });

    if (false) {
      await client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Core email",
        text: "Core fields work without selecting a driver",
      });

      await client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Scheduled email",
        text: "Driver-specific fields work when that driver is selected",
        sendAt: new Date(),
        idempotencyKey: "send_123",
        sender: { emailDriver: "scheduled" },
      });

      await client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Plain email",
        text: "Core fields still work for the plain driver",
        sender: { emailDriver: "plain" },
      });

      await client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Unsupported without explicit driver",
        text: "sendAt is not common to all configured drivers",
        // @ts-expect-error scheduling is only available after selecting the scheduled driver.
        sendAt: new Date(),
      });

      await client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Unsupported on plain driver",
        text: "The selected driver does not support scheduling",
        sender: { emailDriver: "plain" },
        // @ts-expect-error scheduling is not available on the selected plain driver.
        sendAt: new Date(),
      });

      await client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Unknown driver",
        text: "Unknown driver ids are rejected by the typed sender selector",
        // @ts-expect-error sender.emailDriver must be one of the configured driver ids.
        sender: { emailDriver: "other" },
      });
    }

    await expect(
      client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Core email",
        text: "Core fields work at runtime too",
      }),
    ).resolves.toEqual({ messageId: "msg_plain", provider: "plain" });
  });

  it("gates sender auth and mailbox overrides by selected driver capabilities", async () => {
    const authDriver: EmailDriver<
      any,
      { senderAuth: true; senderMailbox: true },
      "auth-driver"
    > = {
      ...createPlainDriver("auth-driver"),
      capabilities: { senderAuth: true, senderMailbox: true },
    };
    const plainDriver = createPlainDriver("plain-driver");
    const client = EmailKit({
      emailDrivers: [authDriver, plainDriver],
      resolveEmailDriver: () => "plain-driver",
    });

    if (false) {
      await client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "With sender auth",
        sender: {
          emailDriver: "auth-driver",
          auth: { accessToken: "access_123" },
          mailbox: { id: "mbx_123", email: "sender@example.com" },
        },
      });
      await client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Unsupported sender auth",
        sender: {
          emailDriver: "plain-driver",
          // @ts-expect-error sender.auth requires the selected driver to declare senderAuth.
          auth: { accessToken: "access_123" },
        },
      });
      await client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Unsupported sender mailbox",
        sender: {
          emailDriver: "plain-driver",
          // @ts-expect-error sender.mailbox requires the selected driver to declare senderMailbox.
          mailbox: { id: "mbx_123", email: "sender@example.com" },
        },
      });
    }

    await expect(
      client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Runtime unsupported sender auth",
        sender: {
          emailDriver: "plain-driver",
          auth: { accessToken: "access_123" },
        },
      } as any),
    ).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });
  });

  it("strips unsupported EmailKit send fields before calling the driver", async () => {
    const sendEmail = vi.fn().mockResolvedValue({
      messageId: "msg_123",
      provider: "test-provider",
    });
    const { client } = createTestClient({
      capabilities: {},
      sendEmail,
    });
    const sendAt = new Date("2026-01-01T00:00:00.000Z");

    await client.sendEmail({
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Unsupported fields",
      text: "Plain text",
      html: "<p>HTML</p>",
      cc: { email: "cc@example.com" },
      bcc: { email: "bcc@example.com" },
      reply: {
        addresses: [{ email: "reply@example.com" }],
        messageId: "<previous@example.com>",
        references: ["<root@example.com>", "<previous@example.com>"],
        threadId: "thread_123",
        isReply: true,
      },
      attachments: [{ filename: "test.txt", content: "hello" }],
      headers: { "X-Test": "true" },
      tags: ["welcome"],
      metadata: { tenant: "acme" },
      templateId: "tmpl_123",
      templateData: { firstName: "Ada" },
      personalizations: [
        {
          to: { email: "recipient@example.com" },
          substitutions: { firstName: "Ada" },
        },
      ],
      sendAt,
      unsubscribe: { global: true },
      track: { opens: true, clicks: true },
      sandbox: true,
      idempotencyKey: "send_123",
      tenantId: "tenant_123",
      provider: { raw: true },
    } as any);

    expect(sendEmail.mock.calls[0]![0]).toEqual({
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Unsupported fields",
      text: "Plain text",
      html: "<p>HTML</p>",
      provider: { raw: true },
    });
  });

  it("keeps supported reply subfields and drops unsupported reply subfields", async () => {
    const sendEmail = vi.fn().mockResolvedValue({
      messageId: "msg_123",
      provider: "test-provider",
    });
    const { client } = createTestClient({
      capabilities: {
        replyTo: true,
        replyHeaders: true,
      },
      sendEmail,
    });

    await client.sendEmail({
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Partial reply",
      reply: {
        addresses: [{ email: "reply@example.com" }],
        messageId: "<previous@example.com>",
        references: ["<root@example.com>", "<previous@example.com>"],
        threadId: "thread_123",
        isReply: true,
      },
    } as any);

    expect(sendEmail.mock.calls[0]![0]).toEqual({
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Partial reply",
      reply: {
        addresses: [{ email: "reply@example.com" }],
        messageId: "<previous@example.com>",
        references: ["<root@example.com>", "<previous@example.com>"],
        isReply: true,
      },
    });
  });

  it("keeps reply.messageId and reply.isReply for nativeReplyThreading drivers", async () => {
    const sendEmail = vi.fn().mockResolvedValue({
      messageId: "msg_123",
      provider: "test-provider",
    });
    const { client } = createTestClient({
      capabilities: {
        replyTo: true,
        nativeReplyThreading: true,
      },
      sendEmail,
    });

    await client.sendEmail({
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Native reply",
      reply: {
        addresses: [{ email: "reply@example.com" }],
        messageId: "<previous@example.com>",
        references: ["<root@example.com>", "<previous@example.com>"],
        threadId: "thread_123",
        isReply: true,
      },
    } as any);

    expect(sendEmail.mock.calls[0]![0]).toEqual({
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Native reply",
      reply: {
        addresses: [{ email: "reply@example.com" }],
        messageId: "<previous@example.com>",
        isReply: true,
      },
    });
  });

  it("keeps supported track subfields and drops unsupported track subfields", async () => {
    const sendTrackingSendEmail = vi.fn().mockResolvedValue({
      messageId: "msg_123",
      provider: "test-provider",
    });
    const sendTrackingClient = createTestClient({
      capabilities: {
        sendTracking: { opens: true },
      },
      sendEmail: sendTrackingSendEmail,
    }).client;

    await sendTrackingClient.sendEmail({
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Partial tracking",
      track: { opens: false, clicks: true },
    } as any);

    expect(sendTrackingSendEmail.mock.calls[0]![0]).toEqual({
      from: { email: "sender@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Partial tracking",
      track: { opens: false },
    });
  });

  it("separates send-time tracking controls from tracking events", async () => {
    const eventOnlyDriver: EmailDriver<
      any,
      {
        eventTracking: { opens: true; clicks: true };
        webhooks: { account: { setup: true } };
      },
      "event-only"
    > = {
      ...createPlainDriver("event-only"),
      capabilities: {
        eventTracking: { opens: true, clicks: true },
        webhooks: { account: { setup: true } },
      },
      webhooks: { account: { setup: vi.fn() } },
    };
    const trackingControlDriver: EmailDriver<
      any,
      { sendTracking: { opens: true; clicks: true } },
      "tracking-controls"
    > = {
      ...createPlainDriver("tracking-controls"),
      capabilities: {
        sendTracking: { opens: true, clicks: true },
      },
    };
    const eventOnlyClient = EmailKit({ emailDrivers: [eventOnlyDriver] });
    const trackingControlClient = EmailKit({
      emailDrivers: [trackingControlDriver],
    });

    if (false) {
      await trackingControlClient.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Send tracking controls",
        track: { opens: true, clicks: false },
      });

      await eventOnlyClient.webhooks.setup({
        url: "https://example.com/webhooks/email",
        events: ["email.opened", "email.clicked"],
      });

      await eventOnlyClient.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Event tracking does not imply send controls",
        // @ts-expect-error eventTracking allows opened/clicked webhooks, not message.track controls.
        track: { opens: true },
      });
    }

    await expect(
      eventOnlyClient.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Event tracking only",
      }),
    ).resolves.toEqual({ messageId: "msg_event-only", provider: "event-only" });
  });

  it("separates reply-to addresses, RFC reply headers, and native thread ids", () => {
    const rfcReplyDriver: EmailDriver<
      any,
      { replyTo: true; replyHeaders: true },
      "rfc-reply"
    > = {
      ...createPlainDriver("rfc-reply"),
      capabilities: {
        replyTo: true,
        replyHeaders: true,
      },
    };
    const nativeThreadDriver: EmailDriver<
      any,
      { replyThreadId: true },
      "native-thread"
    > = {
      ...createPlainDriver("native-thread"),
      capabilities: {
        replyThreadId: true,
      },
    };
    const rfcReplyClient = EmailKit({ emailDrivers: [rfcReplyDriver] });
    const nativeThreadClient = EmailKit({ emailDrivers: [nativeThreadDriver] });

    if (false) {
      rfcReplyClient.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "RFC reply",
        reply: {
          addresses: [{ email: "reply@example.com" }],
          messageId: "<previous@example.com>",
          references: ["<root@example.com>", "<previous@example.com>"],
        },
      });

      rfcReplyClient.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "RFC reply only",
        reply: {
          messageId: "<previous@example.com>",
          // @ts-expect-error RFC reply headers do not expose provider-native thread ids.
          threadId: "thread_123",
        },
      });

      rfcReplyClient.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "RFC reply only",
        reply: {
          references: ["<previous@example.com>"],
          // @ts-expect-error RFC reply headers do not expose provider-native reply flags.
          isReply: true,
        },
      });

      nativeThreadClient.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Native thread",
        reply: {
          threadId: "thread_123",
          isReply: true,
        },
      });
    }
  });

  it("allows string and key-value tags while keeping metadata as string values", () => {
    const taggedDriver: EmailDriver<
      any,
      { tags: true; metadata: true },
      "tags"
    > = {
      ...createPlainDriver("tags"),
      capabilities: {
        tags: true,
        metadata: true,
      },
    };
    const client = EmailKit({ emailDrivers: [taggedDriver] });

    if (false) {
      client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Normalized tags",
        tags: ["welcome", { name: "tenant", value: "acme" }],
        metadata: { plan: "pro" },
      });

      client.sendEmail({
        from: { email: "sender@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Metadata values stay strings",
        tags: [{ name: "tenant", value: "acme" }],
        metadata: {
          // @ts-expect-error metadata values must remain strings.
          plan: 123,
        },
      });
    }
  });

  it("types send results with optional native thread ids", () => {
    expectTypeOf<SendEmailResult>().toMatchTypeOf<{
      messageId: string;
      provider: string;
      threadId?: string;
    }>();
  });

  it("dispatches auth updates using explicit sender mailbox identity", async () => {
    const onAuthUpdated = vi.fn();
    const mailbox = {
      id: "mbx_123",
      email: "support@example.com",
      displayName: "Support",
    };
    const refreshedAuth = { accessToken: "access_new" };
    const sendEmail = vi.fn(async (_message, options) => {
      await options?.onAuthUpdated?.({ auth: refreshedAuth });
      return { messageId: "msg_123", provider: "test-provider" };
    });
    const { driver } = createTestClient({ sendEmail });

    const configured = EmailKit({
      emailDrivers: [driver],
      hooks: { mailbox: { onAuthUpdated } },
    });

    await configured.sendEmail({
      from: { email: "support@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Hello",
      text: "Hello",
      sender: {
        emailDriver: "test-provider",
        mailbox,
        context: { tenantId: "tenant_123" },
      },
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        mailbox,
        context: { tenantId: "tenant_123" },
      }),
    );
    expect(onAuthUpdated).toHaveBeenCalledWith({
      emailDriver: "test-provider",
      mailbox,
      auth: refreshedAuth,
      context: { tenantId: "tenant_123" },
    });
  });

  it("passes sender auth separately from mailbox identity", async () => {
    const auth = { accessToken: "mailbox_access" };
    const sendEmail = vi.fn().mockResolvedValue({
      messageId: "msg_123",
      provider: "test-provider",
    });
    const { client } = createTestClient({ sendEmail });

    await client.sendEmail({
      from: { email: "support@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Hello",
      text: "Hello",
      sender: {
        emailDriver: "test-provider",
        auth,
        mailbox: {
          id: "mbx_123",
          email: "support@example.com",
        },
      },
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ auth }),
    );
    expect(sendEmail.mock.calls[0]![1].mailbox).toEqual({
      id: "mbx_123",
      email: "support@example.com",
    });
  });

  it("rejects sender mailbox objects that carry auth", async () => {
    const { client } = createTestClient();

    await expect(
      client.sendEmail({
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        text: "Hello",
        sender: {
          emailDriver: "test-provider",
          mailbox: {
            id: "mbx_123",
            email: "support@example.com",
            auth: { accessToken: "wrong-place" },
          } as any,
        },
      }),
    ).rejects.toMatchObject({
      provider: "test-provider",
      code: "INVALID_INPUT",
      message:
        "Mailbox auth must be passed as top-level auth, not mailbox.auth",
    });
  });

  it("uses resolver mailbox auth and context for auth update hooks", async () => {
    const onAuthUpdated = vi.fn();
    const resolvedAuth = { accessToken: "resolved_access" };
    const refreshedAuth = { accessToken: "refreshed_access" };
    const sendEmail = vi.fn(async (_message, options) => {
      await options?.onAuthUpdated?.({ auth: refreshedAuth });
      return { messageId: "msg_123", provider: "test-provider" };
    });
    const { driver } = createTestClient({ sendEmail });

    const client = EmailKit({
      emailDrivers: [driver],
      resolveEmailDriver: () => ({
        emailDriver: "test-provider",
        auth: resolvedAuth,
        mailbox: {
          id: "mbx_123",
          email: "support@example.com",
        },
        context: { tenantId: "tenant_123" },
      }),
      hooks: { mailbox: { onAuthUpdated } },
    });

    await client.sendEmail({
      from: { email: "support@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Hello",
      text: "Hello",
    });

    expect(sendEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ auth: resolvedAuth }),
    );
    expect(onAuthUpdated).toHaveBeenCalledWith({
      emailDriver: "test-provider",
      mailbox: { id: "mbx_123", email: "support@example.com" },
      auth: refreshedAuth,
      context: { tenantId: "tenant_123" },
    });
  });

  it("prefers driver-reported mailbox identity over operation mailbox", async () => {
    const onAuthUpdated = vi.fn();
    const refreshedAuth = { accessToken: "refreshed_access" };
    const sendEmail = vi.fn(async (_message, options) => {
      await options?.onAuthUpdated?.({
        auth: refreshedAuth,
        mailbox: {
          email: "reported@example.com",
        },
      });
      return { messageId: "msg_123", provider: "test-provider" };
    });
    const { driver } = createTestClient({ sendEmail });

    const configured = EmailKit({
      emailDrivers: [driver],
      hooks: { mailbox: { onAuthUpdated } },
    });

    await configured.sendEmail({
      from: { email: "support@example.com" },
      to: { email: "recipient@example.com" },
      subject: "Hello",
      text: "Hello",
      sender: {
        emailDriver: "test-provider",
        mailbox: { id: "operation_mbx", email: "operation@example.com" },
      },
    });

    expect(onAuthUpdated).toHaveBeenCalledWith({
      emailDriver: "test-provider",
      mailbox: { email: "reported@example.com" },
      auth: refreshedAuth,
    });
  });

  it("rejects sends when auth update hook rejects", async () => {
    const hookError = new Error("persist failed");
    const sendEmail = vi.fn(async (_message, options) => {
      await options?.onAuthUpdated?.({ auth: { accessToken: "new" } });
      return { messageId: "msg_123", provider: "test-provider" };
    });
    const { driver } = createTestClient({ sendEmail });
    const client = EmailKit({
      emailDrivers: [driver],
      hooks: {
        mailbox: {
          onAuthUpdated: vi.fn().mockRejectedValue(hookError),
        },
      },
    });

    await expect(
      client.sendEmail({
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        text: "Hello",
        sender: {
          emailDriver: "test-provider",
          mailbox: { id: "mbx_123", email: "support@example.com" },
        },
      }),
    ).rejects.toThrow("persist failed");
  });

  it("rejects driver auth updates without a safe mailbox identity when a hook is configured", async () => {
    const onAuthUpdated = vi.fn();
    const sendEmail = vi.fn(async (_message, options) => {
      await options?.onAuthUpdated?.({ auth: { accessToken: "new" } });
      return { messageId: "msg_123", provider: "test-provider" };
    });
    const { driver } = createTestClient({ sendEmail });
    const client = EmailKit({
      emailDrivers: [driver],
      hooks: { mailbox: { onAuthUpdated } },
    });

    await expect(
      client.sendEmail({
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        text: "Hello",
      }),
    ).rejects.toMatchObject({
      code: "MISSING_MAILBOX_IDENTITY",
    });
    expect(onAuthUpdated).not.toHaveBeenCalled();
  });

  it("resolves domain names for providers that prefer domain ids", async () => {
    const domain = makeDomain();
    const { client, driver } = createTestClient({
      domains: {
        list: vi.fn().mockResolvedValue([domain]),
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(domain),
        update: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
      },
    });

    const result = await client.domains.get({ domain: domain.domain });

    expect(result).toEqual(domain);
    expect(driver.domains!.list).toHaveBeenCalledTimes(1);
    expect(driver.domains!.get).toHaveBeenCalledWith(domain.id);
  });

  it("returns null instead of throwing for missing domains", async () => {
    const { client, driver } = createTestClient({
      domains: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
      },
    });

    const result = await client.domains.getOrNull({
      domain: "missing.example.com",
    });

    expect(result).toBeNull();
    expect(driver.domains!.get).not.toHaveBeenCalled();
  });

  it("reuses existing domains in ensure()", async () => {
    const domain = makeDomain();
    const { client, driver } = createTestClient({
      domains: {
        list: vi.fn().mockResolvedValue([domain]),
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(domain),
        update: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
      },
    });

    const result = await client.domains.ensure({ domain: domain.domain });

    expect(result).toEqual({ domain, created: false });
    expect(driver.domains!.create).not.toHaveBeenCalled();
  });

  it("hydrates newly created domains in ensure()", async () => {
    const created = makeDomain({ verification: undefined });
    const hydrated = makeDomain({
      verification: {
        status: "pending",
        records: [],
      },
    });

    const { client, driver } = createTestClient({
      domains: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(created),
        get: vi.fn().mockResolvedValue(hydrated),
        update: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
      },
    });

    const result = await client.domains.ensure({ domain: created.domain });

    expect(result).toEqual({ domain: hydrated, created: true });
    expect(driver.domains!.create).toHaveBeenCalledWith({
      domain: created.domain,
    });
    expect(driver.domains!.get).toHaveBeenCalledWith(created.id);
  });

  it("recovers from create races by returning the existing domain", async () => {
    const domain = makeDomain();
    const conflict = new EmailKitError(
      "Domain already exists",
      "test-provider",
      undefined,
      409,
    );

    const { client } = createTestClient({
      domains: {
        list: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([domain]),
        create: vi.fn().mockRejectedValue(conflict),
        get: vi.fn().mockResolvedValue(domain),
        update: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
      },
    });

    const result = await client.domains.ensure({ domain: domain.domain });

    expect(result).toEqual({ domain, created: false });
  });

  it("gates domain methods with method-level domain capabilities", async () => {
    const domain = makeDomain();
    const driver: EmailDriver<
      any,
      { domains: { get: true; identifier: "both" } },
      "get-only"
    > = {
      ...createPlainDriver("get-only"),
      capabilities: {
        domains: {
          get: true,
          identifier: "both",
        },
      },
      domains: {
        get: vi.fn().mockResolvedValue(domain),
      },
    };

    const client = EmailKit({ emailDrivers: [driver] });

    if (false) {
      await client.domains.get({ domain: "mg.example.com" });
      // @ts-expect-error create is absent when the driver only advertises domains.get.
      await client.domains.create({ domain: "mg.example.com" });
      // @ts-expect-error ensure is absent without list + create + get support.
      await client.domains.ensure({ domain: "mg.example.com" });
      // @ts-expect-error verify is absent when the driver only advertises domains.get.
      await client.domains.verify({ domain: "mg.example.com" });
    }

    await expect(
      client.domains.get({ domain: "mg.example.com" }),
    ).resolves.toEqual(domain);
    await expect(
      (client.domains as any).create({ domain: "mg.example.com" }),
    ).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
    });
  });

  it("validates object domain capabilities against implemented methods", () => {
    const driver: EmailDriver<
      any,
      { domains: { update: true; identifier: "both" } },
      "invalid-domain-driver"
    > = {
      ...createPlainDriver("invalid-domain-driver"),
      capabilities: {
        domains: {
          update: true,
          identifier: "both",
        },
      },
      domains: {},
    };

    expect(() => EmailKit({ emailDrivers: [driver] })).toThrowError(
      /domains\.update is declared/,
    );
  });

  it("uses DomainOperationInput context for domain resolver and delete hooks", async () => {
    expectTypeOf<{
      domain: string;
      context: { tenantId: string };
    }>().toMatchTypeOf<DomainOperationInput>();

    const domain = makeDomain({ status: "verified" });
    const onDeleted = vi.fn();
    const primary = createDomainDriver("primary", {
      get: vi.fn().mockResolvedValue(domain),
      delete: vi.fn().mockResolvedValue({ deleted: true }),
    });
    const secondary = createDomainDriver("secondary", {
      get: vi.fn().mockResolvedValue(domain),
      delete: vi.fn().mockResolvedValue({ deleted: true }),
    });
    const resolveEmailDriver = vi.fn(({ operation, input }) => {
      expect(operation).toBe("domains.remove");
      expect(input).toMatchObject({
        domain: "mg.example.com",
        context: { tenantId: "tenant_123" },
      });
      return "secondary";
    });

    const client = EmailKit({
      emailDrivers: [primary, secondary],
      resolveEmailDriver,
      hooks: { domain: { onDeleted } },
    });

    await expect(
      client.domains.remove({
        domain: "mg.example.com",
        context: { tenantId: "tenant_123" },
      }),
    ).resolves.toEqual({ deleted: true });

    expect(resolveEmailDriver).toHaveBeenCalledTimes(1);
    expect(primary.domains!.delete).not.toHaveBeenCalled();
    expect(secondary.domains!.delete).toHaveBeenCalledWith("mg.example.com");
    expect(onDeleted).toHaveBeenCalledWith({
      emailDriver: "secondary",
      domain,
      context: { tenantId: "tenant_123" },
    });
  });

  it("returns inline attachment content without fetching", async () => {
    const { client, driver } = createTestClient();
    const content = new Uint8Array([1, 2, 3]);

    const result = await client.attachments.getContent({
      filename: "invoice.pdf",
      content,
    });

    expect(result).toBe(content);
    expect(driver.providerFetch).not.toHaveBeenCalled();
  });

  it("fetches stored attachment content through providerFetch", async () => {
    const providerFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([4, 5, 6]), { status: 200 }),
      );
    const { client } = createTestClient({ providerFetch });

    const result = await client.attachments.getContent({
      filename: "invoice.pdf",
      url: "https://files.example.com/invoice.pdf",
    });

    expect(Array.from(result as Uint8Array)).toEqual([4, 5, 6]);
    expect(providerFetch).toHaveBeenCalledWith(
      "https://files.example.com/invoice.pdf",
      undefined,
    );
  });

  it("self-routes stored attachments by attachment emailDriver", async () => {
    const resendFetch = vi.fn();
    const mailgunFetch = vi
      .fn()
      .mockResolvedValue(
        new Response(new Uint8Array([7, 8, 9]), { status: 200 }),
      );
    const resolveEmailDriver = vi.fn().mockReturnValue("resend");
    const resend = {
      ...createPlainDriver("resend"),
      capabilities: { providerFetch: true },
      providerFetch: resendFetch,
    };
    const mailgun = {
      ...createPlainDriver("mailgun"),
      capabilities: { providerFetch: true },
      providerFetch: mailgunFetch,
    };
    const client = EmailKit({
      emailDrivers: [resend, mailgun],
      resolveEmailDriver,
    });

    const result = await client.attachments.getContent({
      filename: "invoice.pdf",
      url: "https://files.example.com/invoice.pdf",
      emailDriver: "mailgun",
    });

    expect(Array.from(result as Uint8Array)).toEqual([7, 8, 9]);
    expect(mailgunFetch).toHaveBeenCalledWith(
      "https://files.example.com/invoice.pdf",
      undefined,
    );
    expect(resendFetch).not.toHaveBeenCalled();
    expect(resolveEmailDriver).not.toHaveBeenCalled();
  });

  it("rejects conflicting explicit attachment emailDriver", async () => {
    const resendFetch = vi.fn();
    const mailgunFetch = vi.fn();
    const resend = {
      ...createPlainDriver("resend"),
      capabilities: { providerFetch: true },
      providerFetch: resendFetch,
    };
    const mailgun = {
      ...createPlainDriver("mailgun"),
      capabilities: { providerFetch: true },
      providerFetch: mailgunFetch,
    };
    const resolveEmailDriver = vi.fn().mockReturnValue("resend");
    const client = EmailKit({
      emailDrivers: [resend, mailgun],
      resolveEmailDriver,
    });

    await expect(
      client.attachments.getContent(
        {
          filename: "invoice.pdf",
          url: "https://files.example.com/invoice.pdf",
          emailDriver: "mailgun",
        },
        { emailDriver: "resend" },
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });

    expect(resendFetch).not.toHaveBeenCalled();
    expect(mailgunFetch).not.toHaveBeenCalled();
    expect(resolveEmailDriver).not.toHaveBeenCalled();
  });

  it("uses resolveEmailDriver for unstamped stored attachments", async () => {
    const mailgunFetch = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }));
    const resolveEmailDriver = vi.fn().mockReturnValue("mailgun");
    const client = EmailKit({
      emailDrivers: [
        {
          ...createPlainDriver("resend"),
          capabilities: { providerFetch: true },
          providerFetch: vi.fn(),
        },
        {
          ...createPlainDriver("mailgun"),
          capabilities: { providerFetch: true },
          providerFetch: mailgunFetch,
        },
      ],
      resolveEmailDriver,
    });

    await client.attachments.getContent({
      filename: "invoice.pdf",
      url: "https://files.example.com/invoice.pdf",
    });

    expect(resolveEmailDriver).toHaveBeenCalledWith({
      operation: "providerFetch",
      path: "https://files.example.com/invoice.pdf",
      init: undefined,
    });
    expect(mailgunFetch).toHaveBeenCalledWith(
      "https://files.example.com/invoice.pdf",
      undefined,
    );
  });

  it("stamps inbound attachments with the handling emailDriver", async () => {
    const onInbound = vi.fn();
    const driver: EmailDriver = {
      id: "mailgun",
      capabilities: {},
      sendEmail: vi.fn(),
      handleWebhook: vi.fn().mockResolvedValue({
        type: "inbound",
        data: {
          messageId: "msg_123",
          from: { email: "sender@example.com" },
          to: [{ email: "recipient@example.com" }],
          reply: {},
          subject: "Hello",
          attachments: [
            {
              filename: "invoice.pdf",
              url: "https://files.example.com/invoice.pdf",
            },
          ],
          headers: {},
          timestamp: new Date("2026-05-21T00:00:00.000Z"),
        },
      }),
    };
    const client = EmailKit({
      emailDrivers: [driver],
      hooks: { email: { onInbound } },
    });

    await client.handler()({
      method: "POST",
      headers: {},
      query: {},
      body: {},
    });

    expect(onInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        emailDriver: "mailgun",
        attachments: [
          expect.objectContaining({
            filename: "invoice.pdf",
            emailDriver: "mailgun",
          }),
        ],
      }),
    );
  });

  it("uses resolveEmailDriver for ambiguous domain helpers", async () => {
    const resendDomain = makeDomain({
      id: "resend-domain",
      domain: "example.com",
    });
    const agentmailDomain = makeDomain({
      id: "agentmail-domain",
      domain: "customer.com",
    });
    const resend = createDomainDriver("resend", {
      get: vi.fn().mockResolvedValue(resendDomain),
    });
    const agentmail = createDomainDriver("agentmail", {
      get: vi.fn().mockResolvedValue(agentmailDomain),
    });

    const client = EmailKit({
      emailDrivers: [resend, agentmail],
      resolveEmailDriver: ({ operation, input }) => {
        expect(operation).toBe("domains.get");
        return "agentmail";
      },
    });

    const result = await client.domains.get({ domain: "customer.com" });

    expect(result).toEqual(agentmailDomain);
    expect(resend.domains!.get).not.toHaveBeenCalled();
    expect(agentmail.domains!.get).toHaveBeenCalledWith("customer.com");
  });

  it("uses resolveEmailDriver for ambiguous mailbox helpers", async () => {
    const mailbox = {
      id: "mbx_123",
      email: "support@customer.com",
      status: "connected" as const,
    };
    const first = createMailboxDriver("agentmail-primary", {
      get: vi.fn(),
      delete: vi.fn(),
    });
    const second = createMailboxDriver("agentmail-support", {
      get: vi.fn().mockResolvedValue(mailbox),
      delete: vi.fn(),
    });

    const client = EmailKit({
      emailDrivers: [first, second],
      resolveEmailDriver: ({ operation, input }) => {
        expect(operation).toBe("mailboxes.get");
        expect(input.idOrEmail).toBe(mailbox.email);
        return "agentmail-support";
      },
    });

    const result = await client.mailboxes.get({ idOrEmail: mailbox.email });

    expect(result).toEqual(mailbox);
    expect(first.mailboxes!.get).not.toHaveBeenCalled();
    expect(second.mailboxes!.get).toHaveBeenCalledWith(
      mailbox.email,
      expect.objectContaining({
        onAuthUpdated: expect.any(Function),
      }),
    );
  });

  it("gates mailbox methods by method-level mailbox capabilities", async () => {
    const mailbox = {
      id: "mbx_123",
      email: "support@example.com",
      status: "connected" as const,
    };
    const getOnly = createMailboxDriver("get-only", {
      get: vi.fn().mockResolvedValue(mailbox),
      delete: vi.fn(),
    });
    const connectOnly: EmailDriver<
      any,
      { mailboxConnect: true },
      "connect-only"
    > = {
      ...createPlainDriver("connect-only"),
      capabilities: { mailboxConnect: true },
      mailboxes: {
        connect: vi.fn().mockResolvedValue({
          redirectUrl: "https://auth.example.com/start",
        }),
      },
    };

    const client = EmailKit({
      emailDrivers: [getOnly, connectOnly],
      secret: "emailkit-secret",
      resolveEmailDriver: ({ operation }) =>
        operation === "mailboxes.connect" ? "connect-only" : "get-only",
    });

    if (false) {
      await client.mailboxes.get({
        emailDriver: "get-only",
        idOrEmail: mailbox.email,
      });
      await client.mailboxes.connect("connect-only", {
        email: mailbox.email,
      });

      // @ts-expect-error get is not available on the connect-only driver.
      await client.mailboxes.get({
        emailDriver: "connect-only",
        idOrEmail: mailbox.email,
      });
      // @ts-expect-error connect is not available on the get-only driver.
      await client.mailboxes.connect("get-only", {
        email: mailbox.email,
      });
      // @ts-expect-error create is absent when no configured driver supports mailboxCreate.
      await client.mailboxes.create({ email: mailbox.email });
      // @ts-expect-error list is absent when no configured driver supports mailboxList.
      await client.mailboxes.list();
    }

    await expect(
      client.mailboxes.get({
        emailDriver: "get-only",
        idOrEmail: mailbox.email,
      }),
    ).resolves.toEqual(mailbox);
    await expect(
      client.mailboxes.connect("connect-only", { email: mailbox.email }),
    ).resolves.toEqual({ redirectUrl: "https://auth.example.com/start" });
  });

  it("validates mailbox capabilities against implemented methods", () => {
    const declaredMissing: EmailDriver<
      any,
      { mailboxGet: true },
      "declared-missing"
    > = {
      ...createPlainDriver("declared-missing"),
      capabilities: { mailboxGet: true },
      mailboxes: {},
    };
    const implementedUndeclared: EmailDriver<any, {}, "implemented-missing"> = {
      ...createPlainDriver("implemented-missing"),
      capabilities: {},
      mailboxes: {
        get: vi.fn(),
      },
    };

    expect(() => EmailKit({ emailDrivers: [declaredMissing] })).toThrowError(
      /mailboxGet is declared/,
    );
    expect(() =>
      EmailKit({ emailDrivers: [implementedUndeclared] }),
    ).toThrowError(/driver\.mailboxes\.get is implemented/);
  });

  it("passes EmailKit secrets to mailbox connect drivers", async () => {
    const connect = vi.fn().mockResolvedValue({
      redirectUrl: "https://auth.example.com/start",
      state: "signed-state",
    });
    const driver: EmailDriver<any, { mailboxConnect: true }, "gmail"> = {
      id: "gmail",
      name: "gmail",
      capabilities: { mailboxConnect: true },
      sendEmail: vi.fn(),
      handleWebhook: vi.fn(),
      mailboxes: { connect },
    };

    const client = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
    });

    await client.mailboxes.connect({ email: "support@example.com" });

    expect(connect).toHaveBeenCalledWith(
      { email: "support@example.com" },
      expect.objectContaining({
        secret: "emailkit-secret",
        onAuthUpdated: expect.any(Function),
      }),
    );
  });

  it("falls back to EMAILKIT_SECRET for mailbox connect drivers", async () => {
    process.env.EMAILKIT_SECRET = "env-emailkit-secret";
    const connect = vi.fn().mockResolvedValue({
      redirectUrl: "https://auth.example.com/start",
      state: "signed-state",
    });
    const driver: EmailDriver<any, { mailboxConnect: true }, "gmail"> = {
      id: "gmail",
      name: "gmail",
      capabilities: { mailboxConnect: true },
      sendEmail: vi.fn(),
      handleWebhook: vi.fn(),
      mailboxes: { connect },
    };

    const client = EmailKit({
      emailDrivers: [driver],
    });

    await client.mailboxes.connect({ email: "support@example.com" });

    expect(connect).toHaveBeenCalledWith(
      { email: "support@example.com" },
      expect.objectContaining({
        secret: "env-emailkit-secret",
        onAuthUpdated: expect.any(Function),
      }),
    );
  });

  it("prefers explicit EmailKit secrets over EMAILKIT_SECRET", async () => {
    process.env.EMAILKIT_SECRET = "env-emailkit-secret";
    const connect = vi.fn().mockResolvedValue({
      redirectUrl: "https://auth.example.com/start",
      state: "signed-state",
    });
    const driver: EmailDriver<any, { mailboxConnect: true }, "gmail"> = {
      id: "gmail",
      name: "gmail",
      capabilities: { mailboxConnect: true },
      sendEmail: vi.fn(),
      handleWebhook: vi.fn(),
      mailboxes: { connect },
    };

    const client = EmailKit({
      emailDrivers: [driver],
      secret: "config-emailkit-secret",
    });

    await client.mailboxes.connect({ email: "support@example.com" });

    expect(connect).toHaveBeenCalledWith(
      { email: "support@example.com" },
      expect.objectContaining({
        secret: "config-emailkit-secret",
        onAuthUpdated: expect.any(Function),
      }),
    );
  });

  it("normalizes mailbox callback results and dispatches mailbox hooks", async () => {
    const mailbox = {
      id: "mbx_123",
      email: "support@example.com",
      status: "connected" as const,
    };
    const auth = { accessToken: "access_123" };
    const handleCallback = vi.fn().mockResolvedValue({
      mailbox,
      auth,
      context: { flow: "oauth" },
    });
    const onConnected = vi.fn();
    const driver: EmailDriver<
      any,
      { mailboxConnect: true; requiresSecret: true },
      "gmail"
    > = {
      id: "gmail",
      name: "gmail",
      capabilities: {
        mailboxConnect: true,
        requiresSecret: true,
        publicRoutes: { connectCallback: true },
      },
      sendEmail: vi.fn(),
      handleWebhook: vi.fn(),
      mailboxes: { connect: vi.fn() },
      handleCallback,
    };

    const client = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
      hooks: {
        mailbox: { onConnected },
      },
    });

    const response = await client.handler()({
      method: "GET",
      headers: {},
      query: {},
      body: null,
    });

    expect(handleCallback).toHaveBeenCalledWith(
      expect.objectContaining({ method: "GET" }),
      expect.objectContaining({
        secret: "emailkit-secret",
        onAuthUpdated: expect.any(Function),
      }),
    );
    expect(onConnected).toHaveBeenCalledWith({
      emailDriver: "gmail",
      mailbox: {
        id: "mbx_123",
        email: "support@example.com",
        status: "connected",
      },
      auth,
      context: { flow: "oauth" },
    });
    expect(response.status).toBe(200);
  });

  it("dispatches outbound webhooks to onOutbound instead of onUnknown", async () => {
    const outboundEvent = {
      schemaVersion: "1" as const,
      eventId: "evt_123",
      messageId: "msg_123",
      providerId: "provider_123",
      from: { email: "sender@example.com" },
      to: [{ email: "recipient@example.com" }],
      recipient: "recipient@example.com",
      subject: "Hello",
      timestamp: new Date("2026-05-21T00:00:00.000Z"),
      status: "sent" as const,
    };
    const onOutbound = vi.fn();
    const onUnknown = vi.fn();
    const driver: EmailDriver = {
      id: "test-provider",
      capabilities: {},
      sendEmail: vi.fn(),
      handleWebhook: vi.fn().mockResolvedValue({
        type: "outbound",
        data: outboundEvent,
      }),
    };

    const client = EmailKit({
      emailDrivers: [driver],
      hooks: {
        email: {
          onOutbound,
          onUnknown,
        },
      },
    });

    await client.handler()({
      method: "POST",
      headers: {},
      query: {},
      body: {},
    });

    expect(onOutbound).toHaveBeenCalledWith({
      ...outboundEvent,
      emailDriver: "test-provider",
    });
    expect(onUnknown).not.toHaveBeenCalled();
  });

  it("passes bot-detection-enriched opened webhook data to onAll and onOpened", async () => {
    const openedEvent = {
      schemaVersion: "1" as const,
      eventId: "evt_opened",
      messageId: "msg_123",
      providerId: "provider_123",
      from: { email: "sender@example.com" },
      to: [{ email: "recipient@example.com" }],
      recipient: "recipient@example.com",
      subject: "Hello",
      timestamp: new Date("2026-05-21T00:00:00.000Z"),
      status: "opened" as const,
      userAgent: "HubSpot Connect",
    };
    const onAll = vi.fn();
    const onOpened = vi.fn();
    const driver: EmailDriver = {
      id: "test-provider",
      capabilities: {},
      sendEmail: vi.fn(),
      handleWebhook: vi.fn().mockResolvedValue({
        type: "opened",
        data: openedEvent,
      }),
    };

    const client = EmailKit({
      emailDrivers: [driver],
      hooks: {
        email: {
          onAll,
          onOpened,
        },
      },
    });

    await client.handler()({
      method: "POST",
      headers: {},
      query: {},
      body: {},
    });

    expect(onAll).toHaveBeenCalledTimes(1);
    expect(onOpened).toHaveBeenCalledTimes(1);
    const allEvent = onAll.mock.calls[0]![0];
    const openedData = onOpened.mock.calls[0]![0];
    expect(allEvent.data).toBe(openedData);
    expect(openedData).toMatchObject({
      ...openedEvent,
      emailDriver: "test-provider",
      botDetection: {
        isBot: true,
        reason: "known-bot-agent",
      },
    });
  });

  it("passes bot-detection-enriched clicked webhook data to onAll and onClicked", async () => {
    const clickedEvent = {
      schemaVersion: "1" as const,
      eventId: "evt_clicked",
      messageId: "msg_123",
      providerId: "provider_123",
      from: { email: "sender@example.com" },
      to: [{ email: "recipient@example.com" }],
      recipient: "recipient@example.com",
      subject: "Hello",
      timestamp: new Date("2026-05-21T00:00:00.000Z"),
      status: "clicked" as const,
      url: "https://example.com/demo",
      userAgent: "Mozilla/5.0",
    };
    const onAll = vi.fn();
    const onClicked = vi.fn();
    const driver: EmailDriver = {
      id: "test-provider",
      capabilities: {},
      sendEmail: vi.fn(),
      handleWebhook: vi.fn().mockResolvedValue({
        type: "clicked",
        data: clickedEvent,
      }),
    };

    const client = EmailKit({
      emailDrivers: [driver],
      hooks: {
        email: {
          onAll,
          onClicked,
        },
      },
    });

    await client.handler()({
      method: "HEAD",
      headers: {},
      query: {},
      body: {},
    });

    expect(onAll).toHaveBeenCalledTimes(1);
    expect(onClicked).toHaveBeenCalledTimes(1);
    const allEvent = onAll.mock.calls[0]![0];
    const clickedData = onClicked.mock.calls[0]![0];
    expect(allEvent.data).toBe(clickedData);
    expect(clickedData).toMatchObject({
      ...clickedEvent,
      emailDriver: "test-provider",
      botDetection: {
        isBot: true,
        reason: "method-head",
      },
    });
  });

  it("gates universal webhook facades by configured driver capabilities", async () => {
    const accountSetup = vi.fn().mockResolvedValue({
      webhook: {
        id: "wh_account",
        scope: "account",
        url: "https://example.com/account",
        status: "active",
      },
    });
    const mailboxSetup = vi.fn().mockResolvedValue({
      webhook: {
        id: "wh_mailbox",
        scope: "mailbox",
        url: "https://example.com/mailbox",
        status: "active",
      },
    });
    const domainSetup = vi.fn().mockResolvedValue({
      webhook: {
        id: "wh_domain",
        scope: "domain",
        url: "https://example.com/domain",
        status: "active",
      },
    });

    const accountDriver: EmailDriver<
      any,
      { webhooks: { account: { setup: true } } },
      "account-driver"
    > = {
      ...createPlainDriver("account-driver"),
      capabilities: { webhooks: { account: { setup: true } } },
      webhooks: { account: { setup: accountSetup } },
    };
    const mailboxDriver: EmailDriver<
      any,
      { webhooks: { mailbox: { setup: true } } },
      "mailbox-driver"
    > = {
      ...createPlainDriver("mailbox-driver"),
      capabilities: { webhooks: { mailbox: { setup: true } } },
      webhooks: { mailbox: { setup: mailboxSetup } },
    };
    const domainDriver: EmailDriver<
      any,
      { webhooks: { domain: { setup: true } } },
      "domain-driver"
    > = {
      ...createPlainDriver("domain-driver"),
      capabilities: { webhooks: { domain: { setup: true } } },
      webhooks: { domain: { setup: domainSetup } },
    };

    const client = EmailKit({
      emailDrivers: [accountDriver, mailboxDriver, domainDriver],
      resolveEmailDriver: ({ operation }) => {
        if (operation.startsWith("mailboxes.")) return "mailbox-driver";
        if (operation.startsWith("domains.")) return "domain-driver";
        return "account-driver";
      },
    });

    if (false) {
      // @ts-expect-error mailbox-only drivers cannot be selected for account webhooks.
      client.webhooks.setup({
        url: "https://example.com",
        emailDriver: "mailbox-driver",
      });
      // @ts-expect-error account-only drivers cannot be selected for mailbox webhooks.
      client.mailboxes.webhooks.setup({
        url: "https://example.com",
        email: "support@example.com",
        emailDriver: "account-driver",
      });
      // @ts-expect-error account-only drivers cannot be selected for domain webhooks.
      client.domains.webhooks.setup({
        url: "https://example.com",
        domain: "example.com",
        emailDriver: "account-driver",
      });
    }

    await expect(
      client.webhooks.setup({
        url: "https://example.com/account",
        emailDriver: "account-driver",
      }),
    ).resolves.toMatchObject({
      webhook: { id: "wh_account", emailDriver: "account-driver" },
    });
    await expect(
      client.mailboxes.webhooks.setup({
        url: "https://example.com/mailbox",
        email: "support@example.com",
        emailDriver: "mailbox-driver",
      }),
    ).resolves.toMatchObject({
      webhook: { id: "wh_mailbox", emailDriver: "mailbox-driver" },
    });
    await expect(
      client.domains.webhooks.setup({
        url: "https://example.com/domain",
        domain: "example.com",
        emailDriver: "domain-driver",
      }),
    ).resolves.toMatchObject({
      webhook: { id: "wh_domain", emailDriver: "domain-driver" },
    });

    expect(accountSetup).toHaveBeenCalledWith(
      { url: "https://example.com/account" },
      expect.objectContaining({ onAuthUpdated: expect.any(Function) }),
    );
    expect(mailboxSetup).toHaveBeenCalledWith(
      { url: "https://example.com/mailbox", email: "support@example.com" },
      expect.objectContaining({ onAuthUpdated: expect.any(Function) }),
    );
    expect(domainSetup).toHaveBeenCalledWith(
      { url: "https://example.com/domain", domain: "example.com" },
      expect.objectContaining({ onAuthUpdated: expect.any(Function) }),
    );
  });

  it("injects configured public webhook URLs when setup inputs omit url", async () => {
    const accountSetup = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        webhook: {
          id: "wh_account",
          scope: "account",
          url: input.url,
          status: "active",
        },
      }),
    );
    const mailboxSetup = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        webhook: {
          id: "wh_mailbox",
          scope: "mailbox",
          url: input.url,
          status: "active",
        },
      }),
    );
    const domainSetup = vi.fn().mockImplementation((input) =>
      Promise.resolve({
        webhook: {
          id: "wh_domain",
          scope: "domain",
          url: input.url,
          status: "active",
        },
      }),
    );
    const driver: EmailDriver<
      any,
      {
        webhooks: {
          account: { setup: true };
          mailbox: { setup: true };
          domain: { setup: true };
        };
        publicRoutes: { webhook: true; lifecycleWebhook: true };
      },
      "route-driver"
    > = {
      ...createPlainDriver("route-driver"),
      capabilities: {
        webhooks: {
          account: { setup: true },
          mailbox: { setup: true },
          domain: { setup: true },
        },
        publicRoutes: { webhook: true, lifecycleWebhook: true },
      },
      webhooks: {
        account: { setup: accountSetup },
        mailbox: { setup: mailboxSetup },
        domain: { setup: domainSetup },
      },
    };
    const client = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
      publicRoutes: {
        baseUrl: "https://app.example.com/",
        route: "/api/email/:emailDriverId",
        webhookRoutes: {
          drivers: {
            "route-driver": {
              route: "/hooks/:emailDriverId",
              lifecycle: "/hooks/:emailDriverId/lifecycle",
            },
          },
        },
      },
    });

    await client.webhooks.setup({});
    await client.mailboxes.webhooks.setup({ email: "support@example.com" });
    await client.domains.webhooks.setup({ domain: "example.com" });

    const expectedUrl = "https://app.example.com/hooks/route-driver";
    const expectedLifecycleUrl =
      "https://app.example.com/hooks/route-driver/lifecycle";
    expect(accountSetup).toHaveBeenCalledWith(
      {
        url: expectedUrl,
        provider: { lifecycleNotificationUrl: expectedLifecycleUrl },
      },
      expect.objectContaining({
        publicRoutes: expect.objectContaining({
          webhookUrl: expectedUrl,
          lifecycleWebhookUrl: expectedLifecycleUrl,
        }),
      }),
    );
    expect(mailboxSetup).toHaveBeenCalledWith(
      {
        email: "support@example.com",
        url: expectedUrl,
        provider: { lifecycleNotificationUrl: expectedLifecycleUrl },
      },
      expect.objectContaining({
        publicRoutes: expect.objectContaining({ webhookUrl: expectedUrl }),
      }),
    );
    expect(domainSetup).toHaveBeenCalledWith(
      {
        domain: "example.com",
        url: expectedUrl,
        provider: { lifecycleNotificationUrl: expectedLifecycleUrl },
      },
      expect.objectContaining({
        publicRoutes: expect.objectContaining({ webhookUrl: expectedUrl }),
      }),
    );
  });

  it("uses PUBLIC_BASE_URL and the default EmailKit route when publicRoutes is omitted", async () => {
    process.env.PUBLIC_BASE_URL = "https://env.example.com/";
    const setup = vi.fn().mockResolvedValue({
      webhook: {
        id: "wh_account",
        scope: "account",
        url: "https://env.example.com/api/email/env-driver",
        status: "active",
      },
    });
    const driver: EmailDriver<
      any,
      {
        webhooks: { account: { setup: true } };
        publicRoutes: { webhook: true; lifecycleWebhook: true };
      },
      "env-driver"
    > = {
      ...createPlainDriver("env-driver"),
      capabilities: {
        webhooks: { account: { setup: true } },
        publicRoutes: { webhook: true, lifecycleWebhook: true },
      },
      webhooks: { account: { setup } },
    };
    const client = EmailKit({ emailDrivers: [driver] });

    await client.webhooks.setup({});

    expect(setup).toHaveBeenCalledWith(
      {
        url: "https://env.example.com/api/email/env-driver",
        provider: {
          lifecycleNotificationUrl:
            "https://env.example.com/api/email/env-driver",
        },
      },
      expect.objectContaining({
        publicRoutes: expect.objectContaining({
          webhookUrl: "https://env.example.com/api/email/env-driver",
          lifecycleWebhookUrl: "https://env.example.com/api/email/env-driver",
        }),
      }),
    );
  });

  it("lets explicit publicRoutes override PUBLIC_BASE_URL", async () => {
    process.env.PUBLIC_BASE_URL = "https://env.example.com";
    const setup = vi.fn().mockResolvedValue({
      webhook: {
        id: "wh_account",
        scope: "account",
        url: "https://config.example.com/api/email/config-driver",
        status: "active",
      },
    });
    const driver: EmailDriver<
      any,
      {
        webhooks: { account: { setup: true } };
        publicRoutes: { webhook: true; lifecycleWebhook: true };
      },
      "config-driver"
    > = {
      ...createPlainDriver("config-driver"),
      capabilities: {
        webhooks: { account: { setup: true } },
        publicRoutes: { webhook: true, lifecycleWebhook: true },
      },
      webhooks: { account: { setup } },
    };
    const client = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
      publicRoutes: {
        baseUrl: "https://config.example.com",
      },
    });

    await client.webhooks.setup({});

    expect(setup).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://config.example.com/api/email/config-driver",
      }),
      expect.objectContaining({
        publicRoutes: expect.objectContaining({
          webhookUrl: "https://config.example.com/api/email/config-driver",
        }),
      }),
    );
  });

  it("rejects public route placeholders other than :emailDriverId", async () => {
    const unsupportedPlaceholder = `:${"emailDriver"}`;
    const setup = vi.fn().mockResolvedValue({
      webhook: {
        id: "wh_account",
        scope: "account",
        url: "unused",
        status: "active",
      },
    });
    const driver: EmailDriver<
      any,
      {
        webhooks: { account: { setup: true } };
        publicRoutes: { webhook: true; lifecycleWebhook: true };
      },
      "strict-driver"
    > = {
      ...createPlainDriver("strict-driver"),
      capabilities: {
        webhooks: { account: { setup: true } },
        publicRoutes: { webhook: true, lifecycleWebhook: true },
      },
      webhooks: { account: { setup } },
    };
    const client = EmailKit({
      emailDrivers: [driver],
      publicRoutes: {
        baseUrl: "https://app.example.com",
        route: `/api/email/${unsupportedPlaceholder}`,
      },
    });

    await expect(client.webhooks.setup({})).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
    expect(setup).not.toHaveBeenCalled();
  });

  it("injects configured public callback and landing routes for mailbox connect", async () => {
    const connect = vi.fn().mockResolvedValue({
      redirectUrl: "https://auth.example.com/start",
      state: "signed-state",
    });
    const driver: EmailDriver<
      any,
      {
        mailboxConnect: true;
        publicRoutes: { connectCallback: true; connectLanding: true };
      },
      "gmail"
    > = {
      ...createPlainDriver("gmail"),
      capabilities: {
        mailboxConnect: true,
        publicRoutes: { connectCallback: true, connectLanding: true },
      },
      mailboxes: { connect },
      handleCallback: vi.fn(),
    };
    const client = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
      publicRoutes: {
        baseUrl: "https://app.example.com",
        route: "/api/email/:emailDriverId",
        connectLandingRoutes: {
          success: "/connected",
          failure: "https://app.example.com/failed",
        },
      },
    });

    await client.mailboxes.connect({ email: "support@example.com" });

    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({
        email: "support@example.com",
        callbackUrl: "https://app.example.com/api/email/gmail",
        landingUrl: "https://app.example.com/connected",
        failureUrl: "https://app.example.com/failed",
      }),
      expect.objectContaining({
        publicRoutes: expect.objectContaining({
          connectCallbackUrl: "https://app.example.com/api/email/gmail",
          connectLandingUrl: "https://app.example.com/connected",
          connectFailureUrl: "https://app.example.com/failed",
        }),
      }),
    );
  });

  it("does not surface callback routes to drivers that do not declare them", async () => {
    const connect = vi.fn().mockResolvedValue({
      redirectUrl: "https://auth.example.com/start",
    });
    const driver: EmailDriver<any, { mailboxConnect: true }, "api-mailbox"> = {
      ...createPlainDriver("api-mailbox"),
      capabilities: { mailboxConnect: true },
      mailboxes: { connect },
    };
    const client = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
      publicRoutes: {
        baseUrl: "https://app.example.com",
        route: "/api/email/:emailDriverId",
        connectLandingRoutes: {
          success: "/connected",
          failure: "/failed",
        },
      },
    });

    await client.mailboxes.connect({
      email: "support@example.com",
      callbackUrl: "https://app.example.com/manual-callback",
      landingUrl: "/manual-connected",
      failureUrl: "/manual-failed",
    } as any);

    expect(connect).toHaveBeenCalledWith(
      { email: "support@example.com" },
      expect.objectContaining({
        onAuthUpdated: expect.any(Function),
      }),
    );
    expect(connect.mock.calls[0]![1]).not.toHaveProperty("publicRoutes");
  });

  it("rejects mailbox connect landing URLs outside configured origins", async () => {
    const driver: EmailDriver<
      any,
      {
        mailboxConnect: true;
        publicRoutes: { connectCallback: true; connectLanding: true };
      },
      "gmail"
    > = {
      ...createPlainDriver("gmail"),
      capabilities: {
        mailboxConnect: true,
        publicRoutes: { connectCallback: true, connectLanding: true },
      },
      mailboxes: { connect: vi.fn() },
      handleCallback: vi.fn(),
    };
    const client = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
      publicRoutes: {
        baseUrl: "https://app.example.com",
        route: "/api/email/:emailDriverId",
      },
    });

    await expect(
      client.mailboxes.connect({
        landingUrl: "https://other.example.com/connected",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_CONFIG",
    });
    expect(driver.mailboxes!.connect).not.toHaveBeenCalled();
  });

  it("dispatches centralized webhook lifecycle hooks for setup, refresh, and delete", async () => {
    const onAll = vi.fn();
    const onCreated = vi.fn();
    const onUpdated = vi.fn();
    const onDeleted = vi.fn();
    const setup = vi.fn().mockResolvedValue({
      webhook: {
        id: "wh_account",
        scope: "account",
        url: "https://example.com/account",
        status: "active",
      },
      context: { tenantId: "tenant_123" },
      raw: { provider: "setup" },
    });
    const refresh = vi.fn().mockResolvedValue({
      webhook: {
        id: "wh_account",
        scope: "account",
        url: "https://example.com/account",
        status: "active",
      },
      context: { tenantId: "tenant_123" },
      raw: { provider: "refresh" },
    });
    const remove = vi.fn().mockResolvedValue({
      deleted: true,
      webhook: {
        id: "wh_account",
        scope: "account",
        url: "https://example.com/account",
        status: "deleted",
      },
      context: { tenantId: "tenant_123" },
      raw: { provider: "delete" },
    });
    const driver: EmailDriver<
      any,
      { webhooks: { account: true } },
      "account-driver"
    > = {
      ...createPlainDriver("account-driver"),
      capabilities: { webhooks: { account: true } },
      webhooks: { account: { setup, refresh, delete: remove } },
    };
    const client = EmailKit({
      emailDrivers: [driver],
      hooks: {
        webhook: {
          onAll,
          onCreated,
          onUpdated,
          onDeleted,
        },
      },
    });

    const created = await client.webhooks.setup({
      url: "https://example.com/account",
      context: { tenantId: "tenant_123" },
    });
    await client.webhooks.refresh({
      webhook: created.webhook,
      context: { tenantId: "tenant_123" },
    });
    await client.webhooks.delete({
      webhook: created.webhook,
      context: { tenantId: "tenant_123" },
    });

    expect(onAll).toHaveBeenCalledTimes(3);
    expect(onCreated).toHaveBeenCalledWith({
      emailDriver: "account-driver",
      action: "created",
      source: "api",
      reason: "created",
      recommendedActions: ["persist"],
      scope: "account",
      webhookId: "wh_account",
      webhook: {
        id: "wh_account",
        emailDriver: "account-driver",
        scope: "account",
        url: "https://example.com/account",
        status: "active",
      },
      status: "active",
      context: { tenantId: "tenant_123" },
      raw: { provider: "setup" },
    });
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        emailDriver: "account-driver",
        action: "updated",
        source: "api",
        reason: "renewed",
        recommendedActions: ["persist"],
        scope: "account",
        webhookId: "wh_account",
        webhook: expect.objectContaining({
          id: "wh_account",
          emailDriver: "account-driver",
        }),
        status: "active",
      }),
    );
    expect(onDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        emailDriver: "account-driver",
        action: "deleted",
        source: "api",
        reason: "deleted",
        recommendedActions: ["delete_local"],
        scope: "account",
        webhookId: "wh_account",
        webhook: expect.objectContaining({
          id: "wh_account",
          emailDriver: "account-driver",
          status: "deleted",
        }),
        status: "deleted",
      }),
    );
  });

  it("dispatches webhook created hooks for webhooks returned by mailbox connection", async () => {
    const onConnected = vi.fn();
    const onCreated = vi.fn();
    const driver: EmailDriver<any, { mailboxConnect: true }, "mailbox-driver"> =
      {
        ...createPlainDriver("mailbox-driver"),
        capabilities: { mailboxConnect: true },
        mailboxes: {
          connect: vi.fn().mockResolvedValue({
            mailbox: {
              id: "mailbox_123",
              email: "support@example.com",
              status: "connected",
            },
            webhooks: [
              {
                id: "wh_connected",
                scope: "mailbox",
                url: "https://example.com/mailbox",
                status: "active",
              },
            ],
            context: { tenantId: "tenant_123" },
            raw: { createdVia: "connect" },
          }),
        },
      };
    const client = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
      hooks: {
        mailbox: { onConnected },
        webhook: { onCreated },
      },
    });

    const result = await client.mailboxes.connect({
      context: { tenantId: "tenant_123" },
    });

    expect(result.webhooks).toEqual([
      {
        id: "wh_connected",
        emailDriver: "mailbox-driver",
        scope: "mailbox",
        url: "https://example.com/mailbox",
        status: "active",
      },
    ]);
    expect(onConnected).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith({
      emailDriver: "mailbox-driver",
      action: "created",
      source: "api",
      reason: "created",
      recommendedActions: ["persist"],
      scope: "mailbox",
      webhookId: "wh_connected",
      target: {
        mailboxEmail: "support@example.com",
        mailboxId: "mailbox_123",
      },
      webhook: {
        id: "wh_connected",
        emailDriver: "mailbox-driver",
        scope: "mailbox",
        url: "https://example.com/mailbox",
        status: "active",
      },
      status: "active",
      context: { tenantId: "tenant_123" },
      raw: { createdVia: "connect" },
    });
  });

  it("omits webhook facades when no configured driver supports them", () => {
    const client = EmailKit({
      emailDrivers: [createPlainDriver("plain-driver")],
    });

    if (false) {
      // @ts-expect-error account webhooks are absent without a supporting driver.
      client.webhooks;
      // @ts-expect-error mailbox webhooks are absent without a supporting driver.
      client.mailboxes.webhooks;
      // @ts-expect-error domain webhooks are absent without a supporting driver.
      client.domains.webhooks;
    }

    expect("webhooks" in client).toBe(false);
    expect("webhooks" in client.mailboxes).toBe(false);
    expect("webhooks" in client.domains).toBe(false);
  });

  it("validates webhook scopes against implemented methods", () => {
    const declaredMissing: EmailDriver<
      any,
      { webhooks: { account: true } },
      "declared-missing"
    > = {
      ...createPlainDriver("declared-missing"),
      capabilities: { webhooks: { account: true } },
      webhooks: { account: {} },
    };
    const implementedUndeclared: EmailDriver<any, {}, "implemented-missing"> = {
      ...createPlainDriver("implemented-missing"),
      capabilities: {},
      webhooks: { account: { setup: vi.fn() } },
    };

    expect(() => EmailKit({ emailDrivers: [declaredMissing] })).toThrowError(
      /webhooks\.account\.setup is declared/,
    );
    expect(() =>
      EmailKit({ emailDrivers: [implementedUndeclared] }),
    ).toThrowError(/driver\.webhooks\.account\.setup is implemented/);
  });
});

describe("EmailKit sync", () => {
  const makeInboundEvent = (messageId: string, timestamp: Date) => ({
    type: "inbound" as const,
    data: {
      messageId,
      from: { email: "sender@example.com" },
      to: [{ email: "recipient@example.com" }],
      reply: {},
      subject: `Subject ${messageId}`,
      headers: {},
      timestamp,
      raw: { providerMessageId: messageId },
    },
  });

  const createMailboxSyncDriver = <const TId extends string>(
    id: TId,
    mailbox: NonNullable<EmailDriver["sync"]>["mailbox"],
  ): EmailDriver<any, { sync: { mailbox: true } }, TId> => ({
    ...createPlainDriver(id),
    capabilities: { sync: { mailbox: true } },
    sync: { mailbox },
  });

  it("replays driver events through email hooks oldest-first with sync context", async () => {
    const onInbound = vi.fn();
    const onAll = vi.fn();
    const first = makeInboundEvent("msg_1", new Date("2026-06-01T00:00:00Z"));
    const second = makeInboundEvent("msg_2", new Date("2026-06-02T00:00:00Z"));
    const syncedFrom = new Date("2026-05-30T00:00:00Z");
    const syncMailbox = vi.fn(async function* () {
      yield first;
      yield second;
      return { syncedFrom };
    });
    const client = EmailKit({
      emailDrivers: [createMailboxSyncDriver("sync-driver", syncMailbox)],
      hooks: { email: { onInbound, onAll } },
    });

    const result = await client.mailboxes.sync({
      email: "support@example.com",
      since: new Date("2026-06-01T00:00:00Z"),
      context: { tenantId: "tenant_123" },
    });

    expect(result).toEqual({ dispatched: 2, syncedFrom });
    expect(onInbound).toHaveBeenCalledTimes(2);
    expect(onInbound.mock.calls[0]![0]).toMatchObject({
      emailDriver: "sync-driver",
      messageId: "msg_1",
    });
    expect(onInbound.mock.calls[1]![0]).toMatchObject({
      messageId: "msg_2",
    });
    expect(onAll).toHaveBeenCalledTimes(2);
    expect(onAll.mock.calls[0]![0]).toMatchObject({
      emailDriver: "sync-driver",
      type: "inbound",
      raw: { providerMessageId: "msg_1" },
      context: { tenantId: "tenant_123" },
    });
    expect(syncMailbox).toHaveBeenCalledWith(
      expect.objectContaining({ email: "support@example.com" }),
      expect.objectContaining({
        context: { tenantId: "tenant_123" },
        onAuthUpdated: expect.any(Function),
      }),
    );
  });

  it("routes replayed lifecycle events through webhook hooks", async () => {
    const onActionRequired = vi.fn();
    const onWebhookAll = vi.fn();
    const client = EmailKit({
      emailDrivers: [
        createMailboxSyncDriver("sync-driver", async function* () {
          yield {
            type: "webhook.lifecycle" as const,
            data: {
              emailDriver: "sync-driver",
              action: "action_required" as const,
              source: "provider" as const,
              reason: "expiring" as const,
              scope: "mailbox" as const,
            },
          };
          return { syncedFrom: new Date("2026-06-01T00:00:00Z") };
        }),
      ],
      hooks: { webhook: { onActionRequired, onAll: onWebhookAll } },
    });

    const result = await client.mailboxes.sync({
      email: "support@example.com",
      since: new Date("2026-06-01T00:00:00Z"),
    });

    expect(result.dispatched).toBe(1);
    expect(onWebhookAll).toHaveBeenCalledTimes(1);
    expect(onActionRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        emailDriver: "sync-driver",
        action: "action_required",
        source: "provider",
        reason: "expiring",
        scope: "mailbox",
      }),
    );
  });

  it("wraps user hook failures in EmailKitSyncError with replay progress", async () => {
    const hookError = new Error("persist failed");
    const onInbound = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(hookError);
    const firstTimestamp = new Date("2026-06-01T00:00:00Z");
    const client = EmailKit({
      emailDrivers: [
        createMailboxSyncDriver("sync-driver", async function* () {
          yield makeInboundEvent("msg_1", firstTimestamp);
          yield makeInboundEvent("msg_2", new Date("2026-06-02T00:00:00Z"));
          return { syncedFrom: new Date("2026-05-30T00:00:00Z") };
        }),
      ],
      hooks: { email: { onInbound } },
    });

    const error = await client.mailboxes
      .sync({
        email: "support@example.com",
        since: new Date("2026-06-01T00:00:00Z"),
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(EmailKitSyncError);
    expect(error).toMatchObject({
      code: "SYNC_FAILED",
      provider: "sync-driver",
      dispatched: 1,
      lastEventTimestamp: firstTimestamp,
      cause: hookError,
    });
  });

  it("finalizes the driver stream when a sync hook fails", async () => {
    const hookError = new Error("persist failed");
    let finalized = false;
    const client = EmailKit({
      emailDrivers: [
        createMailboxSyncDriver("sync-driver", async function* () {
          try {
            yield makeInboundEvent("msg_1", new Date("2026-06-01T00:00:00Z"));
            yield makeInboundEvent("msg_2", new Date("2026-06-02T00:00:00Z"));
          } finally {
            finalized = true;
          }
          return { syncedFrom: new Date("2026-05-30T00:00:00Z") };
        }),
      ],
      hooks: {
        email: {
          onInbound: vi
            .fn()
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(hookError),
        },
      },
    });

    const error = await client.mailboxes
      .sync({
        email: "support@example.com",
        since: new Date("2026-06-01T00:00:00Z"),
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(EmailKitSyncError);
    expect(error.cause).toBe(hookError);
    expect(finalized).toBe(true);
  });

  it("aborts between events and finalizes the driver stream", async () => {
    const controller = new AbortController();
    const onInbound = vi.fn(() => controller.abort());
    let finalized = false;
    const client = EmailKit({
      emailDrivers: [
        createMailboxSyncDriver("sync-driver", async function* () {
          try {
            yield makeInboundEvent("msg_1", new Date("2026-06-01T00:00:00Z"));
            yield makeInboundEvent("msg_2", new Date("2026-06-02T00:00:00Z"));
          } finally {
            finalized = true;
          }
          return { syncedFrom: new Date("2026-05-30T00:00:00Z") };
        }),
      ],
      hooks: { email: { onInbound } },
    });

    const error = await client.mailboxes
      .sync({
        email: "support@example.com",
        since: new Date("2026-06-01T00:00:00Z"),
        signal: controller.signal,
      })
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(EmailKitSyncError);
    expect(error).toMatchObject({
      message: "Sync aborted",
      dispatched: 1,
      lastEventTimestamp: new Date("2026-06-01T00:00:00Z"),
    });
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect(finalized).toBe(true);
  });

  it("rejects sync for selected drivers without the capability", async () => {
    const client = EmailKit({
      emailDrivers: [
        createMailboxSyncDriver("sync-driver", async function* () {
          return { syncedFrom: new Date() };
        }),
        createPlainDriver("plain-driver"),
      ],
      resolveEmailDriver: () => "sync-driver",
    });

    await expect(
      client.mailboxes.sync({
        email: "support@example.com",
        since: new Date("2026-06-01T00:00:00Z"),
        emailDriver: "plain-driver",
      } as any),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  });

  it("validates sync scopes against implemented methods", () => {
    const declaredMissing: EmailDriver<
      any,
      { sync: { mailbox: true } },
      "declared-missing"
    > = {
      ...createPlainDriver("declared-missing"),
      capabilities: { sync: { mailbox: true } },
      sync: {},
    };
    const implementedUndeclared: EmailDriver<any, {}, "implemented-missing"> = {
      ...createPlainDriver("implemented-missing"),
      capabilities: {},
      sync: { mailbox: vi.fn() },
    };

    expect(() => EmailKit({ emailDrivers: [declaredMissing] })).toThrowError(
      /sync\.mailbox is declared/,
    );
    expect(() =>
      EmailKit({ emailDrivers: [implementedUndeclared] }),
    ).toThrowError(/driver\.sync\.mailbox is implemented/);
  });

  it("exposes top-level sync for account-scope drivers only", async () => {
    const onInbound = vi.fn();
    const accountDriver: EmailDriver<
      any,
      { sync: { account: true } },
      "account-sync-driver"
    > = {
      ...createPlainDriver("account-sync-driver"),
      capabilities: { sync: { account: true } },
      sync: {
        account: async function* () {
          yield makeInboundEvent("msg_1", new Date("2026-06-01T00:00:00Z"));
          return { syncedFrom: new Date("2026-05-30T00:00:00Z") };
        },
      },
    };
    const client = EmailKit({
      emailDrivers: [accountDriver],
      hooks: { email: { onInbound } },
    });
    const plainClient = EmailKit({
      emailDrivers: [createPlainDriver("plain-driver")],
    });

    const result = await client.sync({
      since: new Date("2026-06-01T00:00:00Z"),
    });

    expect(result).toEqual({
      dispatched: 1,
      syncedFrom: new Date("2026-05-30T00:00:00Z"),
    });
    expect(onInbound).toHaveBeenCalledTimes(1);
    expect("sync" in plainClient).toBe(false);
    expect("sync" in plainClient.mailboxes).toBe(false);
    expect("sync" in plainClient.domains).toBe(false);
  });

  it("keeps live webhook dispatch unchanged", async () => {
    const onInbound = vi.fn();
    const onAll = vi.fn();
    const driver: EmailDriver<any, {}, "webhook-driver"> = {
      ...createPlainDriver("webhook-driver"),
      handleWebhook: vi
        .fn()
        .mockResolvedValue(
          makeInboundEvent("msg_live", new Date("2026-06-01T00:00:00Z")),
        ),
    };
    const client = EmailKit({
      emailDrivers: [driver],
      hooks: { email: { onInbound, onAll } },
    });

    await client.handler()({
      method: "POST",
      headers: {},
      query: {},
      body: { payload: true },
    });

    expect(onInbound).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "msg_live" }),
    );
    expect(onAll).toHaveBeenCalledTimes(1);
    const allEvent = onAll.mock.calls[0]![0];
    expect(allEvent.raw).toEqual({ payload: true });
    expect("context" in allEvent).toBe(false);
  });
});

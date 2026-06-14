import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  EmailKit,
  EmailKitError,
  OUTLOOK_CAPABILITIES,
  OUTLOOK_DRAFT_CAPABILITIES,
  OutlookDriver,
  type ConnectMailboxInput,
  type OutlookDriverConfig,
  type OutlookMailboxAuth,
  type OutlookSendEmailMode,
  type OutlookSendEmailResult,
  type SyncStream,
  type WebhookDriverEvent,
} from "../src";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const CALLBACK_URL = "https://app.example.com/api/email/outlook/callback";
const WEBHOOK_URL = "https://app.example.com/api/email/outlook";
const LIFECYCLE_URL = "https://app.example.com/api/email/outlook/lifecycle";
const INBOUND_URL = "https://app.example.com/api/email/inbound";

const connectInput = (input: ConnectMailboxInput = {}) =>
  ({
    callbackUrl: CALLBACK_URL,
    ...input,
  }) as ConnectMailboxInput & { callbackUrl: string };

const createDriver = () =>
  OutlookDriver({
    clientId: "client_123",
    clientSecret: "secret_123",
    tenant: "common",
    scopes: ["offline_access", "User.Read", "Mail.Send", "Mail.Read"],
    autoSubscribeInbound: false,
  });

const createDriverWith = <
  const TSendEmailMode extends OutlookSendEmailMode = "sendMail",
>(
  overrides: Partial<OutlookDriverConfig<"outlook", TSendEmailMode>>,
) =>
  OutlookDriver({
    clientId: "client_123",
    clientSecret: "secret_123",
    tenant: "common",
    scopes: ["offline_access", "User.Read", "Mail.Send", "Mail.Read"],
    autoSubscribeInbound: false,
    ...overrides,
  });

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

describe("OutlookDriver", () => {
  it("defaults to the outlook literal id and preserves custom literal ids", () => {
    const defaultDriver = createDriver();
    const customDriver = OutlookDriver({
      id: "tenant-outlook",
      clientId: "client_123",
      clientSecret: "secret_123",
    });

    expect(defaultDriver.id).toBe("outlook");
    expect(customDriver.id).toBe("tenant-outlook");
    expectTypeOf(defaultDriver.id).toEqualTypeOf<"outlook">();
    expectTypeOf(customDriver.id).toEqualTypeOf<"tenant-outlook">();
    expectTypeOf<OutlookMailboxAuth>().toMatchTypeOf<{
      accessToken: string;
      refreshToken?: string;
    }>();
    expectTypeOf<OutlookSendEmailResult>().toMatchTypeOf<{
      messageId: string;
      provider: string;
    }>();
  });

  it("declares only Outlook-supported EmailKit capabilities", () => {
    const driver = createDriver();

    expect(OUTLOOK_CAPABILITIES).toEqual({
      cc: true,
      bcc: true,
      replyTo: true,
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
        lifecycleWebhook: true,
        connectCallback: true,
        connectLanding: true,
      },
    });
    expect(driver.capabilities.requiresSecret).toBe(true);
    expect(driver.capabilities.mailboxConnect).toBe(true);
    expect(driver.capabilities.providerFetch).toBe(true);
    expect(driver.capabilities.senderAuth).toBe(true);
    expect(driver.capabilities.senderMailbox).toBe(true);
    expect(driver.capabilities.replyTo).toBe(true);
    expect(
      (driver.capabilities as Record<string, unknown>).nativeReplyThreading,
    ).toBeUndefined();
    expect(driver.capabilities.replyHeaders).toBeUndefined();
    expect(driver.capabilities.replyThreadId).toBeUndefined();
    expect(driver.capabilities.sendTracking).toBeUndefined();
    expect(driver.capabilities.eventTracking).toBeUndefined();
    expect(driver.capabilities.tags).toBeUndefined();
    expect(driver.capabilities.metadata).toBeUndefined();
    expect(driver.capabilities.scheduling).toBeUndefined();
    expect(driver.capabilities.templates).toBeUndefined();
    expect(driver.capabilities.sandbox).toBeUndefined();
    expect(driver.capabilities.sendIdempotency).toBeUndefined();
    expect(driver.capabilities.webhooks?.mailbox).toBe(true);
    expect(driver.capabilities.sync?.mailbox).toBe(true);
    expect(driver.sync?.mailbox).toBeTypeOf("function");
    expect(driver.capabilities.mailboxList).toBeUndefined();
    expect(driver.capabilities.mailboxGet).toBeUndefined();
    expect(driver.capabilities.mailboxCreate).toBeUndefined();
    expect(driver.capabilities.mailboxDelete).toBeUndefined();
    expect(driver.mailboxes?.connect).toBeTypeOf("function");
    expect(driver.webhooks?.mailbox?.setup).toBeTypeOf("function");
    expect(driver.webhooks?.mailbox?.refresh).toBeTypeOf("function");
    expect(driver.webhooks?.mailbox?.delete).toBeTypeOf("function");
    expect(driver.mailboxes?.list).toBeUndefined();
    expect(driver.mailboxes?.get).toBeUndefined();

    const emailkit = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
    });
    expect(emailkit.mailboxes.webhooks.setup).toBeTypeOf("function");
    expectTypeOf(emailkit.mailboxes.webhooks.setup).toBeFunction();
  });

  it("derives the nativeReplyThreading capability from the configured send mode", () => {
    const draftDriver = createDriverWith({ sendEmailMode: "draft" });
    const sendMailDriver = createDriverWith({ sendEmailMode: "sendMail" });

    expect(OUTLOOK_DRAFT_CAPABILITIES).toEqual({
      ...OUTLOOK_CAPABILITIES,
      nativeReplyThreading: true,
    });
    expect(draftDriver.capabilities).toBe(OUTLOOK_DRAFT_CAPABILITIES);
    expect(draftDriver.capabilities.nativeReplyThreading).toBe(true);
    expectTypeOf(
      draftDriver.capabilities.nativeReplyThreading,
    ).toEqualTypeOf<true>();
    expect(sendMailDriver.capabilities).toBe(OUTLOOK_CAPABILITIES);
    expect(createDriver().capabilities).toBe(OUTLOOK_CAPABILITIES);
  });

  it("builds a Microsoft OAuth authorization URL with encrypted state and context", async () => {
    const driver = createDriver();

    const result = await driver.mailboxes!.connect!(
      connectInput({
        email: "support@example.com",
        context: { tenantId: "tenant_123" },
      }),
      { secret: "emailkit-secret" },
    );

    expect(result.context).toEqual({ tenantId: "tenant_123" });
    expect(result.state).toBeTypeOf("string");
    expect(result.state!.split(".")).toHaveLength(3);
    expect(result.state).not.toContain("support@example.com");
    const readableStateParts = result
      .state!.split(".")
      .map((part) => Buffer.from(part, "base64url").toString("utf8"))
      .join("");
    expect(readableStateParts).not.toContain("codeVerifier");
    expect(readableStateParts).not.toContain("support@example.com");
    expect(readableStateParts).not.toContain("tenant_123");
    const url = new URL(result.redirectUrl!);
    expect(url.origin + url.pathname).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client_123");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("response_mode")).toBe("query");
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(url.searchParams.get("scope")).toBe(
      "offline_access User.Read Mail.Send Mail.Read",
    );
    expect(url.searchParams.get("login_hint")).toBe("support@example.com");
    expect(url.searchParams.get("state")).toBe(result.state);
    expect(url.searchParams.get("code_challenge")).toMatch(/^[\w-]{43}$/);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("requests Mail.ReadWrite when draft send mode is enabled", async () => {
    const driver = createDriverWith({
      sendEmailMode: "draft",
      scopes: ["offline_access", "User.Read", "Mail.Send"],
    });

    const result = await driver.mailboxes!.connect!(connectInput(), {
      secret: "emailkit-secret",
    });

    const url = new URL(result.redirectUrl!);
    expect(url.searchParams.get("scope")).toBe(
      "offline_access User.Read Mail.Send Mail.ReadWrite",
    );
  });

  it("exchanges an OAuth callback code, redacts raw token fields, and normalizes /me into a mailbox", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access_123",
            refresh_token: "refresh_123",
            expires_in: 3600,
            scope: "offline_access User.Read Mail.Send Mail.Read",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "user_123",
            mail: "support@example.com",
            userPrincipalName: "support@tenant.example",
            displayName: "Support Team",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

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

    expect(callback).toMatchObject({
      context: { tenantId: "tenant_123" },
      mailbox: {
        id: "user_123",
        email: "support@example.com",
        displayName: "Support Team",
        status: "connected",
      },
      auth: {
        accessToken: "access_123",
        refreshToken: "refresh_123",
        expiresAt: Date.parse("2026-05-21T11:00:00.000Z"),
        scopes: ["offline_access", "User.Read", "Mail.Send", "Mail.Read"],
        tokenType: "Bearer",
      },
    });
    expect(callback.mailbox).not.toHaveProperty("auth");
    const raw = callback.raw as { token?: Record<string, unknown> };
    expect(raw.token).toMatchObject({
      expiresIn: 3600,
      scopes: ["offline_access", "User.Read", "Mail.Send", "Mail.Read"],
      tokenType: "Bearer",
    });
    expect(raw.token).not.toHaveProperty("access_token");
    expect(raw.token).not.toHaveProperty("refresh_token");

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0]!;
    expect(tokenUrl).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
    const tokenBody = tokenInit!.body as URLSearchParams;
    expect(tokenBody.get("grant_type")).toBe("authorization_code");
    expect(tokenBody.get("code")).toBe("code_123");
    expect(tokenBody.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(tokenBody.get("code_verifier")).toMatch(/^[\w-]{43}$/);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      "https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName",
    );
  });

  it("creates an inbound Graph subscription when a mailbox connection enables auto-subscribe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access_123",
            refresh_token: "refresh_123",
            expires_in: 3600,
            scope: "offline_access User.Read Mail.Send Mail.Read",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "user_123",
            mail: "support@example.com",
            displayName: "Support Team",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "subscription_123",
            changeType: "created",
            resource: "me/messages",
            notificationUrl: WEBHOOK_URL,
            expirationDateTime: "2026-05-24T10:00:00.000Z",
            clientState: "state_123",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      autoSubscribeInbound: true,
      webhookClientState: "state_123",
      scopes: ["offline_access", "User.Read", "Mail.Send"],
    });
    const connect = await driver.mailboxes!.connect!(connectInput(), {
      secret: "emailkit-secret",
      publicRoutes: { webhookUrl: WEBHOOK_URL },
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

    const authorizationUrl = new URL(connect.redirectUrl!);
    expect(authorizationUrl.searchParams.get("scope")).toBe(
      "offline_access User.Read Mail.Send Mail.Read",
    );
    expect(fetchMock.mock.calls[2]![0]).toBe(
      "https://graph.microsoft.com/v1.0/subscriptions",
    );
    expect(fetchMock.mock.calls[2]![1]!.headers).toMatchObject({
      Authorization: "Bearer access_123",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).toEqual({
      changeType: "created",
      notificationUrl: WEBHOOK_URL,
      lifecycleNotificationUrl: WEBHOOK_URL,
      resource: "me/messages",
      expirationDateTime: "2026-05-24T10:00:00.000Z",
      clientState: "state_123",
      latestSupportedTlsVersion: "v1_2",
    });
    expect(callback.mailbox?.raw).toMatchObject({
      user: { id: "user_123" },
      inboundSubscription: {
        id: "subscription_123",
        clientState: "state_123",
      },
    });
    expect(callback.webhooks).toMatchObject([
      {
        id: "subscription_123",
        emailDriver: "outlook",
        scope: "mailbox",
        providerId: "subscription_123",
        status: "active",
      },
    ]);
    expect(callback.raw).toMatchObject({
      inboundSubscription: {
        id: "subscription_123",
        resource: "me/messages",
      },
    });
  });

  it("adds the core lifecycle route to new Graph subscriptions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "subscription_123",
          changeType: "created",
          resource: "me/messages",
          notificationUrl: WEBHOOK_URL,
          lifecycleNotificationUrl: LIFECYCLE_URL,
          expirationDateTime: "2026-05-24T10:00:00.000Z",
          clientState: "state_123",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      webhookClientState: "state_123",
    });

    const result = await driver.webhooks!.mailbox!.setup!(
      {
        mailbox: { email: "support@example.com" },
        auth: { accessToken: "access_123" },
        url: WEBHOOK_URL,
        events: ["inbound"],
      },
      {
        secret: "emailkit-secret",
        publicRoutes: { lifecycleWebhookUrl: LIFECYCLE_URL },
      },
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      changeType: "created",
      notificationUrl: WEBHOOK_URL,
      lifecycleNotificationUrl: LIFECYCLE_URL,
      resource: "me/messages",
      expirationDateTime: "2026-05-24T10:00:00.000Z",
      clientState: "state_123",
      latestSupportedTlsVersion: "v1_2",
    });
    expect(result.webhook).toMatchObject({
      providerId: "subscription_123",
      raw: {
        lifecycleNotificationUrl: LIFECYCLE_URL,
      },
    });
  });

  it("does not add a lifecycle URL when lifecycle auto-renew is disabled", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "subscription_123",
          changeType: "created",
          resource: "me/messages",
          notificationUrl: WEBHOOK_URL,
          expirationDateTime: "2026-05-24T10:00:00.000Z",
          clientState: "state_123",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      autoRenewOnLifecycle: false,
      webhookClientState: "state_123",
    });

    await driver.webhooks!.mailbox!.setup!(
      {
        mailbox: { email: "support@example.com" },
        auth: { accessToken: "access_123" },
        url: WEBHOOK_URL,
        events: ["inbound"],
      },
      { secret: "emailkit-secret" },
    );

    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      changeType: "created",
      notificationUrl: WEBHOOK_URL,
      resource: "me/messages",
      expirationDateTime: "2026-05-24T10:00:00.000Z",
      clientState: "state_123",
      latestSupportedTlsVersion: "v1_2",
    });
  });

  it("sets up mailbox-scoped Outlook webhooks as Graph subscriptions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "subscription_123",
          changeType: "created",
          resource: "me/messages",
          notificationUrl: INBOUND_URL,
          expirationDateTime: "2026-05-24T10:00:00.000Z",
          clientState: "state_123",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      webhookClientState: "state_123",
    });

    const result = await driver.webhooks!.mailbox!.setup!({
      mailbox: {
        id: "user_123",
        email: "support@example.com",
      },
      auth: {
        accessToken: "access_123",
        tokenType: "Bearer",
      } satisfies OutlookMailboxAuth,
      url: INBOUND_URL,
      events: "all",
      context: { tenantId: "tenant_123" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/subscriptions",
      expect.objectContaining({
        method: "POST",
        headers: {
          Authorization: "Bearer access_123",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      changeType: "created",
      notificationUrl: INBOUND_URL,
      lifecycleNotificationUrl: INBOUND_URL,
      resource: "me/messages",
      expirationDateTime: "2026-05-24T10:00:00.000Z",
      clientState: "state_123",
      latestSupportedTlsVersion: "v1_2",
    });
    expect(result).toMatchObject({
      context: { tenantId: "tenant_123" },
      webhook: {
        id: "subscription_123",
        emailDriver: "outlook",
        scope: "mailbox",
        url: INBOUND_URL,
        events: ["inbound"],
        status: "active",
        providerId: "subscription_123",
      },
      raw: {
        inboundSubscription: {
          id: "subscription_123",
          resource: "me/messages",
        },
      },
    });
    expect(result.webhook.expiresAt).toEqual(
      new Date("2026-05-24T10:00:00.000Z"),
    );
    expect(result.webhook.renewAfter).toEqual(
      new Date("2026-05-24T09:00:00.000Z"),
    );
  });

  it("sets up mailbox webhooks through the public EmailKit facade with top-level auth", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "subscription_facade",
          notificationUrl: "https://app.example.com/api/email/outlook",
          expirationDateTime: "2026-05-21T11:00:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const emailkit = EmailKit({
      emailDrivers: [createDriver()],
      secret: "emailkit-secret",
    });

    const result = await emailkit.mailboxes.webhooks.setup({
      mailbox: {
        id: "user_123",
        email: "support@example.com",
      },
      auth: { accessToken: "access_123" } satisfies OutlookMailboxAuth,
      url: WEBHOOK_URL,
      events: ["inbound"],
    });

    expect(result.webhook).toMatchObject({
      id: "subscription_facade",
      emailDriver: "outlook",
      scope: "mailbox",
      providerId: "subscription_facade",
      status: "active",
    });
    expect(result.webhook.renewAfter).toEqual(
      new Date("2026-05-21T10:30:00.000Z"),
    );
  });

  it("validates the default clientState used for manually created Outlook webhooks", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "subscription_default",
            notificationUrl: "https://app.example.com/api/email/outlook",
            expirationDateTime: "2026-05-21T11:00:00.000Z",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "message_123",
            subject: "Default state",
            body: { contentType: "text", content: "Hello" },
            from: { emailAddress: { address: "sender@example.com" } },
            toRecipients: [
              { emailAddress: { address: "support@example.com" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      webhookAuth: { accessToken: "access_123" },
    });

    await driver.webhooks!.mailbox!.setup!({
      mailbox: { id: "user_123", email: "support@example.com" },
      auth: { accessToken: "access_123" } satisfies OutlookMailboxAuth,
      url: WEBHOOK_URL,
      events: ["inbound"],
    });
    const setupBody = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    const clientState = setupBody.clientState as string;
    expect(clientState).toMatch(/^emailkit:/);

    await expect(
      driver.handleWebhook({
        method: "POST",
        headers: {},
        body: {
          value: [
            {
              subscriptionId: "subscription_default",
              clientState: "wrong_state",
              changeType: "created",
              resource: "me/messages/message_123",
              resourceData: {
                "@odata.type": "#Microsoft.Graph.Message",
                id: "message_123",
              },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_WEBHOOK_CLIENT_STATE" });

    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        value: [
          {
            subscriptionId: "subscription_default",
            clientState,
            changeType: "created",
            resource: "me/messages/message_123",
            resourceData: {
              "@odata.type": "#Microsoft.Graph.Message",
              id: "message_123",
            },
          },
        ],
      },
    });

    expect(event).toMatchObject({
      type: "inbound",
      data: { subject: "Default state" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes mailbox-scoped Outlook webhooks by renewing Graph subscriptions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "subscription_123",
          changeType: "created",
          resource: "me/messages",
          notificationUrl: "https://app.example.com/api/email/outlook",
          expirationDateTime: "2026-05-24T10:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    const result = await driver.webhooks!.mailbox!.refresh!({
      providerId: "subscription_123",
      mailbox: {
        id: "user_123",
        email: "support@example.com",
      },
      auth: { accessToken: "access_123" } satisfies OutlookMailboxAuth,
      webhook: {
        id: "local_webhook_123",
        scope: "mailbox",
        url: "https://app.example.com/api/email/outlook",
        events: ["inbound"],
        status: "active",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/subscriptions/subscription_123",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          Authorization: "Bearer access_123",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      expirationDateTime: "2026-05-24T10:00:00.000Z",
    });
    expect(result.webhook).toMatchObject({
      id: "subscription_123",
      emailDriver: "outlook",
      scope: "mailbox",
      url: "https://app.example.com/api/email/outlook",
      events: ["inbound"],
      status: "active",
      providerId: "subscription_123",
    });
    expect(result.webhook.renewAfter).toEqual(
      new Date("2026-05-24T09:00:00.000Z"),
    );
  });

  it("refreshes persisted mailbox webhooks with webhook provider id and auth", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "subscription_123",
          notificationUrl: "https://app.example.com/api/email/outlook",
          expirationDateTime: "2026-05-21T11:30:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      inboundSubscriptionMinutes: 90,
    });

    const result = await driver.webhooks!.mailbox!.refresh!({
      mailbox: {
        id: "user_123",
        email: "support@example.com",
      },
      auth: { accessToken: "access_123" } satisfies OutlookMailboxAuth,
      webhook: {
        id: "local_webhook_123",
        providerId: "subscription_123",
        scope: "mailbox",
        url: "https://app.example.com/api/email/outlook",
        events: ["inbound"],
        status: "active",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/subscriptions/subscription_123",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          Authorization: "Bearer access_123",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      expirationDateTime: "2026-05-21T11:30:00.000Z",
    });
    expect(result.webhook).toMatchObject({
      id: "subscription_123",
      emailDriver: "outlook",
      scope: "mailbox",
      providerId: "subscription_123",
      url: "https://app.example.com/api/email/outlook",
      events: ["inbound"],
      status: "active",
    });
    expect(result.webhook.renewAfter).toEqual(
      new Date("2026-05-21T10:45:00.000Z"),
    );
  });

  it("deletes mailbox-scoped Outlook webhooks by deleting Graph subscriptions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    const result = await driver.webhooks!.mailbox!.delete!({
      providerId: "subscription_123",
      mailbox: {
        id: "user_123",
        email: "support@example.com",
      },
      auth: {
        accessToken: "access_123",
        tokenType: "Bearer",
      } satisfies OutlookMailboxAuth,
      webhook: {
        id: "local_webhook_123",
        providerId: "subscription_123",
        scope: "mailbox",
        url: "https://app.example.com/api/email/outlook",
        events: ["inbound"],
        status: "active",
      },
      context: { tenantId: "tenant_123" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/subscriptions/subscription_123",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer access_123",
        },
      },
    );
    expect(result).toMatchObject({
      deleted: true,
      context: { tenantId: "tenant_123" },
      webhook: {
        id: "local_webhook_123",
        emailDriver: "outlook",
        scope: "mailbox",
        url: "https://app.example.com/api/email/outlook",
        events: ["inbound"],
        status: "deleted",
        providerId: "subscription_123",
      },
    });
  });

  it("deletes persisted mailbox webhooks with webhook provider id and auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    const result = await driver.webhooks!.mailbox!.delete!({
      mailbox: {
        id: "user_123",
        email: "support@example.com",
      },
      auth: {
        accessToken: "access_123",
        tokenType: "Bearer",
      } satisfies OutlookMailboxAuth,
      webhook: {
        id: "local_webhook_123",
        providerId: "subscription_123",
        scope: "mailbox",
        url: "https://app.example.com/api/email/outlook",
        events: ["inbound"],
        status: "active",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/subscriptions/subscription_123",
      {
        method: "DELETE",
        headers: {
          Authorization: "Bearer access_123",
        },
      },
    );
    expect(result.webhook).toMatchObject({
      id: "local_webhook_123",
      emailDriver: "outlook",
      scope: "mailbox",
      providerId: "subscription_123",
      status: "deleted",
    });
  });

  it("falls back to userPrincipalName when Microsoft /me mail is null", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access_123",
            refresh_token: "refresh_123",
            expires_in: 3600,
            scope: "offline_access User.Read Mail.Send Mail.Read",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "user_123",
            mail: null,
            userPrincipalName: "support@tenant.example",
            displayName: "Support Team",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

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

    expect(callback.mailbox?.email).toBe("support@tenant.example");
  });

  it("rejects expired encrypted OAuth state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const driver = createDriver();
    const connect = await driver.mailboxes!.connect!(
      connectInput({ context: { tenantId: "tenant_123" } }),
      { secret: "emailkit-secret" },
    );

    vi.setSystemTime(new Date("2026-05-21T10:11:00.000Z"));

    await expect(
      driver.handleCallback!(
        {
          method: "GET",
          headers: {},
          query: { code: "code_123", state: connect.state! },
          body: null,
        },
        { secret: "emailkit-secret" },
      ),
    ).rejects.toThrow("state has expired");
  });

  it("rejects tampered OAuth state and state encrypted with another secret", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();
    const connect = await driver.mailboxes!.connect!(
      connectInput({ context: { tenantId: "tenant_123" } }),
      { secret: "emailkit-secret" },
    );
    const state = connect.state!;
    const stateParts = state.split(".");
    stateParts[1] = `${stateParts[1]!.startsWith("A") ? "B" : "A"}${stateParts[1]!.slice(
      1,
    )}`;
    const tamperedState = stateParts.join(".");

    await expect(
      driver.handleCallback!(
        {
          method: "GET",
          headers: {},
          query: { code: "code_123", state: tamperedState },
          body: null,
        },
        { secret: "emailkit-secret" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });

    await expect(
      driver.handleCallback!(
        {
          method: "GET",
          headers: {},
          query: { code: "code_123", state },
          body: null,
        },
        { secret: "wrong-secret" },
      ),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects OAuth callbacks missing code or state before calling Microsoft", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();
    const connect = await driver.mailboxes!.connect!(connectInput(), {
      secret: "emailkit-secret",
    });

    await expect(
      driver.handleCallback!(
        {
          method: "GET",
          headers: {},
          query: { state: connect.state! },
          body: null,
        },
        { secret: "emailkit-secret" },
      ),
    ).rejects.toThrow("Missing Outlook OAuth code");

    await expect(
      driver.handleCallback!(
        {
          method: "GET",
          headers: {},
          query: { code: "code_123" },
          body: null,
        },
        { secret: "emailkit-secret" },
      ),
    ).rejects.toThrow("Missing Outlook OAuth state");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates Microsoft token endpoint error bodies", async () => {
    const errorBody = {
      error: "invalid_grant",
      error_description: "Authorization code is invalid or expired",
      trace_id: "trace_123",
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(errorBody), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();
    const connect = await driver.mailboxes!.connect!(connectInput(), {
      secret: "emailkit-secret",
    });

    await expect(
      driver.handleCallback!(
        {
          method: "GET",
          headers: {},
          query: { code: "bad_code", state: connect.state! },
          body: null,
        },
        { secret: "emailkit-secret" },
      ),
    ).rejects.toMatchObject({
      message: "Authorization code is invalid or expired",
      httpStatus: 400,
      raw: errorBody,
    });
  });

  it("maps EmailKit messages to Microsoft Graph sendMail payloads", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(undefined, {
        status: 202,
        headers: { "request-id": "req_123" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    const result = await driver.sendEmail(
      {
        from: { email: "support@example.com", name: "Support" },
        to: [
          { email: "first@example.com", name: "First" },
          { email: "second@example.com" },
        ],
        cc: { email: "copy@example.com" },
        bcc: { email: "blind@example.com" },
        reply: { addresses: [{ email: "reply@example.com", name: "Replies" }] },
        subject: "Hello",
        text: "Plain text",
        html: "<p>Hello</p>",
        attachments: [
          {
            filename: "receipt.txt",
            content: "paid",
            contentType: "text/plain",
          },
        ],
        headers: {
          "X-Campaign": "welcome",
        },
      },
      {
        auth: {
          accessToken: "access_123",
          refreshToken: "refresh_123",
          expiresAt: Date.now() + 120_000,
          tokenType: "Bearer",
        } satisfies OutlookMailboxAuth,
      },
    );

    expect(result).toMatchObject({
      messageId: "req_123",
      provider: "outlook",
      requestId: "req_123",
      receiptId: "req_123",
    });
    expect(result.providerId).toBeUndefined();
    expect(result.threadId).toBeUndefined();
    expect((result as OutlookSendEmailResult).raw?.messageIdKind).toBe(
      "sendReceipt",
    );
    expect(
      (result as OutlookSendEmailResult).raw?.skippedHeaders,
    ).toBeUndefined();

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(init!.headers).toMatchObject({
      Authorization: "Bearer access_123",
      "Content-Type": "application/json",
    });
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      message: {
        subject: "Hello",
        from: {
          emailAddress: { address: "support@example.com", name: "Support" },
        },
        body: { contentType: "HTML", content: "<p>Hello</p>" },
        toRecipients: [
          { emailAddress: { address: "first@example.com", name: "First" } },
          { emailAddress: { address: "second@example.com" } },
        ],
        ccRecipients: [{ emailAddress: { address: "copy@example.com" } }],
        bccRecipients: [{ emailAddress: { address: "blind@example.com" } }],
        replyTo: [
          { emailAddress: { address: "reply@example.com", name: "Replies" } },
        ],
        internetMessageHeaders: [{ name: "X-Campaign", value: "welcome" }],
        attachments: [
          {
            "@odata.type": "#microsoft.graph.fileAttachment",
            name: "receipt.txt",
            contentType: "text/plain",
            contentBytes: "cGFpZA==",
          },
        ],
      },
    });
    expect(body).not.toHaveProperty("saveToSentItems");
    expect(body.message).not.toHaveProperty("sender");
  });

  it("can send through a draft to return a stable Graph message id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "immutable_message_123",
            internetMessageId: "<message_123@example.com>",
            isDraft: true,
          }),
          {
            status: 201,
            headers: {
              "content-type": "application/json",
              "request-id": "create_req_123",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(undefined, {
          status: 202,
          headers: { "request-id": "send_req_123" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      sendEmailMode: "draft",
      scopes: ["offline_access", "User.Read", "Mail.Send", "Mail.ReadWrite"],
    });

    const result = (await driver.sendEmail(
      {
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        text: "Hello",
        headers: {
          "X-Correlation-Id": "send_123",
        },
      },
      {
        auth: {
          accessToken: "access_123",
          expiresAt: Date.now() + 120_000,
        } satisfies OutlookMailboxAuth,
      },
    )) as OutlookSendEmailResult;

    expect(result).toMatchObject({
      messageId: "immutable_message_123",
      provider: "outlook",
      requestId: "send_req_123",
      receiptId: "send_req_123",
      providerId: "immutable_message_123",
    });
    expect(result.raw?.messageIdKind).toBe("graphMessageId");

    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(createUrl).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect(createInit!.headers).toMatchObject({
      Authorization: "Bearer access_123",
      "Content-Type": "application/json",
      Prefer: 'IdType="ImmutableId"',
    });
    expect(JSON.parse(String(createInit!.body))).toMatchObject({
      subject: "Hello",
      from: { emailAddress: { address: "support@example.com" } },
      body: { contentType: "Text", content: "Hello" },
      toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
      internetMessageHeaders: [{ name: "X-Correlation-Id", value: "send_123" }],
    });

    const [sendUrl, sendInit] = fetchMock.mock.calls[1]!;
    expect(sendUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/immutable_message_123/send",
    );
    expect(sendInit!.headers).toMatchObject({
      Authorization: "Bearer access_123",
      Prefer: 'IdType="ImmutableId"',
    });
    expect(sendInit!.body).toBeUndefined();
  });

  it("threads draft replies natively through Graph createReply when the source message is found", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: "source_message_123",
                internetMessageId: "<previous@example.com>",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "reply_draft_123",
            conversationId: "conversation_123",
            isDraft: true,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "reply_draft_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(undefined, {
          status: 202,
          headers: { "request-id": "send_req_123" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ sendEmailMode: "draft" });

    const result = (await driver.sendEmail(
      {
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        cc: { email: "copy@example.com" },
        subject: "Re: Hello",
        html: "<p>Reply</p>",
        reply: { messageId: "previous@example.com" },
      },
      {
        auth: {
          accessToken: "access_123",
          expiresAt: Date.now() + 120_000,
        } satisfies OutlookMailboxAuth,
      },
    )) as OutlookSendEmailResult;

    expect(result).toMatchObject({
      messageId: "reply_draft_123",
      provider: "outlook",
      providerId: "reply_draft_123",
      threadId: "conversation_123",
      replyThreading: "applied",
      requestId: "send_req_123",
      receiptId: "send_req_123",
    });
    expect(result.raw?.messageIdKind).toBe("graphMessageId");

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [lookupUrl, lookupInit] = fetchMock.mock.calls[0]!;
    expect(lookupUrl).toBe(
      `https://graph.microsoft.com/v1.0/me/messages?$filter=${encodeURIComponent(
        "internetMessageId eq '<previous@example.com>'",
      )}&$select=id,internetMessageId`,
    );
    expect(lookupInit!.method).toBe("GET");
    expect(lookupInit!.headers).toMatchObject({
      Authorization: "Bearer access_123",
      Prefer: 'IdType="ImmutableId"',
    });

    const [createReplyUrl, createReplyInit] = fetchMock.mock.calls[1]!;
    expect(createReplyUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/source_message_123/createReply",
    );
    expect(createReplyInit!.method).toBe("POST");
    expect(createReplyInit!.headers).toMatchObject({
      Authorization: "Bearer access_123",
      Prefer: 'IdType="ImmutableId"',
    });
    expect(createReplyInit!.body).toBeUndefined();

    const [patchUrl, patchInit] = fetchMock.mock.calls[2]!;
    expect(patchUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/reply_draft_123",
    );
    expect(patchInit!.method).toBe("PATCH");
    expect(JSON.parse(String(patchInit!.body))).toMatchObject({
      subject: "Re: Hello",
      from: { emailAddress: { address: "support@example.com" } },
      body: { contentType: "HTML", content: "<p>Reply</p>" },
      toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
      ccRecipients: [{ emailAddress: { address: "copy@example.com" } }],
    });

    const [sendUrl, sendInit] = fetchMock.mock.calls[3]!;
    expect(sendUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/reply_draft_123/send",
    );
    expect(sendInit!.method).toBe("POST");
  });

  it("uploads reply draft attachments individually because Graph PATCH rejects attachments", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: "source_message_123",
                internetMessageId: "<previous@example.com>",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "reply_draft_123" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(undefined, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "attachment_1" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "attachment_2" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(undefined, {
          status: 202,
          headers: { "request-id": "send_req_123" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ sendEmailMode: "draft" });

    const result = await driver.sendEmail(
      {
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Re: Hello",
        text: "Reply",
        reply: { messageId: "<previous@example.com>" },
        attachments: [
          { filename: "first.txt", content: "one", contentType: "text/plain" },
          { filename: "second.txt", content: "two", contentType: "text/plain" },
        ],
      },
      {
        auth: {
          accessToken: "access_123",
          expiresAt: Date.now() + 120_000,
        } satisfies OutlookMailboxAuth,
      },
    );

    expect(result.replyThreading).toBe("applied");
    expect(fetchMock).toHaveBeenCalledTimes(6);

    const patchBody = JSON.parse(String(fetchMock.mock.calls[2]![1]!.body));
    expect(patchBody).not.toHaveProperty("attachments");

    const [firstAttachmentUrl, firstAttachmentInit] = fetchMock.mock.calls[3]!;
    expect(firstAttachmentUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/reply_draft_123/attachments",
    );
    expect(firstAttachmentInit!.method).toBe("POST");
    expect(JSON.parse(String(firstAttachmentInit!.body))).toMatchObject({
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: "first.txt",
      contentType: "text/plain",
      contentBytes: "b25l",
    });
    expect(JSON.parse(String(fetchMock.mock.calls[4]![1]!.body))).toMatchObject(
      { name: "second.txt", contentBytes: "dHdv" },
    );

    const [sendUrl] = fetchMock.mock.calls[5]!;
    expect(sendUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/reply_draft_123/send",
    );
  });

  it("falls back to an unthreaded draft send when the reply source lookup does not verifiably match", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: "unrelated_message_123",
                internetMessageId: "<unrelated@example.com>",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "draft_123" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(undefined, {
          status: 202,
          headers: { "request-id": "send_req_123" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ sendEmailMode: "draft" });

    const result = await driver.sendEmail(
      {
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Re: Hello",
        text: "Reply",
        reply: { messageId: "<previous@example.com>" },
      },
      {
        auth: {
          accessToken: "access_123",
          expiresAt: Date.now() + 120_000,
        } satisfies OutlookMailboxAuth,
      },
    );

    expect(result).toMatchObject({
      messageId: "draft_123",
      providerId: "draft_123",
      replyThreading: "skipped",
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [createUrl, createInit] = fetchMock.mock.calls[1]!;
    expect(createUrl).toBe("https://graph.microsoft.com/v1.0/me/messages");
    expect(JSON.parse(String(createInit!.body))).toMatchObject({
      subject: "Re: Hello",
      toRecipients: [{ emailAddress: { address: "recipient@example.com" } }],
    });
    const [sendUrl] = fetchMock.mock.calls[2]!;
    expect(sendUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/draft_123/send",
    );
  });

  it("rejects custom headers combined with native reply threading because Graph createReply cannot carry them", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ sendEmailMode: "draft" });

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Re: Hello",
          text: "Reply",
          reply: { messageId: "<previous@example.com>" },
          headers: {
            "X-Correlation-Id": "send_123",
            "X-Campaign": "welcome",
          },
        },
        {
          auth: {
            accessToken: "access_123",
            expiresAt: Date.now() + 120_000,
          } satisfies OutlookMailboxAuth,
        },
      ),
    ).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message:
        "Outlook cannot combine custom headers with native reply threading: Microsoft Graph createReply does not accept internetMessageHeaders. Send without reply.messageId or without headers.",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the reply draft when the send itself fails because the message may already be out", async () => {
    const errorBody = {
      error: { code: "ErrorSendAsDenied", message: "Send denied" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: "source_message_123",
                internetMessageId: "<previous@example.com>",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "reply_draft_123" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(undefined, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(errorBody), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ sendEmailMode: "draft" });

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Re: Hello",
          text: "Reply",
          reply: { messageId: "<previous@example.com>" },
        },
        {
          auth: {
            accessToken: "access_123",
            expiresAt: Date.now() + 120_000,
          } satisfies OutlookMailboxAuth,
        },
      ),
    ).rejects.toMatchObject({
      message: "Send denied",
      httpStatus: 403,
      raw: errorBody,
    });

    // No DELETE after a /send attempt: an ambiguous send failure may still
    // have delivered the message, and the draft id would then point at the
    // Sent Items copy.
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it("deletes the reply draft when the PATCH fails before the send attempt", async () => {
    const errorBody = {
      error: { code: "ErrorInvalidRequest", message: "Patch rejected" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: "source_message_123",
                internetMessageId: "<previous@example.com>",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "reply_draft_123" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(errorBody), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(new Error("cleanup network error"));
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ sendEmailMode: "draft" });

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Re: Hello",
          text: "Reply",
          reply: { messageId: "<previous@example.com>" },
        },
        {
          auth: {
            accessToken: "access_123",
            expiresAt: Date.now() + 120_000,
          } satisfies OutlookMailboxAuth,
        },
      ),
    ).rejects.toMatchObject({
      message: "Patch rejected",
      httpStatus: 400,
      raw: errorBody,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[3]!;
    expect(deleteUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/reply_draft_123",
    );
    expect(deleteInit!.method).toBe("DELETE");
    expect(deleteInit!.headers).toMatchObject({
      Authorization: "Bearer access_123",
      Prefer: 'IdType="ImmutableId"',
    });
  });

  it("deletes the reply draft when an attachment upload fails before the send attempt", async () => {
    const errorBody = {
      error: { code: "ErrorAttachmentSizeLimit", message: "Attachment denied" },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: "source_message_123",
                internetMessageId: "<previous@example.com>",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "reply_draft_123" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(undefined, { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(errorBody), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(undefined, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ sendEmailMode: "draft" });

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Re: Hello",
          text: "Reply",
          reply: { messageId: "<previous@example.com>" },
          attachments: [
            {
              filename: "first.txt",
              content: "one",
              contentType: "text/plain",
            },
          ],
        },
        {
          auth: {
            accessToken: "access_123",
            expiresAt: Date.now() + 120_000,
          } satisfies OutlookMailboxAuth,
        },
      ),
    ).rejects.toMatchObject({
      message: "Attachment denied",
      httpStatus: 403,
      raw: errorBody,
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[4]!;
    expect(deleteUrl).toBe(
      "https://graph.microsoft.com/v1.0/me/messages/reply_draft_123",
    );
    expect(deleteInit!.method).toBe("DELETE");
    expect(deleteInit!.headers).toMatchObject({
      Authorization: "Bearer access_123",
      Prefer: 'IdType="ImmutableId"',
    });
  });

  it("keeps the plain draft when a non-reply draft send fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "draft_123" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "Send failed" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ sendEmailMode: "draft" });

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Hello",
          text: "Hello",
        },
        {
          auth: {
            accessToken: "access_123",
            expiresAt: Date.now() + 120_000,
          } satisfies OutlookMailboxAuth,
        },
      ),
    ).rejects.toMatchObject({ message: "Send failed", httpStatus: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
    ).toBe(false);
  });

  it("rejects reply.references and reply.threadId even in draft send mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ sendEmailMode: "draft" });
    const auth = {
      accessToken: "access_123",
      expiresAt: Date.now() + 120_000,
    } satisfies OutlookMailboxAuth;

    for (const reply of [
      { references: ["<previous@example.com>"] },
      { threadId: "conversation_123" },
    ]) {
      await expect(
        driver.sendEmail(
          {
            from: { email: "support@example.com" },
            to: { email: "recipient@example.com" },
            subject: "Re: Hello",
            text: "Reply",
            reply,
          } as Parameters<typeof driver.sendEmail>[0],
          { auth },
        ),
      ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects reply.messageId in sendMail mode because Graph cannot thread without the draft flow", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Re: Hello",
          text: "Reply",
          reply: { messageId: "<previous@example.com>" },
        },
        {
          auth: {
            accessToken: "access_123",
            expiresAt: Date.now() + 120_000,
          } satisfies OutlookMailboxAuth,
        },
      ),
    ).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message:
        'Outlook native reply threading via reply.messageId requires draft send mode. Configure sendEmailMode: "draft" (Mail.ReadWrite) to send threaded replies.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("propagates Microsoft Graph error bodies", async () => {
    const errorBody = {
      error: {
        code: "ErrorAccessDenied",
        message: "Access is denied",
      },
    };
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(errorBody), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Hello",
          text: "Hello",
        },
        {
          auth: {
            accessToken: "access_123",
            expiresAt: Date.now() + 120_000,
          } satisfies OutlookMailboxAuth,
        },
      ),
    ).rejects.toMatchObject({
      message: "Access is denied",
      httpStatus: 403,
      raw: errorBody,
    });
  });

  it("rejects Outlook send fields that Graph sendMail cannot honestly support", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();
    const auth = {
      accessToken: "access_123",
      expiresAt: Date.now() + 120_000,
    } satisfies OutlookMailboxAuth;

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Hello",
          text: "Hello",
          headers: { "List-Unsubscribe": "<mailto:unsubscribe@example.com>" },
        },
        { auth },
      ),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });

    for (const unsupported of [
      { track: { opens: true } },
      { tags: [{ name: "campaign", value: "welcome" }] },
      { metadata: { campaign: "welcome" } },
      { sendAt: new Date("2026-05-22T12:00:00.000Z") },
      { templateId: "template_123" },
      { templateData: { name: "Ada" } },
      { sandbox: true },
      { idempotencyKey: "send_123" },
    ]) {
      await expect(
        driver.sendEmail(
          {
            from: { email: "support@example.com" },
            to: { email: "recipient@example.com" },
            subject: "Hello",
            text: "Hello",
            ...unsupported,
          } as Parameters<typeof driver.sendEmail>[0],
          { auth },
        ),
      ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    }

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Hello",
          text: "Hello",
          reply: { messageId: "<previous@example.com>" },
        } as Parameters<typeof driver.sendEmail>[0],
        { auth },
      ),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });

    await expect(
      driver.sendEmail(
        {
          from: { email: "other@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Hello",
          text: "Hello",
        },
        { auth, mailbox: { id: "user_123", email: "support@example.com" } },
      ),
    ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sets saveToSentItems only when explicitly false", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(undefined, {
          status: 202,
          headers: { "request-id": "req_false" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(undefined, {
          status: 202,
          headers: { "request-id": "req_true" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    await driver.sendEmail(
      {
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        text: "Hello",
        provider: { saveToSentItems: false },
      },
      {
        auth: {
          accessToken: "access_123",
          expiresAt: Date.now() + 120_000,
        } satisfies OutlookMailboxAuth,
      },
    );

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]!.body));
    expect(body).toMatchObject({ saveToSentItems: false });

    await driver.sendEmail(
      {
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        text: "Hello",
        provider: { saveToSentItems: true },
      },
      {
        auth: {
          accessToken: "access_123",
          expiresAt: Date.now() + 120_000,
        } satisfies OutlookMailboxAuth,
      },
    );

    const trueBody = JSON.parse(String(fetchMock.mock.calls[1]![1]!.body));
    expect(trueBody).not.toHaveProperty("saveToSentItems");
  });

  it("rejects saveToSentItems false in draft send mode", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ sendEmailMode: "draft" });

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Hello",
          text: "Hello",
          provider: { saveToSentItems: false },
        },
        {
          auth: {
            accessToken: "access_123",
            expiresAt: Date.now() + 120_000,
          } satisfies OutlookMailboxAuth,
        },
      ),
    ).rejects.toMatchObject({
      code: "NOT_SUPPORTED",
      message:
        'Outlook draft send mode always saves to Sent Items. Use sendEmailMode: "sendMail" when provider.saveToSentItems is false.',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects sendEmail without mailbox auth", async () => {
    const driver = createDriver();

    await expect(
      driver.sendEmail({
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        text: "Hello",
      }),
    ).rejects.toThrow("requires mailbox auth");
  });

  it("refreshes expired access tokens, reports updated auth, and sends with the new access token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const onAuthUpdated = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access_new",
            refresh_token: "refresh_new",
            expires_in: 7200,
            scope: "offline_access User.Read Mail.Send",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(undefined, {
          status: 202,
          headers: { "request-id": "req_refresh" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    const result = (await driver.sendEmail(
      {
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        text: "Hello",
      },
      {
        auth: {
          accessToken: "access_old",
          refreshToken: "refresh_old",
          expiresAt: Date.parse("2026-05-21T09:59:00.000Z"),
          scopes: ["offline_access", "User.Read", "Mail.Send"],
          tokenType: "Bearer",
        } satisfies OutlookMailboxAuth,
        onAuthUpdated,
      },
    )) as OutlookSendEmailResult;

    const previousAuth = {
      accessToken: "access_old",
      refreshToken: "refresh_old",
      expiresAt: Date.parse("2026-05-21T09:59:00.000Z"),
      scopes: ["offline_access", "User.Read", "Mail.Send"],
      tokenType: "Bearer",
    };
    const refreshBody = fetchMock.mock.calls[0]![1]!.body as URLSearchParams;
    expect(refreshBody.get("client_id")).toBe("client_123");
    expect(refreshBody.get("client_secret")).toBe("secret_123");
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("refresh_old");
    expect(refreshBody.get("scope")).toBe("offline_access User.Read Mail.Send");
    expect(fetchMock.mock.calls[1]![1]!.headers).toMatchObject({
      Authorization: "Bearer access_new",
    });
    expect(onAuthUpdated).toHaveBeenCalledWith({
      auth: {
        accessToken: "access_new",
        refreshToken: "refresh_new",
        expiresAt: Date.parse("2026-05-21T12:00:00.000Z"),
        scopes: ["offline_access", "User.Read", "Mail.Send"],
        tokenType: "Bearer",
      },
      previousAuth,
    });
    expect(result.raw).not.toHaveProperty("auth");
  });

  it("does not refresh valid tokens or call onAuthUpdated", async () => {
    const onAuthUpdated = vi.fn();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(undefined, {
        status: 202,
        headers: { "request-id": "req_valid" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    await driver.sendEmail(
      {
        from: { email: "support@example.com" },
        to: { email: "recipient@example.com" },
        subject: "Hello",
        text: "Hello",
      },
      {
        auth: {
          accessToken: "access_valid",
          refreshToken: "refresh_valid",
          expiresAt: Date.now() + 120_000,
        } satisfies OutlookMailboxAuth,
        onAuthUpdated,
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://graph.microsoft.com/v1.0/me/sendMail",
    );
    expect(fetchMock.mock.calls[0]![1]!.headers).toMatchObject({
      Authorization: "Bearer access_valid",
    });
    expect(onAuthUpdated).not.toHaveBeenCalled();
  });

  it("aborts Graph send when onAuthUpdated rejects after refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const onAuthUpdated = vi
      .fn()
      .mockRejectedValue(new Error("persist failed"));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access_new",
          expires_in: 7200,
          scope: "offline_access User.Read Mail.Send",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    await expect(
      driver.sendEmail(
        {
          from: { email: "support@example.com" },
          to: { email: "recipient@example.com" },
          subject: "Hello",
          text: "Hello",
        },
        {
          auth: {
            accessToken: "access_old",
            refreshToken: "refresh_old",
            expiresAt: Date.parse("2026-05-21T09:59:00.000Z"),
            scopes: ["offline_access", "User.Read", "Mail.Send"],
          } satisfies OutlookMailboxAuth,
          onAuthUpdated,
        },
      ),
    ).rejects.toThrow("persist failed");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
  });

  it("returns Microsoft Graph validation token as plain text", async () => {
    const driver = createDriver();

    const response = await driver.webhookResponse!(
      {
        method: "POST",
        headers: {},
        query: { validationToken: "hello%20graph" },
        body: null,
      },
      true,
    );

    expect(response).toEqual({
      status: 200,
      body: "hello graph",
      headers: { "Content-Type": "text/plain" },
    });
  });

  it("returns Graph validation tokens before webhook parsing in the EmailKit handler", async () => {
    const driver = createDriver();
    const handleWebhook = vi.spyOn(driver, "handleWebhook");
    const emailkit = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
    });

    const response = await emailkit.handler()({
      method: "POST",
      headers: {},
      query: { validationToken: "token%20123" },
      body: "",
    });

    expect(handleWebhook).not.toHaveBeenCalled();
    expect(response).toEqual({
      status: 200,
      body: "token 123",
      headers: { "Content-Type": "text/plain" },
    });
  });

  it("hydrates Microsoft Graph message notifications into inbound email events", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "message_123",
          internetMessageId: "<message_123@example.com>",
          subject: "Need help",
          body: { contentType: "html", content: "<p>Hello</p>" },
          bodyPreview: "Hello",
          from: {
            emailAddress: {
              address: "sender@example.com",
              name: "Sender",
            },
          },
          toRecipients: [{ emailAddress: { address: "support@example.com" } }],
          ccRecipients: [
            { emailAddress: { address: "cc@example.com", name: "CC" } },
          ],
          replyTo: [{ emailAddress: { address: "reply@example.com" } }],
          receivedDateTime: "2026-05-21T10:30:00Z",
          conversationId: "thread_123",
          internetMessageHeaders: [
            { name: "In-Reply-To", value: "<previous@example.com>" },
            {
              name: "References",
              value: "<root@example.com> <previous@example.com>",
            },
          ],
          attachments: [
            {
              id: "attachment_123",
              name: "invoice.pdf",
              contentType: "application/pdf",
              size: 1234,
              isInline: false,
            },
            {
              id: "inline_123",
              name: "logo.png",
              contentType: "image/png",
              size: 456,
              isInline: true,
              contentId: "logo",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      webhookAuth: { accessToken: "access_123", tokenType: "Bearer" },
      webhookClientState: "state_123",
    });

    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: {
        value: [
          {
            subscriptionId: "sub_123",
            clientState: "state_123",
            changeType: "created",
            resource: "me/messages/message_123",
            tenantId: "tenant_123",
            resourceData: {
              "@odata.type": "#Microsoft.Graph.Message",
              "@odata.id": "me/messages/message_123",
              id: "message_123",
            },
          },
        ],
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toContain(
      "https://graph.microsoft.com/v1.0/me/messages/message_123?",
    );
    const decodedUrl = decodeURIComponent(String(url));
    expect(decodedUrl).toContain(
      "$expand=attachments($select=id,name,contentType,size,isInline)",
    );
    expect(decodedUrl).not.toContain("contentId");
    expect(init).toMatchObject({
      headers: {
        Authorization: "Bearer access_123",
        Accept: "application/json",
      },
    });
    expect(event.type).toBe("inbound");
    expect(event.data).toMatchObject({
      schemaVersion: "1",
      eventId: "sub_123:message_123:created",
      messageId: "<message_123@example.com>",
      providerId: "message_123",
      from: { email: "sender@example.com", name: "Sender" },
      to: [{ email: "support@example.com" }],
      cc: [{ email: "cc@example.com", name: "CC" }],
      reply: {
        addresses: [{ email: "reply@example.com" }],
        messageId: "<previous@example.com>",
        references: ["<root@example.com>", "<previous@example.com>"],
        threadId: "thread_123",
        isReply: true,
      },
      subject: "Need help",
      text: "Hello",
      html: "<p>Hello</p>",
      headers: {
        "in-reply-to": "<previous@example.com>",
        references: "<root@example.com> <previous@example.com>",
      },
    });
    expect(event.data.timestamp).toEqual(new Date("2026-05-21T10:30:00Z"));
    expect(event.data.attachments).toEqual([
      expect.objectContaining({
        filename: "invoice.pdf",
        contentType: "application/pdf",
        size: 1234,
        isInline: undefined,
        contentId: undefined,
        url: "https://graph.microsoft.com/v1.0/me/messages/message_123/attachments/attachment_123/$value",
        provider: {
          outlook: expect.objectContaining({
            notification: expect.objectContaining({
              subscriptionId: "sub_123",
            }),
          }),
        },
      }),
      expect.objectContaining({
        filename: "logo.png",
        contentType: "image/png",
        size: 456,
        isInline: true,
        contentId: "logo",
        url: "https://graph.microsoft.com/v1.0/me/messages/message_123/attachments/inline_123/$value",
        provider: {
          outlook: expect.objectContaining({
            notification: expect.objectContaining({
              subscriptionId: "sub_123",
            }),
          }),
        },
      }),
    ]);
  });

  it("uses the Outlook webhook auth resolver for mailbox-specific subscriptions", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "message_456",
          subject: "Plain",
          body: { contentType: "text", content: "Plain body" },
          from: { emailAddress: { address: "sender@example.com" } },
          toRecipients: [{ emailAddress: { address: "support@example.com" } }],
          receivedDateTime: "2026-05-21T11:00:00Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const resolver = vi
      .fn()
      .mockResolvedValue({ accessToken: "resolved_access" });
    const driver = createDriverWith({ webhookAuthResolver: resolver });
    const notification = {
      subscriptionId: "sub_resolved",
      clientState: "mailbox_123",
      resource: "users/user_123/messages/message_456",
      resourceData: {
        "@odata.type": "#Microsoft.Graph.Message",
        id: "message_456",
      },
    };

    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      query: { tenant: "tenant_123" },
      body: { value: [notification] },
    });

    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        notification,
        subscriptionId: "sub_resolved",
        clientState: "mailbox_123",
        query: { tenant: "tenant_123" },
      }),
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { Authorization: "Bearer resolved_access" },
    });
    expect(event).toMatchObject({
      type: "inbound",
      data: {
        messageId: "message_456",
        text: "Plain body",
      },
    });
  });

  it("rejects Microsoft Graph notifications with unexpected clientState", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      webhookAuth: { accessToken: "access_123" },
      webhookClientState: "expected_state",
    });

    await expect(
      driver.handleWebhook({
        method: "POST",
        headers: {},
        body: {
          value: [
            {
              subscriptionId: "sub_123",
              clientState: "wrong_state",
              changeType: "created",
              resource: "me/messages/message_123",
              resourceData: {
                "@odata.type": "#Microsoft.Graph.Message",
                id: "message_123",
              },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      code: "INVALID_WEBHOOK_CLIENT_STATE",
      httpStatus: 401,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects absolute non-Graph message resource URLs before sending auth", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      webhookAuth: { accessToken: "access_123" },
      webhookClientState: "state_123",
    });

    await expect(
      driver.handleWebhook({
        method: "POST",
        headers: {},
        body: {
          value: [
            {
              subscriptionId: "sub_123",
              clientState: "state_123",
              changeType: "created",
              resourceData: {
                "@odata.type": "#Microsoft.Graph.Message",
                "@odata.id": "https://attacker.example/messages/message_123",
                id: "message_123",
              },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: "INVALID_WEBHOOK_RESOURCE" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps non-created Graph message notifications unknown", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      webhookAuth: { accessToken: "access_123" },
    });
    const payload = {
      value: [
        {
          subscriptionId: "sub_123",
          changeType: "updated",
          resource: "me/messages/message_123",
          resourceData: {
            "@odata.type": "#Microsoft.Graph.Message",
            id: "message_123",
          },
        },
      ],
    };

    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: payload,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(event).toEqual({ type: "unknown", data: payload });
  });

  it("maps Microsoft Graph lifecycle notifications to webhook lifecycle events", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({ webhookClientState: "state_123" });
    const notifications = [
      {
        subscriptionId: "sub_reauth",
        clientState: "state_123",
        lifecycleEvent: "reauthorizationRequired",
        resource: "users/user_123/mailFolders('Inbox')/messages",
      },
      {
        subscriptionId: "sub_removed",
        clientState: "state_123",
        lifecycleEvent: "subscriptionRemoved",
        resource: "users/user_456/mailFolders('Inbox')/messages",
      },
      {
        subscriptionId: "sub_missed",
        clientState: "state_123",
        lifecycleEvent: "missed",
      },
    ];

    const result = await driver.handleWebhook({
      method: "POST",
      headers: {},
      query: { mailboxEmail: "support@example.com" },
      body: { value: notifications },
    });
    const events = Array.isArray(result) ? result : [result];

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      type: "webhook.lifecycle",
      data: {
        emailDriver: "outlook",
        action: "action_required",
        source: "provider",
        reason: "reauthorization_required",
        recommendedActions: ["renew"],
        scope: "mailbox",
        providerId: "sub_reauth",
        subscriptionId: "sub_reauth",
        webhookId: "sub_reauth",
        target: {
          mailboxEmail: "support@example.com",
          mailboxId: "user_123",
        },
        raw: notifications[0],
      },
    });
    expect(events[1]).toMatchObject({
      type: "webhook.lifecycle",
      data: {
        action: "deleted",
        source: "provider",
        reason: "subscription_removed",
        recommendedActions: ["delete_local", "recreate"],
        scope: "mailbox",
        status: "deleted",
        providerId: "sub_removed",
        subscriptionId: "sub_removed",
        target: {
          mailboxId: "user_456",
        },
      },
    });
    expect(events[2]).toMatchObject({
      type: "webhook.lifecycle",
      data: {
        action: "sync_required",
        source: "provider",
        reason: "notifications_missed",
        recommendedActions: ["sync"],
        scope: "mailbox",
        providerId: "sub_missed",
        subscriptionId: "sub_missed",
      },
    });
    expect(events[0]).toMatchObject({
      data: { receivedAt: expect.any(Date) },
    });
  });

  it("dispatches Microsoft Graph lifecycle notifications through EmailKit webhook hooks", async () => {
    const onAll = vi.fn();
    const onActionRequired = vi.fn();
    const driver = createDriverWith({ webhookClientState: "state_123" });
    const emailkit = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
      hooks: {
        webhook: {
          onAll,
          onActionRequired,
        },
      },
    });
    const notification = {
      subscriptionId: "sub_reauth",
      clientState: "state_123",
      lifecycleEvent: "reauthorizationRequired",
      resource: "users/user_123/mailFolders('Inbox')/messages",
    };

    const response = await emailkit.handler()({
      method: "POST",
      headers: {},
      query: { mailboxEmail: "support@example.com" },
      body: { value: [notification] },
    });

    expect(response).toEqual({
      status: 202,
      body: { success: true },
    });
    expect(onAll).toHaveBeenCalledTimes(1);
    expect(onActionRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        emailDriver: "outlook",
        action: "action_required",
        source: "provider",
        reason: "reauthorization_required",
        recommendedActions: ["renew"],
        scope: "mailbox",
        providerId: "sub_reauth",
        subscriptionId: "sub_reauth",
        target: {
          mailboxEmail: "support@example.com",
          mailboxId: "user_123",
        },
        raw: notification,
      }),
    );
  });

  it("auto-renews Outlook subscriptions on reauthorization lifecycle notifications by default when auth resolves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T10:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "sub_reauth",
          changeType: "created",
          resource: "me/messages",
          notificationUrl: "https://app.example.com/api/email/outlook",
          lifecycleNotificationUrl: "https://app.example.com/api/email/outlook",
          expirationDateTime: "2026-05-24T10:00:00.000Z",
          clientState: "state_123",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onUpdated = vi.fn();
    const onActionRequired = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ accessToken: "access_123" });
    const driver = createDriverWith({
      webhookAuthResolver: resolver,
      webhookClientState: "state_123",
    });
    const emailkit = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
      hooks: {
        webhook: {
          onUpdated,
          onActionRequired,
        },
      },
    });
    const notification = {
      subscriptionId: "sub_reauth",
      clientState: "state_123",
      lifecycleEvent: "reauthorizationRequired",
      resource: "users/user_123/mailFolders('Inbox')/messages",
    };

    const response = await emailkit.handler()({
      method: "POST",
      headers: {},
      query: { mailboxEmail: "support@example.com" },
      body: { value: [notification] },
    });

    expect(response).toEqual({
      status: 202,
      body: { success: true },
    });
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        notification,
        subscriptionId: "sub_reauth",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/subscriptions/sub_reauth",
      expect.objectContaining({
        method: "PATCH",
        headers: {
          Authorization: "Bearer access_123",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      expirationDateTime: "2026-05-24T10:00:00.000Z",
    });
    expect(onActionRequired).not.toHaveBeenCalled();
    expect(onUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        emailDriver: "outlook",
        action: "updated",
        source: "provider",
        reason: "renewed",
        recommendedActions: ["persist"],
        scope: "mailbox",
        providerId: "sub_reauth",
        subscriptionId: "sub_reauth",
        target: {
          mailboxEmail: "support@example.com",
          mailboxId: "user_123",
        },
        webhook: expect.objectContaining({
          id: "sub_reauth",
          providerId: "sub_reauth",
          expiresAt: new Date("2026-05-24T10:00:00.000Z"),
          renewAfter: new Date("2026-05-24T09:00:00.000Z"),
        }),
        raw: {
          notification,
          inboundSubscription: expect.objectContaining({
            id: "sub_reauth",
          }),
        },
      }),
    );
  });

  it("dispatches every inbound event in a Graph notification batch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "message_1",
            subject: "First",
            body: { contentType: "text", content: "First body" },
            from: { emailAddress: { address: "first@example.com" } },
            toRecipients: [
              { emailAddress: { address: "support@example.com" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "message_2",
            subject: "Second",
            body: { contentType: "text", content: "Second body" },
            from: { emailAddress: { address: "second@example.com" } },
            toRecipients: [
              { emailAddress: { address: "support@example.com" } },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onInbound = vi.fn();
    const emailkit = EmailKit({
      emailDrivers: [
        createDriverWith({
          webhookAuth: { accessToken: "access_123" },
          webhookClientState: "state_123",
        }),
      ],
      hooks: { email: { onInbound } },
      secret: "emailkit-secret",
    });

    const response = await emailkit.handler()({
      method: "POST",
      headers: {},
      body: {
        value: [
          {
            subscriptionId: "sub_123",
            clientState: "state_123",
            changeType: "created",
            resource: "me/messages/message_1",
            resourceData: {
              "@odata.type": "#Microsoft.Graph.Message",
              id: "message_1",
            },
          },
          {
            subscriptionId: "sub_123",
            clientState: "state_123",
            changeType: "created",
            resource: "me/messages/message_2",
            resourceData: {
              "@odata.type": "#Microsoft.Graph.Message",
              id: "message_2",
            },
          },
        ],
      },
    });

    expect(response.status).toBe(202);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onInbound).toHaveBeenCalledTimes(2);
    expect(onInbound.mock.calls.map(([event]) => event.subject)).toEqual([
      "First",
      "Second",
    ]);
  });

  it("keeps unsupported Graph outbound-style notifications unknown", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      webhookAuth: { accessToken: "access_123" },
    });
    const payload = {
      value: [
        {
          subscriptionId: "sub_123",
          changeType: "updated",
          resource: "me/sendMail",
          resourceData: { id: "message_123" },
        },
      ],
    };

    const event = await driver.handleWebhook({
      method: "POST",
      headers: {},
      body: payload,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(event).toEqual({
      type: "unknown",
      data: payload,
    });
  });

  it("fetches Graph attachment URLs with configured webhook auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("attachment-content", { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      webhookAuth: { accessToken: "access_123", tokenType: "Bearer" },
    });

    const response = await driver.providerFetch!(
      "/me/messages/message_123/attachments/attachment_123/$value",
      {
        headers: { Accept: "application/octet-stream" },
        searchParams: { format: "raw" },
      },
    );

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        "https://graph.microsoft.com/v1.0/me/messages/message_123/attachments/attachment_123/$value?format=raw",
      ),
      {
        headers: expect.any(Headers),
      },
    );
    const headers = fetchMock.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer access_123");
    expect(headers.get("Accept")).toBe("application/octet-stream");
  });

  it("rejects external providerFetch URLs before adding Graph auth", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriverWith({
      webhookAuth: { accessToken: "access_123", tokenType: "Bearer" },
    });

    await expect(
      driver.providerFetch!("https://example.com/collect"),
    ).rejects.toMatchObject({
      provider: "outlook",
      code: "INVALID_PROVIDER_FETCH_URL",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches Graph attachment URLs through the webhook auth resolver", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "message_123",
            subject: "With attachment",
            body: { contentType: "text", content: "Hello" },
            from: { emailAddress: { address: "sender@example.com" } },
            toRecipients: [
              { emailAddress: { address: "support@example.com" } },
            ],
            attachments: [
              {
                id: "attachment_123",
                name: "report.txt",
                contentType: "text/plain",
                size: 6,
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response("report", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const resolver = vi
      .fn()
      .mockResolvedValue({ accessToken: "resolved_access" });
    const driver = createDriverWith({ webhookAuthResolver: resolver });
    const emailkit = EmailKit({
      emailDrivers: [driver],
      secret: "emailkit-secret",
    });

    const handled = await driver.handleWebhook({
      method: "POST",
      headers: {},
      query: { tenant: "tenant_123" },
      body: {
        value: [
          {
            subscriptionId: "sub_attachment",
            clientState: "mailbox_123",
            changeType: "created",
            resource: "users/user_123/messages/message_123",
            resourceData: {
              "@odata.type": "#Microsoft.Graph.Message",
              id: "message_123",
            },
          },
        ],
      },
    });
    if (Array.isArray(handled) || handled.type !== "inbound") {
      throw new Error("Expected inbound event");
    }

    const content = await emailkit.attachments.getContent(
      handled.data.attachments![0]!,
    );

    expect(new TextDecoder().decode(content as Uint8Array)).toBe("report");
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({
        subscriptionId: "sub_attachment",
        clientState: "mailbox_123",
        query: { tenant: "tenant_123" },
      }),
    );
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      headers: expect.any(Headers),
    });
    const attachmentHeaders = fetchMock.mock.calls[1]![1]!.headers as Headers;
    expect(attachmentHeaders.get("Authorization")).toBe(
      "Bearer resolved_access",
    );
  });

  it("syncs mailbox messages through Graph list pagination oldest-first", async () => {
    const since = new Date("2026-06-01T00:00:00.000Z");
    const until = new Date("2026-06-03T00:00:00.000Z");
    const nextLink =
      "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: "message_1",
                internetMessageId: "<message_1@example.com>",
                subject: "First",
                body: { contentType: "html", content: "<p>First</p>" },
                bodyPreview: "First",
                from: {
                  emailAddress: {
                    address: "first@example.com",
                    name: "First Sender",
                  },
                },
                toRecipients: [
                  { emailAddress: { address: "support@example.com" } },
                ],
                receivedDateTime: "2026-06-01T10:00:00Z",
                conversationId: "thread_1",
                attachments: [
                  {
                    id: "attachment_1",
                    name: "invoice.pdf",
                    contentType: "application/pdf",
                    size: 1234,
                  },
                ],
              },
            ],
            "@odata.nextLink": nextLink,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: "message_2",
                internetMessageId: "<message_2@example.com>",
                subject: "Second",
                body: { contentType: "text", content: "Second body" },
                from: { emailAddress: { address: "second@example.com" } },
                toRecipients: [
                  { emailAddress: { address: "support@example.com" } },
                ],
                receivedDateTime: "2026-06-02T10:00:00Z",
              },
              {
                id: "sent_message",
                internetMessageId: "<sent_message@example.com>",
                subject: "Sent message",
                body: { contentType: "text", content: "Sent body" },
                from: { emailAddress: { address: "support@example.com" } },
                toRecipients: [
                  { emailAddress: { address: "customer@example.com" } },
                ],
                receivedDateTime: "2026-06-02T12:00:00Z",
              },
              {
                id: "sent_alias_message",
                internetMessageId: "<sent_alias_message@example.com>",
                subject: "Sent alias message",
                body: { contentType: "text", content: "Sent alias body" },
                from: { emailAddress: { address: "alias@example.com" } },
                toRecipients: [
                  { emailAddress: { address: "customer@example.com" } },
                ],
                receivedDateTime: "2026-06-02T13:00:00Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    const { events, result } = await drainSyncStream(
      driver.sync!.mailbox!(
        {
          mailbox: {
            id: "mailbox_123",
            email: "support@example.com",
            raw: { user: { mail: "alias@example.com" } },
          },
          since,
          until,
        },
        { auth: { accessToken: "access_123", tokenType: "Bearer" } },
      ),
    );

    expect(result).toEqual({ syncedFrom: since });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const listUrl = new URL(String(fetchMock.mock.calls[0]![0]));
    expect(`${listUrl.origin}${listUrl.pathname}`).toBe(
      "https://graph.microsoft.com/v1.0/me/messages",
    );
    expect(listUrl.searchParams.get("$filter")).toBe(
      "receivedDateTime ge 2026-06-01T00:00:00.000Z and receivedDateTime lt 2026-06-03T00:00:00.000Z",
    );
    expect(listUrl.searchParams.get("$orderby")).toBe("receivedDateTime asc");
    expect(listUrl.searchParams.get("$top")).toBe("50");
    expect(listUrl.searchParams.get("$select")).toContain("internetMessageId");
    expect(listUrl.searchParams.get("$expand")).toBe(
      "attachments($select=id,name,contentType,size,isInline)",
    );
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: {
        Authorization: "Bearer access_123",
        Accept: "application/json",
      },
    });
    expect(fetchMock.mock.calls[1]![0]).toBe(nextLink);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "inbound",
      data: {
        schemaVersion: "1",
        eventId: "sync:message_1",
        messageId: "<message_1@example.com>",
        providerId: "message_1",
        from: { email: "first@example.com", name: "First Sender" },
        to: [{ email: "support@example.com" }],
        reply: { threadId: "thread_1" },
        subject: "First",
        html: "<p>First</p>",
        timestamp: new Date("2026-06-01T10:00:00Z"),
        attachments: [
          {
            filename: "invoice.pdf",
            contentType: "application/pdf",
            size: 1234,
            url: "https://graph.microsoft.com/v1.0/me/messages/message_1/attachments/attachment_1/$value",
            provider: { outlook: {} },
          },
        ],
      },
    });
    expect(events[1]).toMatchObject({
      type: "inbound",
      data: {
        eventId: "sync:message_2",
        messageId: "<message_2@example.com>",
        subject: "Second",
        text: "Second body",
        timestamp: new Date("2026-06-02T10:00:00Z"),
      },
    });
  });

  it("refreshes expired mailbox auth before syncing and reports the new auth", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T10:00:00.000Z"));
    const onAuthUpdated = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access_new",
            refresh_token: "refresh_new",
            expires_in: 7200,
            scope: "offline_access User.Read Mail.Send Mail.Read",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    const { events, result } = await drainSyncStream(
      driver.sync!.mailbox!(
        {
          mailbox: { id: "user_123", email: "support@example.com" },
          since: new Date("2026-06-01T00:00:00.000Z"),
          until: new Date("2026-06-04T00:00:00.000Z"),
        },
        {
          auth: {
            accessToken: "access_old",
            refreshToken: "refresh_old",
            expiresAt: Date.parse("2026-06-04T09:59:00.000Z"),
            scopes: ["offline_access", "User.Read", "Mail.Send", "Mail.Read"],
            tokenType: "Bearer",
          } satisfies OutlookMailboxAuth,
          onAuthUpdated,
        },
      ),
    );

    expect(events).toEqual([]);
    expect(result).toEqual({
      syncedFrom: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    );
    const refreshBody = fetchMock.mock.calls[0]![1]!.body as URLSearchParams;
    expect(refreshBody.get("grant_type")).toBe("refresh_token");
    expect(refreshBody.get("refresh_token")).toBe("refresh_old");
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({
      headers: { Authorization: "Bearer access_new" },
    });
    expect(onAuthUpdated).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          accessToken: "access_new",
          refreshToken: "refresh_new",
        }),
        previousAuth: expect.objectContaining({ accessToken: "access_old" }),
        mailbox: { id: "user_123", email: "support@example.com" },
      }),
    );
  });

  it("wraps Graph sync listing failures in EmailKitError", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: { code: "ErrorAccessDenied", message: "Access is denied" },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = createDriver();

    const stream = driver.sync!.mailbox!(
      { email: "support@example.com", since: new Date("2026-06-01T00:00:00.000Z") },
      { auth: { accessToken: "access_123" } },
    );

    const error = await stream.next().catch((caught) => caught);
    expect(error).toBeInstanceOf(EmailKitError);
    expect(error).toMatchObject({
      provider: "outlook",
      httpStatus: 403,
      message: "Access is denied",
    });
  });

  it("replays synced Outlook messages through EmailKit inbound hooks with sync context", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          value: [
            {
              id: "message_1",
              internetMessageId: "<message_1@example.com>",
              subject: "First",
              body: { contentType: "text", content: "First body" },
              from: { emailAddress: { address: "first@example.com" } },
              toRecipients: [
                { emailAddress: { address: "support@example.com" } },
              ],
              receivedDateTime: "2026-06-01T10:00:00Z",
            },
            {
              id: "message_2",
              internetMessageId: "<message_2@example.com>",
              subject: "Second",
              body: { contentType: "text", content: "Second body" },
              from: { emailAddress: { address: "second@example.com" } },
              toRecipients: [
                { emailAddress: { address: "support@example.com" } },
              ],
              receivedDateTime: "2026-06-02T10:00:00Z",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onInbound = vi.fn();
    const onAll = vi.fn();
    const emailkit = EmailKit({
      emailDrivers: [createDriver()],
      hooks: { email: { onInbound, onAll } },
      secret: "emailkit-secret",
    });

    const since = new Date("2026-06-01T00:00:00.000Z");
    const result = await emailkit.mailboxes.sync({
      email: "support@example.com",
      auth: { accessToken: "access_123" },
      since,
      until: new Date("2026-06-03T00:00:00.000Z"),
      context: { tenantId: "tenant_123" },
    });

    expect(result).toEqual({ dispatched: 2, syncedFrom: since });
    expect(onInbound).toHaveBeenCalledTimes(2);
    expect(onInbound.mock.calls.map(([event]) => event.subject)).toEqual([
      "First",
      "Second",
    ]);
    expect(onInbound.mock.calls[0]![0]).toMatchObject({
      emailDriver: "outlook",
      messageId: "<message_1@example.com>",
    });
    expect(onAll).toHaveBeenCalledTimes(2);
    expect(onAll.mock.calls[0]![0]).toMatchObject({
      emailDriver: "outlook",
      type: "inbound",
      context: { tenantId: "tenant_123" },
    });
  });

  it("rejects the next page fetch when the abort signal fires between pages", async () => {
    const fetchMock = vi.fn(
      async (_url: string | URL, init?: RequestInit) => {
        // Real fetch rejects when called with an already-aborted signal.
        if (init?.signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        return new Response(
          JSON.stringify({
            value: [
              {
                id: "message_1",
                subject: "First",
                body: { contentType: "text", content: "First body" },
                from: { emailAddress: { address: "first@example.com" } },
                toRecipients: [
                  { emailAddress: { address: "support@example.com" } },
                ],
                receivedDateTime: "2026-06-01T10:00:00Z",
              },
            ],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=page2",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const driver = createDriver();

    const stream = driver.sync!.mailbox!(
      {
        email: "support@example.com",
        since: new Date("2026-06-01T00:00:00.000Z"),
        signal: controller.signal,
      },
      { auth: { accessToken: "access_123" } },
    );

    const first = await stream.next();
    expect(first.done).toBe(false);
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

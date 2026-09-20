import { afterEach, describe, expect, it, vi } from "vitest";

import { AIInbxDriver, EmailKit } from "../src";
import {
  API,
  WEBHOOK_SECRET,
  jsonResponse,
  signedWebhookRequest,
  webhookEnvelope,
} from "./aiinbx-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const mailbox = (
  id: string,
  address: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  provider: "google",
  space_id: null,
  address,
  name: "Acme Support",
  state: "active",
  state_reason: null,
  region: "eu-central-1",
  app_id: null,
  connected_at: "2026-09-01T10:00:00Z",
  last_sync_at: null,
  ...overrides,
});

const createClient = (hooks: Parameters<typeof EmailKit>[0]["hooks"] = {}) =>
  EmailKit({
    // No `secret`: AIInbx hosts the OAuth flow, so there is no signed state.
    emailDrivers: [
      AIInbxDriver({
        id: "aiinbx",
        apiKey: "ai_test",
        webhookSecret: WEBHOOK_SECRET,
      }),
    ],
    publicRoutes: {
      baseUrl: "https://app.example.com",
      connectLandingRoutes: { success: "/settings/mailboxes" },
    },
    hooks,
  });

describe("AIInbxDriver mailboxes", () => {
  it("creates a hosted connect URL carrying context in the metadata", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ url: "https://aiinbx.com/connect/session_1" }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onConnected = vi.fn();

    const connection = await createClient({
      mailbox: { onConnected },
    }).mailboxes.connect({
      emailDriver: "aiinbx",
      context: { userId: "user_8812" },
      provider: {
        provider: "google",
        backfill_days: 7,
        ref: "acme",
        metadata: { plan: "pro" },
      },
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.toString()).toBe(`${API}/mailboxes/connect`);
    expect(JSON.parse(init.body as string)).toEqual({
      provider: "google",
      backfill_days: 7,
      return_to: "https://app.example.com/settings/mailboxes",
      ref: "acme",
      metadata: { plan: "pro", emailkit_context: '{"userId":"user_8812"}' },
    });
    expect(connection).toMatchObject({
      redirectUrl: "https://aiinbx.com/connect/session_1",
      landingUrl: "https://app.example.com/settings/mailboxes",
    });
    // Landing back proves nothing — only the webhook fires onConnected.
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("rejects a context that does not fit a metadata value", async () => {
    vi.stubGlobal("fetch", vi.fn());

    await expect(
      createClient().mailboxes.connect({
        emailDriver: "aiinbx",
        context: { blob: "x".repeat(500) },
        provider: { provider: "google" },
      }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("dispatches mailbox webhooks to mailbox and webhook hooks", async () => {
    const onConnected = vi.fn();
    const onDeleted = vi.fn();
    const onActionRequired = vi.fn();
    const handler = createClient({
      mailbox: { onConnected, onDeleted },
      webhook: { onActionRequired },
    }).handler();
    const data = {
      mailbox_id: "mbx_1",
      address: "acme.support@gmail.com",
      provider: "google",
    };

    const events: Array<[string, Record<string, unknown>]> = [
      [
        "mailbox.connected",
        {
          ...data,
          app_id: null,
          ref: "acme",
          metadata: { emailkit_context: '{"userId":"user_8812"}' },
          reconnected: false,
        },
      ],
      // Hosted connect links carry a plain-string ref.
      ["mailbox.connected", { ...data, ref: "user_8812", reconnected: true }],
      ["mailbox.needs_reauth", { ...data, reason: "invalid_grant" }],
      [
        "mailbox.disconnected",
        {
          ...data,
          metadata: { emailkit_context: '{"userId":"user_8812"}' },
          reason: null,
        },
      ],
    ];
    for (const [type, payload] of events) {
      const response = await handler(
        signedWebhookRequest(webhookEnvelope(type, payload)),
      );
      expect(response.status).toBe(204);
    }

    expect(onConnected.mock.calls[0]![0]).toMatchObject({
      emailDriver: "aiinbx",
      mailbox: {
        id: "mbx_1",
        email: "acme.support@gmail.com",
        status: "connected",
      },
      context: { userId: "user_8812" },
    });
    expect(onConnected.mock.calls[1]![0].context).toBe("user_8812");
    expect(onActionRequired.mock.calls[0]![0]).toMatchObject({
      emailDriver: "aiinbx",
      scope: "mailbox",
      action: "action_required",
      reason: "reauthorization_required",
      recommendedActions: ["reauthorize"],
      target: { mailboxId: "mbx_1", mailboxEmail: "acme.support@gmail.com" },
    });
    expect(onDeleted.mock.calls[0]![0]).toMatchObject({
      mailbox: { id: "mbx_1", status: "disabled" },
      context: { userId: "user_8812" },
    });
  });

  it("lists, gets by address, and disconnects mailboxes", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (url.pathname === "/api/v2/mailboxes") {
        return jsonResponse({
          data: [
            mailbox("mbx_old", "acme.support@gmail.com", {
              state: "disconnected",
            }),
            mailbox("mbx_1", "acme.support@gmail.com"),
            mailbox("mbx_2", "sales@outlook.com", { state: "needs_reauth" }),
          ],
          next_cursor: null,
        });
      }
      return jsonResponse(
        mailbox(
          "mbx_1",
          "acme.support@gmail.com",
          init?.method === "DELETE" ? { state: "disconnected" } : {},
        ),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const onDeleted = vi.fn();
    const client = createClient({ mailbox: { onDeleted } });

    expect(
      await client.mailboxes.list({
        emailDriver: "aiinbx",
        status: "connected",
      }),
    ).toMatchObject([
      {
        id: "mbx_1",
        email: "acme.support@gmail.com",
        displayName: "Acme Support",
        status: "connected",
      },
    ]);

    expect(
      await client.mailboxes.get({
        emailDriver: "aiinbx",
        idOrEmail: "Acme.Support@gmail.com",
      }),
    ).toMatchObject({ id: "mbx_1" });

    expect(
      await client.mailboxes.delete({
        emailDriver: "aiinbx",
        idOrEmail: "mbx_1",
      }),
    ).toEqual({ deleted: true });
    const last = fetchMock.mock.calls.at(-1) as unknown as [URL, RequestInit];
    expect(last[0].toString()).toBe(`${API}/mailboxes/mbx_1`);
    expect(last[1].method).toBe("DELETE");
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });
});

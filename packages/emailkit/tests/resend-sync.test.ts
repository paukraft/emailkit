import { afterEach, describe, expect, it, vi } from "vitest";

import { EmailKit, EmailKitError, ResendDriver } from "../src";
import type { SyncStream, WebhookDriverEvent } from "../src";

afterEach(() => {
  vi.unstubAllGlobals();
});

const SINCE = new Date("2026-06-01T00:00:00.000Z");
const UNTIL = new Date("2026-06-10T00:00:00.000Z");

const CREATED_AT: Record<string, string> = {
  email_1: "2026-06-02T10:00:00.000Z",
  email_2: "2026-06-03T10:00:00.000Z",
  email_3: "2026-06-05T10:00:00.000Z",
};

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const listItem = (id: string, createdAt: string) => ({
  id,
  to: ["agent@example.com"],
  from: "Buyer <buyer@example.net>",
  created_at: createdAt,
  subject: `Subject ${id}`,
});

const receivedEmail = (id: string) => ({
  object: "email",
  id,
  to: ["agent@example.com"],
  from: "Buyer <buyer@example.net>",
  created_at: CREATED_AT[id],
  subject: `Subject ${id}`,
  html: `<p>${id}</p>`,
  text: id,
  headers: {},
  bcc: [],
  cc: [],
  reply_to: [],
  message_id: `<${id}@example.net>`,
  attachments: [],
});

/**
 * Mocks GET /emails/receiving (newest-first, cursor pagination) plus the
 * per-email detail and attachment endpoints used by inbound normalization.
 */
const stubReceivingApi = () => {
  const fetchMock = vi.fn(async (input: string | URL) => {
    const url = new URL(input.toString());

    if (url.pathname === "/emails/receiving") {
      const after = url.searchParams.get("after");
      if (!after) {
        return jsonResponse({
          object: "list",
          has_more: true,
          data: [
            listItem("email_too_new", "2026-06-11T10:00:00.000Z"),
            listItem("email_3", CREATED_AT.email_3!),
            listItem("email_bad_date", "not-a-date"),
            listItem("email_2", CREATED_AT.email_2!),
          ],
        });
      }
      if (after === "email_2") {
        return jsonResponse({
          object: "list",
          has_more: true,
          data: [
            listItem("email_1", CREATED_AT.email_1!),
            listItem("email_too_old", "2026-05-20T10:00:00.000Z"),
          ],
        });
      }
      throw new Error(`Unexpected after cursor: ${after}`);
    }

    const detailMatch = url.pathname.match(/^\/emails\/receiving\/([^/]+)$/);
    if (detailMatch) {
      return jsonResponse(receivedEmail(detailMatch[1]!));
    }

    if (url.pathname.endsWith("/attachments")) {
      return jsonResponse({ object: "list", has_more: false, data: [] });
    }

    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const drain = async (stream: SyncStream) => {
  const events: WebhookDriverEvent[] = [];
  while (true) {
    const result = await stream.next();
    if (result.done) return { events, result: result.value };
    events.push(result.value);
  }
};

describe("ResendDriver sync", () => {
  it("declares the account sync capability", () => {
    const driver = ResendDriver({ apiKey: "re_test" });

    expect(driver.capabilities.sync).toEqual({ account: true });
    expect(typeof driver.sync?.account).toBe("function");
  });

  it("replays windowed inbound emails oldest-first across pages", async () => {
    const fetchMock = stubReceivingApi();
    const driver = ResendDriver({ apiKey: "re_test" });

    const { events, result } = await drain(
      driver.sync!.account!({ since: SINCE, until: UNTIL }),
    );

    expect(result).toEqual({ syncedFrom: SINCE });
    expect(events.map((event) => event.type)).toEqual([
      "inbound",
      "inbound",
      "inbound",
    ]);
    expect(events.map((event) => (event.data as any).providerId)).toEqual([
      "email_1",
      "email_2",
      "email_3",
    ]);
    expect(events[0]!.data).toMatchObject({
      schemaVersion: "1",
      eventId: `email_1:email.received:${CREATED_AT.email_1}`,
      messageId: "<email_1@example.net>",
      providerId: "email_1",
      from: { name: "Buyer", email: "buyer@example.net" },
      to: [{ email: "agent@example.com" }],
      subject: "Subject email_1",
      text: "email_1",
      html: "<p>email_1</p>",
      timestamp: new Date(CREATED_AT.email_1!),
    });

    const listCalls = fetchMock.mock.calls
      .map((call) => new URL(call[0]!.toString()))
      .filter((url) => url.pathname === "/emails/receiving");
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0]!.searchParams.get("limit")).toBe("100");
    expect(listCalls[0]!.searchParams.get("after")).toBeNull();
    expect(listCalls[1]!.searchParams.get("after")).toBe("email_2");
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({
      headers: { Authorization: "Bearer re_test" },
    });

    // Detail fetches stream lazily in replay (oldest-first) order, and the
    // out-of-window ids are never hydrated.
    const detailIds = fetchMock.mock.calls
      .map((call) =>
        new URL(call[0]!.toString()).pathname.match(
          /^\/emails\/receiving\/([^/]+)$/,
        ),
      )
      .filter((match) => match !== null)
      .map((match) => match![1]);
    expect(detailIds).toEqual(["email_1", "email_2", "email_3"]);
  });

  it("replays received attachments with webhook-compatible shape and lazy content retrieval", async () => {
    const downloadUrl =
      "https://resend-attachments.example.com/email_1/report.txt";
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = new URL(input.toString());

      if (url.pathname === "/emails/receiving") {
        return jsonResponse({
          object: "list",
          has_more: false,
          data: [listItem("email_1", CREATED_AT.email_1!)],
        });
      }

      if (url.pathname === "/emails/receiving/email_1") {
        return jsonResponse(receivedEmail("email_1"));
      }

      if (url.pathname === "/emails/receiving/email_1/attachments") {
        return jsonResponse({
          object: "list",
          has_more: false,
          data: [
            {
              id: "att_1",
              filename: "report.txt",
              size: 14,
              content_type: "text/plain",
              content_disposition: "attachment",
              content_id: null,
              download_url: downloadUrl,
              expires_at: "2026-06-02T11:00:00.000Z",
            },
          ],
        });
      }

      if (input.toString() === downloadUrl) {
        return new Response("resend content", { status: 200 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const onInbound = vi.fn();
    const client = EmailKit({
      emailDrivers: [
        ResendDriver({
          id: "support-resend",
          apiKey: "re_test",
          autoFetchInboundAttachments: false,
        }),
      ],
      hooks: { email: { onInbound } },
    });

    await client.sync({ since: SINCE, until: UNTIL });

    const inbound = onInbound.mock.calls[0]![0];
    expect(inbound.attachments).toEqual([
      {
        filename: "report.txt",
        contentType: "text/plain",
        size: 14,
        contentId: undefined,
        isInline: false,
        url: downloadUrl,
        emailDriver: "support-resend",
      },
    ]);

    const content = await client.attachments.getContent(inbound.attachments[0]);
    expect(new TextDecoder().decode(content as Uint8Array)).toBe(
      "resend content",
    );
    const [, init] = fetchMock.mock.calls.at(-1)!;
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
  });

  it("rejects in-flight hydration when the sync signal aborts", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        // Real fetch rejects when called with an already-aborted signal.
        if (init?.signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        controller.abort();
        return jsonResponse({
          object: "list",
          has_more: false,
          data: [listItem("email_3", CREATED_AT.email_3!)],
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    const stream = driver.sync!.account!({
      since: SINCE,
      until: UNTIL,
      signal: controller.signal,
    });

    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
    // The list succeeded; the per-email detail fetch carried the signal.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws EmailKitError when the receiving list API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "rate limited" }), {
            status: 429,
            headers: { "content-type": "application/json" },
          }),
        ),
    );

    const driver = ResendDriver({ apiKey: "re_test" });
    const stream = driver.sync!.account!({ since: SINCE });

    const error = await stream.next().catch((caught) => caught);
    expect(error).toBeInstanceOf(EmailKitError);
    expect(error).toMatchObject({
      provider: "resend",
      httpStatus: 429,
      message: "rate limited",
    });
  });

  it("dispatches top-level emailKit.sync replays through inbound hooks", async () => {
    stubReceivingApi();
    const onInbound = vi.fn();
    const onAll = vi.fn();
    const client = EmailKit({
      emailDrivers: [ResendDriver({ apiKey: "re_test" })],
      hooks: { email: { onInbound, onAll } },
    });

    const result = await client.sync({
      since: SINCE,
      until: UNTIL,
      context: { reason: "outage" },
    });

    expect(result).toEqual({ dispatched: 3, syncedFrom: SINCE });
    expect(onInbound).toHaveBeenCalledTimes(3);
    expect(onInbound.mock.calls.map((call) => call[0].providerId)).toEqual([
      "email_1",
      "email_2",
      "email_3",
    ]);
    expect(onInbound.mock.calls[0]![0]).toMatchObject({
      emailDriver: "resend",
      messageId: "<email_1@example.net>",
    });
    expect(onAll).toHaveBeenCalledTimes(3);
    expect(onAll.mock.calls[0]![0]).toMatchObject({
      emailDriver: "resend",
      type: "inbound",
      context: { reason: "outage" },
    });
  });
});

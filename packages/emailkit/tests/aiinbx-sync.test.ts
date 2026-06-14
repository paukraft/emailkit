import { afterEach, describe, expect, it, vi } from "vitest";

import { AIInbxDriver, EmailKit, EmailKitError } from "../src";
import type { SyncStream, WebhookDriverEvent } from "../src";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SINCE = new Date("2026-06-01T00:00:00.000Z");
const UNTIL = new Date("2026-06-10T00:00:00.000Z");

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const inboundEmail = (
  id: string,
  threadId: string,
  receivedAt: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  createdAt: receivedAt,
  messageId: `<${id}@example.net>`,
  inReplyToId: null,
  references: [],
  subject: `Subject ${id}`,
  text: `Body ${id}`,
  html: null,
  strippedText: `Body ${id}`,
  strippedHtml: null,
  snippet: `Body ${id}`,
  fromName: "Buyer",
  fromAddress: "buyer@example.net",
  toAddresses: ["agent@example.com"],
  ccAddresses: [],
  bccAddresses: [],
  replyToAddresses: [],
  sentAt: null,
  receivedAt,
  direction: "INBOUND",
  status: "RECEIVED",
  threadId,
  attachments: [],
  ...overrides,
});

/**
 * Mocks POST /threads/search (offset pagination) and GET /threads/{id}.
 * Thread t1's last email is newer than t2's single email, so a correct sync
 * must interleave emails across threads when sorting ascending.
 */
const stubThreadsApi = () => {
  const fetchMock = vi.fn(
    async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input.toString());

      if (url.pathname === "/api/v1/threads/search") {
        const body = JSON.parse(String(init?.body));
        if (body.offset === 0) {
          return jsonResponse({
            threads: [{ id: "t1" }],
            pagination: { total: 2, limit: 100, offset: 0, hasMore: true },
          });
        }
        if (body.offset === 1) {
          return jsonResponse({
            threads: [{ id: "t2" }],
            pagination: { total: 2, limit: 100, offset: 1, hasMore: false },
          });
        }
        throw new Error(`Unexpected search offset: ${body.offset}`);
      }

      if (url.pathname === "/api/v1/threads/t1") {
        return jsonResponse({
          id: "t1",
          createdAt: "2026-05-20T10:00:00.000Z",
          subject: "Thread t1",
          emails: [
            inboundEmail("e_old", "t1", "2026-05-20T10:00:00.000Z"),
            inboundEmail("e1", "t1", "2026-06-02T10:00:00.000Z"),
            inboundEmail("e_out", "t1", "2026-06-04T10:00:00.000Z", {
              direction: "OUTBOUND",
              status: "SENT",
            }),
            inboundEmail("e3", "t1", "2026-06-05T10:00:00.000Z"),
            inboundEmail("e_new", "t1", "2026-06-11T10:00:00.000Z"),
          ],
        });
      }
      if (url.pathname === "/api/v1/threads/t2") {
        return jsonResponse({
          id: "t2",
          createdAt: "2026-06-03T10:00:00.000Z",
          subject: "Thread t2",
          emails: [inboundEmail("e2", "t2", "2026-06-03T10:00:00.000Z")],
        });
      }

      throw new Error(`Unexpected request: ${url}`);
    },
  );
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

describe("AIInbxDriver sync", () => {
  it("declares the account sync capability", () => {
    const driver = AIInbxDriver({ apiKey: "ai_test" });

    expect(driver.capabilities.sync).toEqual({ account: true });
    expect(typeof driver.sync?.account).toBe("function");
  });

  it("replays windowed inbound emails ascending across paginated threads", async () => {
    const fetchMock = stubThreadsApi();
    const driver = AIInbxDriver({ apiKey: "ai_test" });

    const { events, result } = await drain(
      driver.sync!.account!({ since: SINCE, until: UNTIL }),
    );

    expect(result).toEqual({ syncedFrom: SINCE });
    expect(events.map((event) => event.type)).toEqual([
      "inbound",
      "inbound",
      "inbound",
    ]);
    // e2 lives in thread t2 but falls between t1's e1 and e3.
    expect(events.map((event) => (event.data as any).providerId)).toEqual([
      "e1",
      "e2",
      "e3",
    ]);
    expect(events[0]!.data).toMatchObject({
      schemaVersion: "1",
      messageId: "<e1@example.net>",
      providerId: "e1",
      from: { name: "Buyer", email: "buyer@example.net" },
      to: [{ email: "agent@example.com" }],
      reply: { threadId: "t1" },
      subject: "Subject e1",
      text: "Body e1",
      timestamp: new Date("2026-06-02T10:00:00.000Z"),
    });

    const searchCalls = fetchMock.mock.calls.filter((call) =>
      call[0]!.toString().endsWith("/threads/search"),
    );
    expect(searchCalls).toHaveLength(2);
    const [, searchInit] = searchCalls[0]!;
    expect(new Headers(searchInit?.headers).get("authorization")).toBe(
      "Bearer ai_test",
    );
    expect(JSON.parse(String(searchInit?.body))).toEqual({
      // 1ms before `since` so boundary emails survive "after" semantics.
      lastEmailAfter: "2026-05-31T23:59:59.999Z",
      sortBy: "lastEmailAt",
      sortOrder: "asc",
      limit: 100,
      offset: 0,
    });
    expect(JSON.parse(String(searchCalls[1]![1]?.body))).toMatchObject({
      offset: 1,
    });
  });

  it("rejects the next request when the sync signal aborts", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      async (_input: string | URL, init?: RequestInit) => {
        // Real fetch rejects when called with an already-aborted signal.
        if (init?.signal?.aborted) {
          throw new DOMException("This operation was aborted", "AbortError");
        }
        controller.abort();
        return jsonResponse({
          threads: [{ id: "t1" }],
          pagination: { total: 2, limit: 100, offset: 0, hasMore: true },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = AIInbxDriver({ apiKey: "ai_test" });
    const stream = driver.sync!.account!({
      since: SINCE,
      until: UNTIL,
      signal: controller.signal,
    });

    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws EmailKitError when the threads search API fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "server exploded" }), {
            status: 500,
            headers: { "content-type": "application/json" },
          }),
        ),
    );

    const driver = AIInbxDriver({ apiKey: "ai_test" });
    const stream = driver.sync!.account!({ since: SINCE });

    const error = await stream.next().catch((caught) => caught);
    expect(error).toBeInstanceOf(EmailKitError);
    expect(error).toMatchObject({
      provider: "aiinbx",
      httpStatus: 500,
      message: "server exploded",
    });
  });

  it("dispatches top-level emailKit.sync replays through inbound hooks", async () => {
    stubThreadsApi();
    const onInbound = vi.fn();
    const onAll = vi.fn();
    const client = EmailKit({
      emailDrivers: [AIInbxDriver({ id: "support-aiinbx", apiKey: "ai_test" })],
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
      "e1",
      "e2",
      "e3",
    ]);
    expect(onInbound.mock.calls[0]![0]).toMatchObject({
      emailDriver: "support-aiinbx",
      messageId: "<e1@example.net>",
    });
    expect(onAll).toHaveBeenCalledTimes(3);
    expect(onAll.mock.calls[0]![0]).toMatchObject({
      emailDriver: "support-aiinbx",
      type: "inbound",
      context: { reason: "outage" },
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AIInbxDriver,
  EmailKit,
  EmailKitError,
  getAIInbxInbound,
} from "../src";
import type { SyncStream, WebhookDriverEvent } from "../src";
import {
  emailId,
  fullEmail,
  jsonResponse,
  problemResponse,
  THREAD_ID,
  webhookEnvelope,
} from "./aiinbx-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SINCE = new Date("2026-06-01T00:00:00.000Z");
const UNTIL = new Date("2026-06-10T00:00:00.000Z");

const eventId = (n: number) => `evt_${String(n).padStart(32, "0")}`;

// Oldest-first, as GET /events?order=asc returns them.
const EVENTS = [
  webhookEnvelope(
    "email.received",
    { email_id: emailId(1), message_id: "1@example.net", thread_id: THREAD_ID },
    { id: eventId(1), created_at: "2026-06-01T00:00:00.000Z" }, // exactly `since`
  ),
  webhookEnvelope(
    "email.delivered",
    {
      email_id: emailId(2),
      message_id: "2@example.com",
      recipients: ["a@example.net", "b@example.net"],
    },
    { id: eventId(2), created_at: "2026-06-05T00:00:00.000Z" },
  ),
  webhookEnvelope(
    "email.received",
    { email_id: emailId(3), message_id: "3@example.net", thread_id: THREAD_ID },
    { id: eventId(3), created_at: "2026-06-08T00:00:00.000Z" },
  ),
];
const PAGE_SIZE = 2;

/** Mocks cursor-paginated GET /events and GET /emails/{id}. */
const stubEventsApi = () => {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const url = new URL(input.toString());

    if (url.pathname === "/api/v2/events") {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + PAGE_SIZE;
      return jsonResponse({
        data: EVENTS.slice(start, end),
        next_cursor: end < EVENTS.length ? String(end) : null,
      });
    }

    const id = url.pathname.split("/").pop()!;
    return jsonResponse(fullEmail(id, "2026-06-01T00:00:00Z"));
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
};

const collect = async (stream: SyncStream) => {
  const events: WebhookDriverEvent[] = [];
  let next = await stream.next();
  while (!next.done) {
    events.push(next.value);
    next = await stream.next();
  }
  return { events, result: next.value };
};

describe("AIInbxDriver sync", () => {
  it("replays the window's events oldest-first under their webhook ids", async () => {
    const fetchMock = stubEventsApi();
    const driver = AIInbxDriver({ apiKey: "ai_test" });

    const { events, result } = await collect(
      driver.sync!.account!({ since: SINCE, until: UNTIL }),
    );

    expect(result).toEqual({ syncedFrom: SINCE });
    expect(
      events.map((event) => [
        event.type,
        (event.data as { eventId: string }).eventId,
      ]),
    ).toEqual([
      ["inbound", eventId(1)],
      ["delivered", `${eventId(2)}:a@example.net`],
      ["delivered", `${eventId(2)}:b@example.net`],
      ["inbound", eventId(3)],
    ]);
    expect(events[0]).toMatchObject({
      data: {
        providerId: emailId(1),
        messageId: `<${emailId(1)}@example.net>`,
      },
    });
    expect(getAIInbxInbound(events[0]!.data as never)?.verdicts).toEqual({
      spam: "PASS",
      spf: "PASS",
      dkim: "PASS",
      dmarc: null,
    });

    const listCalls = fetchMock.mock.calls
      .map(([input]) => new URL(input.toString()))
      .filter((url) => url.pathname === "/api/v2/events");
    expect(listCalls.map((url) => url.searchParams.get("cursor"))).toEqual([
      null,
      "2",
    ]);
    const params = listCalls[0]!.searchParams;
    expect(params.get("order")).toBe("asc");
    // `after` is exclusive, `since` inclusive.
    expect(params.get("after")).toBe("2026-05-31T23:59:59.999Z");
    expect(params.get("before")).toBe(UNTIL.toISOString());
    expect(params.get("limit")).toBe("100");
    expect(params.getAll("type")).toEqual(
      expect.arrayContaining([
        "email.received",
        "email.bounced",
        "mailbox.connected",
      ]),
    );
    expect(params.getAll("type")).not.toContain("thread.created");
  });

  it("rejects the next request when the sync signal aborts", async () => {
    stubEventsApi();
    const controller = new AbortController();
    const stream = AIInbxDriver({ apiKey: "ai_test" }).sync!.account!({
      since: SINCE,
      until: UNTIL,
      signal: controller.signal,
    });

    await stream.next();
    controller.abort();
    // The rest of the first page needs no request.
    await stream.next();
    await stream.next();

    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws EmailKitError when listing events fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => problemResponse(403, "forbidden", "Key lacks scope")),
    );
    const stream = AIInbxDriver({ apiKey: "ai_test" }).sync!.account!({
      since: SINCE,
    });

    const error = await stream.next().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(EmailKitError);
    expect(error).toMatchObject({ code: "forbidden", httpStatus: 403 });
  });

  it("dispatches top-level emailKit.sync replays through inbound hooks", async () => {
    stubEventsApi();
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

    expect(result).toEqual({ dispatched: 4, syncedFrom: SINCE });
    expect(onInbound.mock.calls[0]![0]).toMatchObject({
      emailDriver: "support-aiinbx",
      providerId: emailId(1),
    });
    expect(onAll.mock.calls[0]![0]).toMatchObject({
      type: "inbound",
      context: { reason: "outage" },
    });
  });
});

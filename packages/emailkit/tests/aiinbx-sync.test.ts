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
  listEmail,
  problemResponse,
} from "./aiinbx-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const SINCE = new Date("2026-06-01T00:00:00.000Z");
const UNTIL = new Date("2026-06-10T00:00:00.000Z");

// Newest-first, as GET /emails returns them.
const EMAILS = [
  listEmail(emailId(5), "2026-06-11T00:00:00Z"), // after `until`
  listEmail(emailId(4), "2026-06-08T00:00:00Z"),
  listEmail(emailId(3), "2026-06-05T00:00:00Z"),
  listEmail(emailId(2), "2026-06-01T00:00:00Z"), // exactly `since`
  listEmail(emailId(1), "2026-05-20T00:00:00Z"), // before `since`
  listEmail(emailId(0), "2026-05-01T00:00:00Z"),
];
const PAGE_SIZE = 2;

/** Mocks cursor-paginated GET /emails and GET /emails/{id}. */
const stubEmailsApi = () => {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    init?.signal?.throwIfAborted();
    const url = new URL(input.toString());

    if (url.pathname === "/api/v2/emails") {
      const start = Number(url.searchParams.get("cursor") ?? 0);
      const end = start + PAGE_SIZE;
      return jsonResponse({
        data: EMAILS.slice(start, end),
        next_cursor: end < EMAILS.length ? String(end) : null,
      });
    }

    const email = EMAILS.find(
      (item) => url.pathname === `/api/v2/emails/${item.id}`,
    )!;
    return jsonResponse(fullEmail(email.id, email.created_at));
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
  it("replays windowed inbound emails oldest-first and stops paging at since", async () => {
    const fetchMock = stubEmailsApi();
    const driver = AIInbxDriver({ apiKey: "ai_test" });

    const { events, result } = await collect(
      driver.sync!.account!({ since: SINCE, until: UNTIL }),
    );

    expect(result).toEqual({ syncedFrom: SINCE });
    expect(
      events.map((event) => (event.data as { providerId: string }).providerId),
    ).toEqual([emailId(2), emailId(3), emailId(4)]);
    expect(events[0]).toMatchObject({
      type: "inbound",
      data: {
        eventId: `${emailId(2)}:received`,
        messageId: `<${emailId(2)}@example.net>`,
        timestamp: new Date("2026-06-01T00:00:00Z"),
      },
    });
    expect(
      getAIInbxInbound(events[0]!.data as never)?.verdicts,
    ).toBeUndefined();

    const listCalls = fetchMock.mock.calls
      .map(([input]) => new URL(input.toString()))
      .filter((url) => url.pathname === "/api/v2/emails");
    // Pages 1–3 reach an email older than `since`; nothing is listed after.
    expect(listCalls.map((url) => url.searchParams.get("cursor"))).toEqual([
      null,
      "2",
      "4",
    ]);
    expect(listCalls[0]!.searchParams.get("direction")).toBe("inbound");
    expect(listCalls[0]!.searchParams.get("limit")).toBe("100");
  });

  it("rejects the next request when the sync signal aborts", async () => {
    stubEmailsApi();
    const controller = new AbortController();
    const stream = AIInbxDriver({ apiKey: "ai_test" }).sync!.account!({
      since: SINCE,
      until: UNTIL,
      signal: controller.signal,
    });

    await stream.next();
    controller.abort();

    await expect(stream.next()).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws EmailKitError when listing emails fails", async () => {
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
    stubEmailsApi();
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
    expect(onInbound.mock.calls[0]![0]).toMatchObject({
      emailDriver: "support-aiinbx",
      providerId: emailId(2),
    });
    expect(onAll.mock.calls[0]![0]).toMatchObject({
      type: "inbound",
      context: { reason: "outage" },
    });
  });
});

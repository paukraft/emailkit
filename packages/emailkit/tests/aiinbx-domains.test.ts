import { afterEach, describe, expect, it, vi } from "vitest";

import { AIInbxDriver } from "../src";
import { API, jsonResponse } from "./aiinbx-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const domain = (
  id: string,
  name: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  name,
  region: "eu-central-1",
  space_id: null,
  parent_id: null,
  provided: false,
  verified_at: null,
  created_at: "2026-09-01T10:00:00Z",
  tracking: { opens: false, clicks: false },
  records: [
    {
      purpose: "DKIM",
      type: "CNAME",
      name: `aiinbx._domainkey.${name}`,
      value: "dkim.aiinbx.com",
      ttl: 300,
      state: "verified",
      last_checked_at: "2026-09-01T10:05:00Z",
    },
    {
      purpose: "INBOUND",
      type: "MX",
      name,
      value: "inbound.aiinbx.com",
      ttl: 300,
      state: "missing",
      last_checked_at: null,
    },
  ],
  ...overrides,
});

const calls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map(([input, init]) => ({
    method: (init as RequestInit).method,
    url: input.toString(),
    body: (init as RequestInit).body
      ? JSON.parse((init as RequestInit).body as string)
      : undefined,
  }));

describe("AIInbxDriver domains", () => {
  it("defaults to the aiinbx id and preserves custom literal ids", () => {
    expect(AIInbxDriver({ apiKey: "ai_test" }).id).toBe("aiinbx");
    expect(AIInbxDriver({ id: "support", apiKey: "ai_test" }).id).toBe(
      "support",
    );
  });

  it("scopes providerFetch auth to the versioned API base", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const driver = AIInbxDriver({
      apiKey: "ai_test",
      apiBase: "https://api.example.com/",
    });

    await driver.providerFetch!("/attachments/att_1/content");
    await driver.providerFetch!("https://api.example.com/api/v2/domains");
    await driver.providerFetch!("https://files.example.com/report.txt");

    const requests = (
      fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>
    ).map(([url, init]) => ({
      url: url.toString(),
      authorization: new Headers(init.headers).get("authorization"),
    }));
    expect(requests).toEqual([
      {
        url: "https://api.example.com/api/v2/attachments/att_1/content",
        authorization: "Bearer ai_test",
      },
      {
        url: "https://api.example.com/api/v2/domains",
        authorization: "Bearer ai_test",
      },
      { url: "https://files.example.com/report.txt", authorization: null },
    ]);
  });

  it("lists every page and normalizes status and DNS records", async () => {
    const fetchMock = vi.fn(async (input: string | URL) =>
      new URL(input.toString()).searchParams.get("cursor")
        ? jsonResponse({
            data: [
              domain("dom_2", "two.example.com", {
                verified_at: "2026-09-01T11:00:00Z",
              }),
            ],
            next_cursor: null,
          })
        : jsonResponse({
            data: [domain("dom_1", "one.example.com")],
            next_cursor: "dom_1",
          }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const driver = AIInbxDriver({ apiKey: "ai_test" });

    const domains = await driver.domains.list();

    expect(domains).toMatchObject([
      { id: "dom_1", domain: "one.example.com", status: "pending" },
      { id: "dom_2", domain: "two.example.com", status: "verified" },
    ]);
    expect(domains[0]!.region).toBe("eu-central-1");
    expect(domains[0]!.verification!.records).toEqual([
      {
        type: "CNAME",
        name: "aiinbx._domainkey.one.example.com",
        value: "dkim.aiinbx.com",
        ttl: 300,
        purpose: "dkim",
        verified: true,
        lastCheckedAt: new Date("2026-09-01T10:05:00Z"),
      },
      {
        type: "MX",
        name: "one.example.com",
        value: "inbound.aiinbx.com",
        ttl: 300,
        purpose: "mx",
        verified: false,
      },
    ]);

    expect(await driver.domains.list({ status: "verified" })).toMatchObject([
      { id: "dom_2" },
    ]);
  });

  it("creates a domain and applies tracking with a follow-up update", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(domain("dom_1", "one.example.com"), { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const created = await AIInbxDriver({ apiKey: "ai_test" }).domains.create({
      domain: "one.example.com",
      region: "us-east-1",
      tracking: { opens: true },
      provider: { space_id: "spc_1" },
    });

    expect(created).toMatchObject({ id: "dom_1", status: "pending" });
    expect(calls(fetchMock)).toEqual([
      {
        method: "POST",
        url: `${API}/domains`,
        body: {
          name: "one.example.com",
          region: "us-east-1",
          space_id: "spc_1",
        },
      },
      {
        method: "PATCH",
        url: `${API}/domains/dom_1`,
        body: { track_opens: true },
      },
    ]);
  });

  it("resolves domain names to ids for get, update, verify, and delete", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (url.pathname === "/api/v2/domains") {
        return jsonResponse({
          data: [domain("dom_1", "one.example.com")],
          next_cursor: null,
        });
      }
      return jsonResponse(
        domain("dom_1", "one.example.com", {
          verified_at: "2026-09-01T11:00:00Z",
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    const { domains } = AIInbxDriver({ apiKey: "ai_test" });

    expect(await domains.get("One.Example.com")).toMatchObject({
      id: "dom_1",
      status: "verified",
    });
    await domains.update("dom_1", { tracking: { clicks: true } });
    const verification = await domains.verify("dom_1");
    expect(verification.status).toBe("verified");
    expect(verification.checkedAt).toBeInstanceOf(Date);
    expect(await domains.delete("dom_1")).toEqual({ deleted: true });

    expect(calls(fetchMock).slice(1)).toEqual([
      { method: "GET", url: `${API}/domains/dom_1`, body: undefined },
      {
        method: "PATCH",
        url: `${API}/domains/dom_1`,
        body: { track_clicks: true },
      },
      { method: "POST", url: `${API}/domains/dom_1/verify`, body: undefined },
      { method: "DELETE", url: `${API}/domains/dom_1`, body: undefined },
    ]);

    await expect(domains.get("missing.example.com")).rejects.toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
    });
  });
});

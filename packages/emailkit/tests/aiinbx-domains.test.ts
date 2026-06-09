import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import { AIInbxDriver, EmailKit } from "../src";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const recordResponse = {
  type: "TXT",
  name: "_dmarc",
  value: "v=DMARC1; p=none",
  priority: null,
  isVerified: true,
  lastCheckedAt: "2026-04-02T10:00:00.000Z",
};

describe("AIInbxDriver domains", () => {
  it("defaults to the aiinbx id and preserves custom literal ids", () => {
    const defaultDriver = AIInbxDriver({ apiKey: "ai_test" });
    const customDriver = AIInbxDriver({
      id: "tenant-aiinbx",
      apiKey: "ai_test",
    });
    const client = EmailKit({ emailDrivers: [customDriver] });

    expect(defaultDriver.id).toBe("aiinbx");
    expect(customDriver.id).toBe("tenant-aiinbx");
    expect(client.getDriver("tenant-aiinbx")).toBe(customDriver);
    expectTypeOf(customDriver.id).toEqualTypeOf<"tenant-aiinbx">();
  });

  it("advertises only AIInbx-supported core capabilities", () => {
    const driver = AIInbxDriver({ apiKey: "ai_test" });

    expect(driver.capabilities.domains).toMatchObject({
      list: true,
      create: true,
      get: true,
      verify: true,
      delete: true,
      identifier: "domainId",
    });
    expect(driver.capabilities.requiresSecret).toBeUndefined();
    expect(driver.capabilities.mailboxConnect).toBeUndefined();
    expect(driver.capabilities.mailboxCreate).toBeUndefined();
    expect(driver.capabilities.mailboxList).toBeUndefined();
    expect(driver.capabilities.mailboxGet).toBeUndefined();
    expect(driver.capabilities.mailboxDelete).toBeUndefined();
    expect(driver.mailboxes).toBeUndefined();
  });

  it("maps list responses that expose DNS records as records", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            domains: [
              {
                id: "dom_123",
                domain: "example.com",
                status: "PENDING_VERIFICATION",
                records: [recordResponse],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const driver = AIInbxDriver({ apiKey: "ai_test" });
    const domains = await driver.domains!.list!();

    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({
      id: "dom_123",
      domain: "example.com",
      status: "pending",
    });
    expect(domains[0]).not.toHaveProperty("name");
    expect(domains[0]?.verification?.records).toHaveLength(1);
    expect(domains[0]?.verification?.records[0]).toMatchObject({
      type: "TXT",
      name: "_dmarc",
      value: "v=DMARC1; p=none",
      verified: true,
    });
  });

  it("maps OpenAPI dnsRecords to normalized verification records", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            domains: [
              {
                id: "dom_123",
                createdAt: "2026-04-02T10:00:00.000Z",
                updatedAt: "2026-04-02T10:30:00.000Z",
                domain: "example.com",
                verifiedAt: null,
                status: "PENDING_VERIFICATION",
                isManagedDefault: false,
                dnsRecords: [
                  {
                    type: "MX",
                    name: "example.com",
                    value: "feedback-smtp.us-east-1.amazonses.com",
                    priority: 10,
                    verificationStatus: "verified",
                  },
                ],
              },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const driver = AIInbxDriver({ apiKey: "ai_test" });
    const domains = await driver.domains!.list!();

    expect(domains[0]?.domain).toBe("example.com");
    expect(domains[0]).not.toHaveProperty("name");
    expect(domains[0]?.verification?.records[0]).toMatchObject({
      type: "MX",
      name: "example.com",
      value: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
      verified: true,
    });
  });

  it("creates domains with the public domain field only", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          domainId: "dom_123",
          records: [recordResponse],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const driver = AIInbxDriver({ apiKey: "ai_test" });
    const domain = await driver.domains!.create!({ domain: "example.com" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ domain: "example.com" });
    expect(domain).toMatchObject({
      id: "dom_123",
      domain: "example.com",
      status: "pending",
    });
    expect(domain).not.toHaveProperty("name");
  });

  it("maps get responses that expose DNS records as records", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            id: "dom_123",
            domain: "example.com",
            status: "VERIFIED",
            records: [recordResponse],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const driver = AIInbxDriver({ apiKey: "ai_test" });
    const domain = await driver.domains!.get!("dom_123");

    expect(domain.status).toBe("verified");
    expect(domain.verification?.records).toHaveLength(1);
  });

  it("maps verify responses that expose DNS records as records", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            domain: {
              id: "dom_123",
              domain: "example.com",
              status: "VERIFIED",
              records: [recordResponse],
            },
            verification: {
              verification: "Success",
            },
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const driver = AIInbxDriver({ apiKey: "ai_test" });
    const verification = await driver.domains!.verify!("dom_123");

    expect(verification.status).toBe("verified");
    expect(verification.records).toHaveLength(1);
    expect(verification.records[0]?.verified).toBe(true);
  });
});

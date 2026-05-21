import { afterEach, describe, expect, it, vi } from "vitest";

import { ResendDriver } from "../src";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const verifiedDomainResponse = {
  object: "domain",
  id: "dom_123",
  name: "example.com",
  status: "verified",
  created_at: "2024-01-01T00:00:00.000Z",
  region: "eu-west-1",
  records: [
    {
      record: "DKIM",
      name: "resend._domainkey",
      value: "k=rsa; p=abc",
      type: "TXT",
      ttl: "Auto",
      status: "verified",
    },
  ],
};

const pendingDomainResponse = {
  ...verifiedDomainResponse,
  status: "pending",
  records: [
    {
      ...verifiedDomainResponse.records[0],
      status: "pending",
    },
  ],
};

describe("ResendDriver domains.verify", () => {
  it("polls until the domain verification state settles", async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(verifiedDomainResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: "domain", id: "dom_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(pendingDomainResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(verifiedDomainResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });

    const verifyPromise = driver.domains!.verify("dom_123");
    await vi.advanceTimersByTimeAsync(1000);
    const verification = await verifyPromise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(verification.status).toBe("verified");
    expect(verification.records).toHaveLength(1);
    expect(verification.records[0]?.verified).toBe(true);
  });

  it("preserves the last known verified state when resend stays pending", async () => {
    vi.useFakeTimers();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(verifiedDomainResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: "domain", id: "dom_123" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    for (let i = 0; i < 11; i += 1) {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(pendingDomainResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }

    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });

    const verifyPromise = driver.domains!.verify("dom_123");
    await vi.advanceTimersByTimeAsync(10000);
    const verification = await verifyPromise;

    expect(verification.status).toBe("verified");
    expect(verification.records[0]?.verified).toBe(true);
  });
});

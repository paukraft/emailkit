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

describe("ResendDriver domains", () => {
  it("normalizes provider name to public domain without name compatibility", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: "list",
          has_more: false,
          data: [verifiedDomainResponse],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    const domains = await driver.domains!.list();

    expect(domains).toHaveLength(1);
    expect(domains[0]).toMatchObject({
      id: "dom_123",
      domain: "example.com",
      status: "verified",
    });
    expect(domains[0]).not.toHaveProperty("name");
  });

  it("creates domains from the EmailKit domain input field", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify(verifiedDomainResponse), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    const domain = await driver.domains!.create({
      domain: "example.com",
      region: "eu-west-1",
      returnPathSubdomain: "bounce",
      tracking: { opens: true, clicks: false },
    });

    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: "example.com",
      region: "eu-west-1",
      custom_return_path: "bounce",
      open_tracking: true,
      click_tracking: false,
    });
    expect(domain.domain).toBe("example.com");
    expect(domain).not.toHaveProperty("name");
  });

  it("updates supported Resend domain settings and returns hydrated domain", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ object: "domain", id: "dom_123" }), {
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
    const domain = await driver.domains!.update("dom_123", {
      tracking: { opens: false, clicks: true },
      provider: { tls: "enforced" },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.resend.com/domains/dom_123",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          open_tracking: false,
          click_tracking: true,
          tls: "enforced",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.resend.com/domains/dom_123",
      expect.any(Object),
    );
    expect(domain.domain).toBe("example.com");
  });

  it("uses Resend delete response deleted flag", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({ object: "domain", id: "dom_123", deleted: true }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    vi.stubGlobal("fetch", fetchMock);

    const driver = ResendDriver({ apiKey: "re_test" });
    await expect(driver.domains!.delete("dom_123")).resolves.toEqual({
      deleted: true,
    });
  });
});

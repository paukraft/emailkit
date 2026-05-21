import { afterEach, describe, expect, it, vi } from "vitest";

import { AIInbxDriver } from "../src";

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
    expect(domains[0]?.verification?.records).toHaveLength(1);
    expect(domains[0]?.verification?.records[0]).toMatchObject({
      type: "TXT",
      name: "_dmarc",
      value: "v=DMARC1; p=none",
      verified: true,
    });
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

import type { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

import {
  createNextEmailKitHandler,
  EmailKitRequestParseError,
  toEmailKitRequest,
  toNextResponse,
} from "../src/nextjs";

const nextRequest = (url: string, init?: RequestInit): NextRequest =>
  Object.assign(new Request(url, init), { nextUrl: new URL(url) }) as NextRequest;

describe("Next.js helpers", () => {
  it("converts a Next.js request and injects a route driver id", async () => {
    const request = nextRequest("https://app.test/api/email/outlook?code=abc");

    const result = await toEmailKitRequest(request, {
      emailDriver: "outlook",
      query: { state: "signed-state" },
      headers: { "x-extra": "yes" },
    });

    expect(result).toMatchObject({
      method: "GET",
      query: {
        code: "abc",
        state: "signed-state",
        emailDriver: "outlook",
      },
      headers: {
        "x-emailkit-driver": "outlook",
        "x-extra": "yes",
      },
      body: "",
      rawBody: "",
    });
  });

  it("creates route handlers that resolve dynamic driver ids", async () => {
    const emailkitHandler = vi.fn().mockResolvedValue({
      status: 202,
      body: { ok: true },
      headers: { "x-result": "accepted" },
    });
    const emailkit = { handler: () => emailkitHandler };

    const { POST } = createNextEmailKitHandler<{
      params: Promise<{ emailDriver: string }>;
    }>(emailkit, {
      emailDriver: async (_request, context) =>
        (await context.params).emailDriver,
    });

    const response = await POST(
      nextRequest("https://app.test/api/email/outlook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "email.received" }),
      }),
      { params: Promise.resolve({ emailDriver: "outlook" }) },
    );

    expect(emailkitHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        query: { emailDriver: "outlook" },
        headers: expect.objectContaining({
          "x-emailkit-driver": "outlook",
        }),
        body: { type: "email.received" },
      }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("x-result")).toBe("accepted");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects invalid JSON request bodies instead of hiding parse failures", async () => {
    await expect(
      toEmailKitRequest(
        nextRequest("https://app.test/api/email/outlook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{bad-json",
        }),
      ),
    ).rejects.toBeInstanceOf(EmailKitRequestParseError);
  });

  it("returns 400 from route handlers for invalid JSON request bodies", async () => {
    const emailkitHandler = vi.fn();
    const emailkit = { handler: () => emailkitHandler };
    const { POST } = createNextEmailKitHandler(emailkit);

    const response = await POST(
      nextRequest("https://app.test/api/email/outlook", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{bad-json",
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid JSON request body",
    });
    expect(emailkitHandler).not.toHaveBeenCalled();
  });

  it("converts empty EmailKit responses to empty Next.js responses", async () => {
    const response = toNextResponse({ status: 204 });

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe("");
  });

  it("preserves text/plain EmailKit responses for provider validation", async () => {
    const response = toNextResponse({
      status: 200,
      body: "validation-token",
      headers: { "Content-Type": "text/plain" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    await expect(response.text()).resolves.toBe("validation-token");
  });

});

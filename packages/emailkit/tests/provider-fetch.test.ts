import { afterEach, describe, expect, it, vi } from "vitest";

import { createProviderFetch } from "../src";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createProviderFetch", () => {
  it("merges default and override headers for relative URLs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const providerFetch = createProviderFetch({
      baseUrl: "https://api.example.com/v1",
      defaultHeaders: {
        authorization: "Bearer token",
        "x-default": "default",
      },
      defaultSearchParams: {
        locale: "en",
      },
    });

    await providerFetch("/messages", {
      method: "POST",
      headers: [["x-default", "override"], ["x-extra", "present"]],
      searchParams: {
        page: 2,
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://api.example.com/v1/messages?locale=en&page=2");

    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer token");
    expect(headers.get("x-default")).toBe("override");
    expect(headers.get("x-extra")).toBe("present");
  });

  it("accepts header records with array values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    const providerFetch = createProviderFetch({
      baseUrl: "https://api.example.com",
    });

    await providerFetch("https://files.example.com/upload", {
      headers: {
        accept: ["application/json", "text/plain"],
        "x-single": "value",
      } as RequestInit["headers"],
    });

    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const headers = new Headers(init.headers);

    expect(headers.get("accept")).toBe("application/json, text/plain");
    expect(headers.get("x-single")).toBe("value");
  });
});

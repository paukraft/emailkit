import { describe, expect, it } from "vitest";

import { EmailKit, VERSION, isGmailAuth, isOutlookAuth } from "../src";

describe("emailkit", () => {
  it("exports the package version", () => {
    expect(VERSION).toBe("3.0.0");
  });

  it("exports the EmailKit factory", () => {
    expect(typeof EmailKit).toBe("function");
  });

  it("exports OAuth mailbox auth guards", () => {
    expect(isGmailAuth({ accessToken: "access_123" })).toBe(true);
    expect(isOutlookAuth({ accessToken: "access_123" })).toBe(true);
    expect(isGmailAuth({ refreshToken: "refresh_123" })).toBe(false);
    expect(isOutlookAuth(null)).toBe(false);
  });
});

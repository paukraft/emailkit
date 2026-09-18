import { describe, expect, it } from "vitest";

import { checkOpenBot } from "../src/bot-detect";

describe("checkOpenBot", () => {
  it("reads the bare token as Apple's privacy proxy, not a reader", () => {
    expect(checkOpenBot({ userAgent: "Mozilla/5.0" })).toEqual({
      isBot: true,
      reason: "bare-mozilla",
    });
  });

  it("counts Gmail's image proxy as the reader it stands in for", () => {
    expect(
      checkOpenBot({
        userAgent:
          "Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)",
      }),
    ).toEqual({ isBot: false, reason: "email-image-proxy" });
  });
});

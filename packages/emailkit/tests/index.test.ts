import { describe, expect, it } from "vitest";

import { EmailKit, VERSION } from "../src";

describe("emailkit", () => {
  it("exports the package version", () => {
    expect(VERSION).toBe("2.0.0");
  });

  it("exports the EmailKit factory", () => {
    expect(typeof EmailKit).toBe("function");
  });
});

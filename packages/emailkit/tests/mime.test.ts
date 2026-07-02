import { describe, expect, it } from "vitest";

import { buildMimeMessage } from "../src/utils/mime";

const baseInput = {
  from: { email: "sender@example.com", name: "Sender" },
  to: { email: "recipient@example.com", name: "Recipient" },
  subject: "Hello",
  text: "Body",
  messageId: "<message@example.com>",
};

describe("mime utilities", () => {
  it("collapses CRLF in rendered header values", () => {
    const message = buildMimeMessage({
      ...baseInput,
      from: {
        email: "sender@example.com\r\nBcc: attacker@example.com",
        name: "Sender\r\nX-Evil: yes",
      },
      to: {
        email: "recipient@example.com\r\nCc: attacker@example.com",
        name: "Recipient",
      },
      subject: "Hello\r\nBcc: attacker@example.com",
      messageId: "<message@example.com>\r\nBcc: attacker@example.com",
      replyTo: [
        {
          email: "reply@example.com\r\nBcc: attacker@example.com",
          name: "Replies",
        },
      ],
      inReplyTo: "<previous@example.com>\r\nBcc: attacker@example.com",
      references: ["<root@example.com>\r\nBcc: attacker@example.com"],
      headers: {
        "X-Custom": "ok\r\nBcc: attacker@example.com",
      },
      attachments: [
        {
          filename: "invoice.pdf\r\nBcc: attacker@example.com",
          contentType: "application/pdf\r\nBcc: attacker@example.com",
          content: "pdf",
          contentId: "invoice\r\nBcc: attacker@example.com",
          isInline: true,
        },
      ],
    });

    expect(message).not.toContain("\r\nBcc: attacker@example.com");
    expect(message).not.toContain("\r\nCc: attacker@example.com");
    expect(message).not.toContain("\r\nX-Evil: yes");
    expect(message).toContain("Bcc: attacker@example.com");
    expect(message).toContain("Cc: attacker@example.com");
  });

  it("rejects invalid custom header names", () => {
    expect(() =>
      buildMimeMessage({
        ...baseInput,
        headers: {
          "X-Good\r\nBcc": "attacker@example.com",
        },
      }),
    ).toThrow(TypeError);
  });
});

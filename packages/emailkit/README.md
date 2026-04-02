# EmailKit

Unified email SDK with pluggable drivers (Mailgun, Resend, AIInbx) and optional Next.js helpers.

## Install

```bash
npm i emailkit
```

## Usage

```ts
import { EmailKit, MailgunDriver } from "emailkit";

const emailkit = EmailKit({
  emailDriver: MailgunDriver({ apiKey: process.env.MAILGUN_API_KEY! }),
  hooks: {
    onInboundEmail: async (event) => {
      console.log("Received inbound email:", event);
    },
    onOutboundEmailOpened: async (event) => {
      console.log("Email opened:", event);
    },
  },
});

await emailkit.sendEmail({
  from: { email: "sender@example.com", name: "Sender" },
  to: { email: "recipient@example.com" },
  subject: "Hello",
  text: "Hello world",
});
```

### Domains

Use domain names or provider ids. EmailKit resolves the provider-specific identifier for you:

```ts
const existing = await emailkit.domains.getOrNull({ domain: "mg.example.com" });

const { domain, created } = await emailkit.domains.ensure({
  name: "mg.example.com",
});

console.log(domain.status, created);
```

`get()` stays strict and throws on missing domains. `getOrNull()` is the normalized lookup path when you want "find this domain if it exists".

### Inbound attachments

For inbound email, treat `event.attachments` as metadata plus optional eager content. The stable retrieval path is `emailkit.attachments.getContent(...)`:

```ts
hooks: {
  onInboundEmail: async (event) => {
    for (const attachment of event.attachments ?? []) {
      const content = await emailkit.attachments.getContent(attachment);
      await saveAttachment(attachment.filename, content);
    }
  },
}
```

If a driver can hydrate stored attachments before your hook runs, it will populate `attachment.content` eagerly. `getContent()` still works either way, so app code does not need provider-specific fetch/auth logic.

### Webhooks (framework-agnostic)

```ts
const handle = emailkit.webhookRoute();
const res = await handle({ method, headers, body });
```

### Provider fetch helper

Call provider-specific endpoints while reusing the configured authentication and base URL. This is the advanced escape hatch when you need something beyond the normalized EmailKit API:

```ts
const response = await emailkit.providerFetch("/v4/domains", {
  method: "GET",
  searchParams: { limit: 25 },
});

if (!response.ok) throw new Error("Provider API failed");
const domains = await response.json();
```

The helper accepts any `fetch` options plus an optional `searchParams` object. Pass absolute URLs when the provider returns fully qualified links (for example, stored attachment URLs); the helper still injects auth headers.

### Next.js adapter (optional)

```ts
import { createNextJsWebhookHandler } from "emailkit/nextjs";

export const POST = createNextJsWebhookHandler(emailkit.webhookRoute());
```

# EmailKit

Unified email SDK with pluggable drivers (Mailgun, Resend, AIInbx, Outlook) and optional Next.js helpers.

## Install

```bash
npm i emailkit
```

## Usage

```ts
import { EmailKit, MailgunDriver, ResendDriver } from "emailkit";

const emailkit = EmailKit({
  emailDrivers: [
    ResendDriver({ id: "resend", apiKey: process.env.RESEND_API_KEY! }),
    MailgunDriver({ id: "mailgun", apiKey: process.env.MAILGUN_API_KEY! }),
  ],
  resolveEmailDriver: async (ctx) => {
    if (ctx.operation === "sendEmail") {
      return ctx.message.from.email.endsWith("@mg.example.com")
        ? { emailDriver: "mailgun" }
        : { emailDriver: "resend" };
    }

    if (
      "input" in ctx &&
      ctx.input &&
      "domain" in ctx.input &&
      ctx.input.domain?.endsWith("mg.example.com")
    ) {
      return { emailDriver: "mailgun" };
    }

    return "resend";
  },
  hooks: {
    email: {
      onInbound: async (event) => {
        console.log("Received inbound email:", event);
      },
      onOpened: async (event) => {
        console.log("Email opened:", event);
      },
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

### EmailKit secret

Drivers that sign callback state or run OAuth mailbox connection flows need an EmailKit secret. EmailKit automatically reads `EMAILKIT_SECRET` when `secret` is omitted:

```sh
EMAILKIT_SECRET="replace-with-a-long-random-secret"
```

You can still pass `secret` explicitly, and it takes precedence over `EMAILKIT_SECRET`:

```ts
const emailkit = EmailKit({
  emailDrivers: [OutlookDriver({ clientId, clientSecret })],
  secret: process.env.AUTH_SECRET,
});
```

EmailKit also reads `PUBLIC_BASE_URL` automatically for public webhook and
callback URLs. With `PUBLIC_BASE_URL=https://app.example.com`, the default
driver route is `https://app.example.com/api/email/:emailDriverId`. Passing
`publicRoutes.baseUrl` or `publicRoutes.route` overrides those defaults.

### Mailboxes

Mailbox objects are durable identity only. Store provider OAuth material from
the top-level `auth` field returned by connection flows, then pass it back as a
separate `auth` value when sending or managing mailbox-scoped webhooks:

```ts
import type { MailboxConnectionResult, WebhookResponse } from "emailkit";

const isMailboxConnectionResponse = (
  response: WebhookResponse,
): response is WebhookResponse & {
  body: { result: MailboxConnectionResult };
} =>
  response.status === 200 &&
  typeof response.body === "object" &&
  response.body !== null &&
  "result" in response.body;

const connection = await emailkit.handler()(callbackRequest);
if (
  !isMailboxConnectionResponse(connection) ||
  !connection.body.result.mailbox
) {
  throw new Error("Mailbox connection failed");
}

const { mailbox, auth } = connection.body.result;

await emailkit.sendEmail({
  from: { email: mailbox.email },
  to: { email: "recipient@example.com" },
  subject: "Hello",
  text: "Hello",
  sender: { emailDriver: "outlook", mailbox, auth },
});

await emailkit.mailboxes.webhooks.setup({
  emailDriver: "outlook",
  mailbox,
  auth,
  events: ["inbound"],
});
```

### Outlook

Outlook uses delegated Microsoft Graph mailbox auth. Register your EmailKit
route as a Web redirect URI in Microsoft Entra, then configure the driver:

```ts
import { EmailKit, OutlookDriver } from "emailkit";

export const emailkit = EmailKit({
  secret: process.env.EMAILKIT_SECRET!,
  emailDrivers: [
    OutlookDriver({
      id: "outlook",
      clientId: process.env.OUTLOOK_CLIENT_ID!,
      clientSecret: process.env.OUTLOOK_CLIENT_SECRET!,
      tenant: process.env.OUTLOOK_TENANT ?? "common",
      scopes: ["offline_access", "User.Read", "Mail.Send", "Mail.Read"],
      webhookClientState: process.env.OUTLOOK_WEBHOOK_CLIENT_STATE!,
    }),
  ],
  publicRoutes: {
    connectLandingRoutes: {
      success: "/settings/email",
      failure: "/settings/email",
    },
  },
});
```

The Outlook driver exposes only the send features it can map to Microsoft
Graph: CC, BCC, Reply-To addresses, attachments with content, and custom
headers that begin with `X-`. It does not expose templates, scheduling,
unsubscribe, tracking controls, tags, metadata, idempotency, domain APIs, or
reply threading. Shared mailbox/send-as is not supported by the normalized
driver; use `providerFetch` for Graph-specific escape hatches.

### Domains

Use domain names or provider ids. EmailKit resolves the provider-specific identifier for you:

```ts
const existing = await emailkit.domains.getOrNull({ domain: "mg.example.com" });

const { domain, created } = await emailkit.domains.ensure({
  emailDriver: "mailgun",
  domain: "mg.example.com",
});

console.log(domain.status, created);
```

`get()` stays strict and throws on missing domains. `getOrNull()` is the normalized lookup path when you want "find this domain if it exists".

Domain operation context is carried separately from the provider identifier and is surfaced in hooks:

```ts
await emailkit.domains.verify({
  domain: "mg.example.com",
  context: { tenantId: "tenant_123" },
});
```

Drivers can advertise method-level domain support:

```ts
const capabilities = {
  domains: {
    list: true,
    create: true,
    get: true,
    verify: true,
    delete: true,
    identifier: "domainId",
  },
} as const;
```

Unsupported domain methods are omitted from the typed facade where possible and throw `NOT_SUPPORTED` if called dynamically.

### Inbound attachments

For inbound email, treat `event.attachments` as metadata plus optional eager content. The stable retrieval path is `emailkit.attachments.getContent(...)`:

```ts
hooks: {
  email: {
    onInbound: async (event) => {
      for (const attachment of event.attachments ?? []) {
        const content = await emailkit.attachments.getContent(attachment);
        await saveAttachment(attachment.filename, content);
      }
    },
  },
}
```

If a driver can hydrate stored attachments before your hook runs, it will populate `attachment.content` eagerly. `getContent()` still works either way for drivers that declare `providerFetch`, so app code does not need provider-specific fetch/auth logic.

Inbound attachments are stamped with `attachment.emailDriver` by the EmailKit client. That means stored attachment records can be persisted and later passed back to `emailkit.attachments.getContent(attachment)` without also passing `{ emailDriver }`. If you do pass an explicit `{ emailDriver }`, it must match the attachment stamp.

### Webhooks (framework-agnostic)

```ts
const handle = emailkit.handler();
const res = await handle({ method, headers, body });
```

### Provider fetch helper

Call provider-specific endpoints while reusing the configured authentication and base URL. This advanced escape hatch is only surfaced when at least one configured driver declares `providerFetch`:

```ts
const response = await emailkit.providerFetch("/v4/domains", {
  emailDriver: "mailgun",
  method: "GET",
  searchParams: { limit: 25 },
});

if (!response.ok) throw new Error("Provider API failed");
const domains = await response.json();
```

The helper accepts any `fetch` options plus an optional `searchParams` object. Pass absolute URLs when the provider returns fully qualified links (for example, stored attachment URLs); the helper still injects auth headers.

### Next.js adapter (optional)

Single-driver route:

```ts
import { createNextEmailKitHandler } from "emailkit/nextjs";

export const { GET, POST } = createNextEmailKitHandler(emailkit);
```

Multi-driver route, for example `app/api/email/[emailDriver]/route.ts`:

```ts
import { createNextEmailKitHandler } from "emailkit/nextjs";

export const { GET, POST } = createNextEmailKitHandler(emailkit, {
  emailDriver: async (_request, context) => {
    const params = await context.params;
    return params.emailDriver;
  },
});
```

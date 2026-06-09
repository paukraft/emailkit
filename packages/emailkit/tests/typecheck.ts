import { EmailKit, type EmailDriver } from "../src";
import type { WebhookLifecycleTarget, WebhookScope } from "../src";

declare const plainDriver: EmailDriver<any, {}, "plain-driver">;
declare const fetchDriver: EmailDriver<
  any,
  { providerFetch: true },
  "fetch-driver"
>;
declare const senderDriver: EmailDriver<
  any,
  { senderAuth: true; senderMailbox: true },
  "sender-driver"
>;
declare const accountWebhookSetupDriver: EmailDriver<
  any,
  { webhooks: { account: { setup: true } } },
  "account-setup-driver"
>;

const providerFetchClient = EmailKit({
  emailDrivers: [fetchDriver, plainDriver],
  resolveEmailDriver: () => "fetch-driver",
});
providerFetchClient.providerFetch("/v1/messages", {
  emailDriver: "fetch-driver",
});
providerFetchClient.providerFetch("/v1/messages", {
  // @ts-expect-error providerFetch cannot select drivers that do not declare providerFetch.
  emailDriver: "plain-driver",
});

const plainClient = EmailKit({ emailDrivers: [plainDriver] });
// @ts-expect-error providerFetch is absent without a supporting driver.
plainClient.providerFetch("/v1/messages");

EmailKit({
  emailDrivers: [senderDriver, plainDriver],
  resolveEmailDriver: () => ({
    emailDriver: "sender-driver" as const,
    auth: { accessToken: "access_123" },
    mailbox: { id: "mbx_123", email: "sender@example.com" },
  }),
});

EmailKit({
  emailDrivers: [senderDriver, plainDriver],
  // @ts-expect-error resolver sender.auth requires the selected driver to declare senderAuth.
  resolveEmailDriver: () => ({
    emailDriver: "plain-driver" as const,
    auth: { accessToken: "access_123" },
  }),
});

const senderClient = EmailKit({
  emailDrivers: [senderDriver, plainDriver],
  resolveEmailDriver: () => "sender-driver",
});
senderClient.sendEmail({
  from: { email: "sender@example.com" },
  to: { email: "recipient@example.com" },
  subject: "With sender auth",
  sender: {
    emailDriver: "sender-driver" as const,
    auth: { accessToken: "access_123" },
    mailbox: { id: "mbx_123", email: "sender@example.com" },
  },
});
senderClient.sendEmail({
  from: { email: "sender@example.com" },
  to: { email: "recipient@example.com" },
  subject: "Unsupported sender auth",
  sender: {
    emailDriver: "plain-driver" as const,
    // @ts-expect-error sender.auth requires the selected driver to declare senderAuth.
    auth: { accessToken: "access_123" },
  },
});

const accountWebhookSetupClient = EmailKit({
  emailDrivers: [accountWebhookSetupDriver],
});
accountWebhookSetupClient.webhooks.setup({
  url: "https://example.com/webhook",
  events: "all",
});
// @ts-expect-error refresh is absent unless a driver declares account webhook refresh support.
accountWebhookSetupClient.webhooks.refresh({ id: "webhook_123" });

const webhookScope: WebhookScope = "account";
const webhookTarget: WebhookLifecycleTarget = { mailboxId: "mbx_123" };
// @ts-expect-error address is not a public webhook scope.
const addressScope: WebhookScope = "address";
// @ts-expect-error address is not a public webhook lifecycle target.
const addressTarget: WebhookLifecycleTarget = { address: "sender@example.com" };

void webhookScope;
void webhookTarget;
void addressScope;
void addressTarget;

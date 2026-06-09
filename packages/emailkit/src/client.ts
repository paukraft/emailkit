/**
 * EmailKit client implementation
 */

import { checkClickBot, checkOpenBot } from "./bot-detect";
import type {
  DriverAuthUpdate,
  DriverCapabilitiesType,
  DriverCallbackResult,
  DriverDomainsAPI,
  DriverId,
  DriverMailboxesAPI,
  DriverWebhooksAPI,
  EmailDriver,
  ProviderFetch,
  ProviderFetchInit,
} from "./driver";
import type {
  AccountWebhookDeleteInput,
  AccountWebhookDeleteResult,
  AccountWebhookRefreshInput,
  AccountWebhookRefreshResult,
  AccountWebhookSetupInput,
  AccountWebhookSetupResult,
  Attachment,
  ConnectMailboxInput,
  CreateDomainInput,
  CreateMailboxInput,
  Domain,
  DomainEnsureResult,
  DomainIdentifier,
  DomainIdentifierType,
  DomainOperationInput,
  DomainWebhookDeleteInput,
  DomainWebhookDeleteResult,
  DomainWebhookRefreshInput,
  DomainWebhookRefreshResult,
  DomainWebhookSetupInput,
  DomainWebhookSetupResult,
  DomainVerification,
  DriverCapabilities,
  DriverPublicRoutes,
  DriverPublicRouteCapabilities,
  DriverSendTrackingCapabilities,
  DriverDomainCapabilities,
  DriverWebhookCapabilities,
  DriverWebhookMethodCapabilities,
  EmailKitHooks,
  EmailMessage,
  EmailSenderOverride,
  EmailTag,
  ListDomainsOptions,
  ListMailboxesOptions,
  Mailbox,
  MailboxIdentity,
  MailboxConnectionResult,
  MailboxWebhookDeleteInput,
  MailboxWebhookDeleteResult,
  MailboxWebhookRefreshInput,
  MailboxWebhookRefreshResult,
  MailboxWebhookSetupInput,
  MailboxWebhookSetupResult,
  PublicRouteDriverConfig,
  PublicRouteGroup,
  PublicRouteTemplate,
  PublicRoutesConfig,
  SendEmailResult,
  UpdateDomainInput,
  Webhook,
  WebhookDriverEvent,
  WebhookLifecycleAction,
  WebhookLifecycleDriverEvent,
  WebhookLifecycleHookEvent,
  WebhookLifecycleReason,
  WebhookLifecycleSource,
  WebhookLifecycleTarget,
  WebhookRecommendedAction,
  WebhookRequest,
  WebhookResponse,
  WebhookScope,
  WebhookStatus,
} from "./types";
import { EmailKitError } from "./types";

export type EmailDriverTuple = readonly [
  EmailDriver<any, any, string>,
  ...EmailDriver<any, any, string>[],
];

type ConfiguredDriver<TDrivers extends EmailDriverTuple> = TDrivers[number];
type ConfiguredDriverId<TDrivers extends EmailDriverTuple> = DriverId<
  ConfiguredDriver<TDrivers>
>;
type HasMultiple<TItems extends readonly unknown[]> = TItems extends readonly [
  unknown,
  unknown,
  ...unknown[],
]
  ? true
  : false;

type CapabilityDriverId<
  TDrivers extends EmailDriverTuple,
  TCapability extends keyof DriverCapabilities,
> =
  ConfiguredDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? DriverCapabilitiesType<TDriver> extends infer TCapabilities extends
          DriverCapabilities
        ? keyof TCapabilities extends never
          ? never
          : DriverCapabilities extends TCapabilities
            ? DriverId<TDriver>
            : TCapabilities[TCapability] extends true
              ? DriverId<TDriver>
              : never
        : never
      : never
    : never;

type OperationSelector<TDriverId extends string> = [TDriverId] extends [never]
  ? { emailDriver: never }
  : { emailDriver?: TDriverId };

type DriverDomainMethod = keyof DriverDomainsAPI;

type DomainCapabilitiesSupportMethod<
  TCapabilities extends DriverCapabilities,
  TMethod extends DriverDomainMethod,
> = TCapabilities["domains"] extends DriverDomainCapabilities
  ? TCapabilities["domains"][TMethod] extends true
    ? true
    : false
  : false;

type DomainMethodDriverId<
  TDrivers extends EmailDriverTuple,
  TMethod extends DriverDomainMethod,
> =
  ConfiguredDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? DriverCapabilitiesType<TDriver> extends infer TCapabilities extends
          DriverCapabilities
        ? DomainCapabilitiesSupportMethod<TCapabilities, TMethod> extends true
          ? DriverId<TDriver>
          : never
        : never
      : never
    : never;

type DomainEnsureDriverId<TDrivers extends EmailDriverTuple> =
  ConfiguredDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? DriverCapabilitiesType<TDriver> extends infer TCapabilities extends
          DriverCapabilities
        ? DomainCapabilitiesSupportMethod<TCapabilities, "create"> extends true
          ? DomainCapabilitiesSupportMethod<TCapabilities, "get"> extends true
            ? DomainCapabilitiesSupportMethod<
                TCapabilities,
                "list"
              > extends true
              ? DriverId<TDriver>
              : never
            : never
          : never
        : never
      : never
    : never;
type MailboxConnectDriverId<TDrivers extends EmailDriverTuple> =
  CapabilityDriverId<TDrivers, "mailboxConnect">;
type MailboxCreateDriverId<TDrivers extends EmailDriverTuple> =
  CapabilityDriverId<TDrivers, "mailboxCreate">;
type MailboxListDriverId<TDrivers extends EmailDriverTuple> =
  CapabilityDriverId<TDrivers, "mailboxList">;
type MailboxGetDriverId<TDrivers extends EmailDriverTuple> = CapabilityDriverId<
  TDrivers,
  "mailboxGet"
>;
type MailboxDeleteDriverId<TDrivers extends EmailDriverTuple> =
  CapabilityDriverId<TDrivers, "mailboxDelete">;
type WebhookCapabilityDriverId<
  TDrivers extends EmailDriverTuple,
  TScope extends keyof DriverWebhookCapabilities,
  TMethod extends keyof DriverWebhookMethodCapabilities,
> =
  ConfiguredDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? DriverCapabilitiesType<TDriver> extends infer TCapabilities extends
          DriverCapabilities
        ? keyof TCapabilities extends never
          ? never
          : DriverCapabilities extends TCapabilities
            ? DriverId<TDriver>
            : TCapabilities["webhooks"] extends infer TWebhooks
              ? TWebhooks extends DriverWebhookCapabilities
                ? TWebhooks[TScope] extends true
                  ? DriverId<TDriver>
                  : TWebhooks[TScope] extends DriverWebhookMethodCapabilities
                    ? TWebhooks[TScope][TMethod] extends true
                      ? DriverId<TDriver>
                      : never
                    : never
                : never
              : never
        : never
      : never
    : never;
type AccountWebhookMethodDriverId<
  TDrivers extends EmailDriverTuple,
  TMethod extends keyof DriverWebhookMethodCapabilities,
> = WebhookCapabilityDriverId<TDrivers, "account", TMethod>;
type MailboxWebhookMethodDriverId<
  TDrivers extends EmailDriverTuple,
  TMethod extends keyof DriverWebhookMethodCapabilities,
> = WebhookCapabilityDriverId<TDrivers, "mailbox", TMethod>;
type DomainWebhookMethodDriverId<
  TDrivers extends EmailDriverTuple,
  TMethod extends keyof DriverWebhookMethodCapabilities,
> = WebhookCapabilityDriverId<TDrivers, "domain", TMethod>;
type AnyWebhookMethodDriverId<
  TDrivers extends EmailDriverTuple,
  TScope extends keyof DriverWebhookCapabilities,
> =
  | WebhookCapabilityDriverId<TDrivers, TScope, "setup">
  | WebhookCapabilityDriverId<TDrivers, TScope, "refresh">
  | WebhookCapabilityDriverId<TDrivers, TScope, "delete">;
type AccountWebhookDriverId<TDrivers extends EmailDriverTuple> =
  AnyWebhookMethodDriverId<TDrivers, "account">;
type MailboxWebhookDriverId<TDrivers extends EmailDriverTuple> =
  AnyWebhookMethodDriverId<TDrivers, "mailbox">;
type DomainWebhookDriverId<TDrivers extends EmailDriverTuple> =
  AnyWebhookMethodDriverId<TDrivers, "domain">;
type ProviderFetchDriverId<TDrivers extends EmailDriverTuple> =
  CapabilityDriverId<TDrivers, "providerFetch">;
type EmailSenderOverrideForConfiguredDrivers<
  TDrivers extends EmailDriverTuple,
> =
  ConfiguredDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? EmailSenderOverride<DriverId<TDriver>, DriverCapabilitiesType<TDriver>>
      : never
    : never;

type ConnectMailboxDriver<TDrivers extends EmailDriverTuple> =
  ConfiguredDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? DriverCapabilitiesType<TDriver>["mailboxConnect"] extends true
        ? TDriver
        : never
      : never
    : never;

type ConnectMailboxInputForDriver<TDriver extends EmailDriver> =
  ConnectMailboxInput<DriverCapabilitiesType<TDriver>>;

type ConnectMailboxInputForDriverId<
  TDrivers extends EmailDriverTuple,
  TDriverId extends MailboxConnectDriverId<TDrivers>,
> = ConnectMailboxInputForDriver<
  Extract<ConnectMailboxDriver<TDrivers>, EmailDriver<any, any, TDriverId>>
>;

type ConnectMailboxInputForConfiguredDrivers<
  TDrivers extends EmailDriverTuple,
> =
  ConnectMailboxDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? ConnectMailboxInputForDriver<TDriver> &
          OperationSelector<DriverId<TDriver>>
      : never
    : never;

type MailboxConnectFacade<TDrivers extends EmailDriverTuple> = {
  <TDriverId extends MailboxConnectDriverId<TDrivers>>(
    emailDriver: TDriverId,
    input?: ConnectMailboxInputForDriverId<TDrivers, TDriverId>,
  ): Promise<MailboxConnectionResult>;
  (
    input?: ConnectMailboxInputForConfiguredDrivers<TDrivers>,
  ): Promise<MailboxConnectionResult>;
};

type EmailMessageForDriver<TDriver extends EmailDriver> = EmailMessage<
  DriverCapabilitiesType<TDriver>,
  EmailTag
>;

type DriverCapabilityValue<
  TDriver extends EmailDriver,
  TCapability extends keyof DriverCapabilities,
> =
  DriverCapabilitiesType<TDriver> extends infer TCapabilities extends
    DriverCapabilities
    ? TCapabilities[TCapability]
    : never;

type ConfiguredCapabilityValues<
  TDrivers extends EmailDriverTuple,
  TCapability extends keyof DriverCapabilities,
> =
  ConfiguredDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? DriverCapabilityValue<TDriver, TCapability>
      : never
    : never;

type AllConfiguredDriversSupport<
  TDrivers extends EmailDriverTuple,
  TCapability extends keyof DriverCapabilities,
> =
  Exclude<ConfiguredCapabilityValues<TDrivers, TCapability>, true> extends never
    ? true
    : false;

type DriverSupportsReplyHeaders<TCapabilities extends DriverCapabilities> =
  TCapabilities["replyHeaders"] extends true ? true : false;

type DriverSupportsReplyThreadId<TCapabilities extends DriverCapabilities> =
  TCapabilities["replyThreadId"] extends true ? true : false;

type ConfiguredReplyHeadersSupportValues<TDrivers extends EmailDriverTuple> =
  ConfiguredDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? DriverCapabilitiesType<TDriver> extends infer TCapabilities extends
          DriverCapabilities
        ? DriverSupportsReplyHeaders<TCapabilities>
        : never
      : never
    : never;

type ConfiguredReplyThreadIdSupportValues<TDrivers extends EmailDriverTuple> =
  ConfiguredDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? DriverCapabilitiesType<TDriver> extends infer TCapabilities extends
          DriverCapabilities
        ? DriverSupportsReplyThreadId<TCapabilities>
        : never
      : never
    : never;

type AllConfiguredDriversSupportReplyHeaders<
  TDrivers extends EmailDriverTuple,
> =
  Exclude<ConfiguredReplyHeadersSupportValues<TDrivers>, true> extends never
    ? true
    : false;

type AllConfiguredDriversSupportReplyThreadId<
  TDrivers extends EmailDriverTuple,
> =
  Exclude<ConfiguredReplyThreadIdSupportValues<TDrivers>, true> extends never
    ? true
    : false;

type DriverSupportsSendTrackingKind<
  TCapabilities extends DriverCapabilities,
  TKind extends keyof DriverSendTrackingCapabilities,
> = TCapabilities["sendTracking"] extends DriverSendTrackingCapabilities
  ? TCapabilities["sendTracking"][TKind] extends true
    ? true
    : false
  : false;

type ConfiguredSendTrackingSupportValues<
  TDrivers extends EmailDriverTuple,
  TKind extends keyof DriverSendTrackingCapabilities,
> =
  ConfiguredDriver<TDrivers> extends infer TDriver
    ? TDriver extends EmailDriver<any, any, string>
      ? DriverCapabilitiesType<TDriver> extends infer TCapabilities extends
          DriverCapabilities
        ? DriverSupportsSendTrackingKind<TCapabilities, TKind>
        : never
      : never
    : never;

type AllConfiguredDriversSupportSendTracking<
  TDrivers extends EmailDriverTuple,
  TKind extends keyof DriverSendTrackingCapabilities,
> =
  Exclude<
    ConfiguredSendTrackingSupportValues<TDrivers, TKind>,
    true
  > extends never
    ? true
    : false;

type CommonSendCapabilities<TDrivers extends EmailDriverTuple> = {
  cc: AllConfiguredDriversSupport<TDrivers, "cc">;
  bcc: AllConfiguredDriversSupport<TDrivers, "bcc">;
  replyTo: AllConfiguredDriversSupport<TDrivers, "replyTo">;
  replyHeaders: AllConfiguredDriversSupportReplyHeaders<TDrivers>;
  replyThreadId: AllConfiguredDriversSupportReplyThreadId<TDrivers>;
  attachments: AllConfiguredDriversSupport<TDrivers, "attachments">;
  customHeaders: AllConfiguredDriversSupport<TDrivers, "customHeaders">;
  tags: AllConfiguredDriversSupport<TDrivers, "tags">;
  metadata: AllConfiguredDriversSupport<TDrivers, "metadata">;
  templates: AllConfiguredDriversSupport<TDrivers, "templates">;
  personalizations: AllConfiguredDriversSupport<TDrivers, "personalizations">;
  scheduling: AllConfiguredDriversSupport<TDrivers, "scheduling">;
  unsubscribe: AllConfiguredDriversSupport<TDrivers, "unsubscribe">;
  sendTracking: {
    opens: AllConfiguredDriversSupportSendTracking<TDrivers, "opens">;
    clicks: AllConfiguredDriversSupportSendTracking<TDrivers, "clicks">;
  };
  sandbox: AllConfiguredDriversSupport<TDrivers, "sandbox">;
  sendIdempotency: AllConfiguredDriversSupport<TDrivers, "sendIdempotency">;
  tenantRouting: AllConfiguredDriversSupport<TDrivers, "tenantRouting">;
};

type SendEmailMessageWithoutExplicitDriver<TDrivers extends EmailDriverTuple> =
  Omit<EmailMessage<CommonSendCapabilities<TDrivers>, EmailTag>, "sender"> & {
    sender?: undefined;
  };

type SendEmailMessageForSelectedDriver<TDriver extends EmailDriver> = Omit<
  EmailMessageForDriver<TDriver>,
  "sender"
> & {
  sender: EmailSenderOverride<
    DriverId<TDriver>,
    DriverCapabilitiesType<TDriver>
  >;
};

export type SendEmailMessage<TDrivers extends EmailDriverTuple> =
  | SendEmailMessageWithoutExplicitDriver<TDrivers>
  | (ConfiguredDriver<TDrivers> extends infer TDriver
      ? TDriver extends EmailDriver<any, any, string>
        ? SendEmailMessageForSelectedDriver<TDriver>
        : never
      : never);

export type EmailDriverSelection<TDriverId extends string = string> =
  | TDriverId
  | EmailSenderOverride<TDriverId>;

export type ResolveEmailDriverContext<TDrivers extends EmailDriverTuple> =
  | { operation: "sendEmail"; message: SendEmailMessage<TDrivers> }
  | { operation: "providerFetch"; path: string | URL; init?: ProviderFetchInit }
  | { operation: "domains.list"; input?: ListDomainsOptions }
  | { operation: "domains.create"; input: CreateDomainInput }
  | {
      operation:
        | "domains.get"
        | "domains.getOrNull"
        | "domains.update"
        | "domains.verify"
        | "domains.delete"
        | "domains.remove";
      input: DomainOperationInput;
    }
  | { operation: "domains.ensure"; input: CreateDomainInput }
  | { operation: "mailboxes.connect"; input?: ConnectMailboxInput }
  | { operation: "mailboxes.create"; input: CreateMailboxInput }
  | { operation: "mailboxes.list"; input?: ListMailboxesOptions }
  | {
      operation: "mailboxes.get" | "mailboxes.delete";
      input: { idOrEmail: string };
    }
  | {
      operation: "webhooks.setup";
      input: AccountWebhookSetupInput;
    }
  | {
      operation: "webhooks.refresh";
      input: AccountWebhookRefreshInput;
    }
  | {
      operation: "webhooks.delete";
      input: AccountWebhookDeleteInput;
    }
  | {
      operation: "mailboxes.webhooks.setup";
      input: MailboxWebhookSetupInput;
    }
  | {
      operation: "mailboxes.webhooks.refresh";
      input: MailboxWebhookRefreshInput;
    }
  | {
      operation: "mailboxes.webhooks.delete";
      input: MailboxWebhookDeleteInput;
    }
  | {
      operation: "domains.webhooks.setup";
      input: DomainWebhookSetupInput;
    }
  | {
      operation: "domains.webhooks.refresh";
      input: DomainWebhookRefreshInput;
    }
  | {
      operation: "domains.webhooks.delete";
      input: DomainWebhookDeleteInput;
    };

export type ResolveEmailDriver<TDrivers extends EmailDriverTuple> = (
  context: ResolveEmailDriverContext<TDrivers>,
) =>
  | ConfiguredDriverId<TDrivers>
  | EmailSenderOverrideForConfiguredDrivers<TDrivers>
  | Promise<
      | ConfiguredDriverId<TDrivers>
      | EmailSenderOverrideForConfiguredDrivers<TDrivers>
    >;

type EmailKitBaseConfig<TDrivers extends EmailDriverTuple> = {
  emailDrivers: TDrivers;
  hooks?: EmailKitHooks;
  publicRoutes?: PublicRoutesConfig;
};

type EmailKitSenderConfig<TDrivers extends EmailDriverTuple> =
  HasMultiple<TDrivers> extends true
    ? { resolveEmailDriver: ResolveEmailDriver<TDrivers> }
    : { resolveEmailDriver?: ResolveEmailDriver<TDrivers> };

type EmailKitSecretConfig = {
  /**
   * Secret used by drivers that sign callback state or OAuth flows.
   * Defaults to the EMAILKIT_SECRET environment variable when omitted.
   */
  secret?: string;
};

/**
 * Configuration for creating an EmailKit client.
 */
export type EmailKitConfig<TDrivers extends EmailDriverTuple> =
  EmailKitBaseConfig<TDrivers> &
    EmailKitSenderConfig<TDrivers> &
    EmailKitSecretConfig;

const EMAILKIT_SECRET_ENV = "EMAILKIT_SECRET";
const PUBLIC_BASE_URL_ENV = "PUBLIC_BASE_URL";
const DEFAULT_PUBLIC_ROUTE = "/api/email/:emailDriverId";

type ResolvedPublicRoutesConfig = Omit<
  PublicRoutesConfig,
  "baseUrl" | "route"
> & {
  baseUrl?: string;
  route: PublicRouteTemplate;
};

const readEnv = (name: string): string | undefined => {
  const processGlobal = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return processGlobal.process?.env?.[name] || undefined;
};

const resolveEmailKitSecret = (
  secret: string | undefined,
): string | undefined => {
  if (secret) return secret;

  return readEnv(EMAILKIT_SECRET_ENV);
};

const resolvePublicRoutesConfig = (
  publicRoutes: PublicRoutesConfig | undefined,
): ResolvedPublicRoutesConfig | undefined => {
  const baseUrl = publicRoutes?.baseUrl || readEnv(PUBLIC_BASE_URL_ENV);
  if (!publicRoutes && !baseUrl) return undefined;

  return {
    ...publicRoutes,
    route: publicRoutes?.route || DEFAULT_PUBLIC_ROUTE,
    ...(baseUrl ? { baseUrl } : {}),
  };
};

const normalizeBaseUrl = (baseUrl: string): string => {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Unsupported protocol");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch (error) {
    throw new EmailKitError(
      "publicRoutes.baseUrl must be an absolute URL",
      "emailkit",
      "INVALID_CONFIG",
      undefined,
      error,
    );
  }
};

const routeForDriver = (
  group: PublicRouteGroup | undefined,
  driverId: string,
): PublicRouteDriverConfig | undefined => {
  return group?.drivers?.[driverId];
};

const routeConfigPath = (
  config: PublicRouteDriverConfig | undefined,
): string | undefined => {
  if (typeof config === "string") return config;
  return config?.route;
};

const lifecycleRouteConfigPath = (
  config: PublicRouteDriverConfig | undefined,
): string | undefined => {
  if (typeof config === "string") return undefined;
  return config?.lifecycle;
};

const interpolateRoute = (route: string, driverId: string): string => {
  for (const match of route.matchAll(
    /(^|[^A-Za-z])(:[A-Za-z][A-Za-z0-9_]*)/g,
  )) {
    if (match[2] === ":emailDriverId") continue;
    throw new EmailKitError(
      `Unsupported public route placeholder: ${match[2]}`,
      "emailkit",
      "INVALID_CONFIG",
    );
  }

  const encoded = encodeURIComponent(driverId);
  return route.replace(/:emailDriverId\b/g, encoded);
};

const isAbsoluteUrl = (value: string): boolean =>
  /^[a-z][a-z\d+.-]*:/i.test(value);

const assertPublicHttpUrl = (url: URL, label: string): void => {
  if (url.protocol === "http:" || url.protocol === "https:") return;
  throw new EmailKitError(
    `${label} must use http or https`,
    "emailkit",
    "INVALID_CONFIG",
  );
};

const resolvePublicUrl = (
  publicRoutes: ResolvedPublicRoutesConfig | undefined,
  route: string | undefined,
  driverId: string,
): string | undefined => {
  if (!route) return undefined;
  if (!publicRoutes) {
    throw new EmailKitError(
      "publicRoutes is required to resolve public EmailKit routes",
      "emailkit",
      "INVALID_CONFIG",
    );
  }

  const interpolated = interpolateRoute(route, driverId);
  if (isAbsoluteUrl(interpolated)) {
    const url = new URL(interpolated);
    assertPublicHttpUrl(url, "public route");
    url.hash = "";
    return url.toString();
  }

  if (!publicRoutes.baseUrl) {
    throw new EmailKitError(
      "publicRoutes.baseUrl or PUBLIC_BASE_URL is required to resolve relative public EmailKit routes",
      "emailkit",
      "INVALID_CONFIG",
    );
  }

  const baseUrl = normalizeBaseUrl(publicRoutes.baseUrl);
  const path = interpolated.startsWith("/") ? interpolated : `/${interpolated}`;
  const url = new URL(path, `${baseUrl}/`);
  assertPublicHttpUrl(url, "public route");
  url.hash = "";
  return url.toString();
};

const supportsPublicRoute = (
  driver: EmailDriver,
  route: keyof DriverPublicRouteCapabilities,
): boolean => driver.capabilities.publicRoutes?.[route] === true;

const resolveDriverWebhookRoutes = (
  publicRoutes: PublicRoutesConfig | undefined,
  driver: EmailDriver,
): Pick<DriverPublicRoutes, "webhookUrl" | "lifecycleWebhookUrl"> => {
  if (!supportsPublicRoute(driver, "webhook")) return {};
  const resolvedPublicRoutes = resolvePublicRoutesConfig(publicRoutes);
  if (!resolvedPublicRoutes) return {};
  const driverRoute = routeForDriver(
    resolvedPublicRoutes.webhookRoutes,
    driver.id,
  );
  const route =
    routeConfigPath(driverRoute) ||
    resolvedPublicRoutes.webhookRoutes?.route ||
    resolvedPublicRoutes.route;
  const lifecycleRoute = lifecycleRouteConfigPath(driverRoute);
  const webhookUrl = resolvePublicUrl(resolvedPublicRoutes, route, driver.id);
  const lifecycleWebhookUrl = supportsPublicRoute(driver, "lifecycleWebhook")
    ? lifecycleRoute
      ? resolvePublicUrl(resolvedPublicRoutes, lifecycleRoute, driver.id)
      : webhookUrl
    : undefined;
  return {
    ...(webhookUrl ? { webhookUrl } : {}),
    ...(lifecycleWebhookUrl ? { lifecycleWebhookUrl } : {}),
  };
};

const resolveDriverConnectCallbackUrl = (
  publicRoutes: PublicRoutesConfig | undefined,
  driver: EmailDriver,
): string | undefined => {
  if (!supportsPublicRoute(driver, "connectCallback")) return undefined;
  const resolvedPublicRoutes = resolvePublicRoutesConfig(publicRoutes);
  if (!resolvedPublicRoutes) return undefined;
  const driverRoute = routeForDriver(
    resolvedPublicRoutes.connectCallbackRoutes,
    driver.id,
  );
  const route =
    routeConfigPath(driverRoute) ||
    resolvedPublicRoutes.connectCallbackRoutes?.route ||
    resolvedPublicRoutes.route;
  return resolvePublicUrl(resolvedPublicRoutes, route, driver.id);
};

const resolveLandingUrl = (
  publicRoutes: PublicRoutesConfig | undefined,
  value: string | undefined,
): string | undefined => {
  if (!value) return undefined;
  const resolvedPublicRoutes = resolvePublicRoutesConfig(publicRoutes);
  if (!resolvedPublicRoutes) {
    throw new EmailKitError(
      "publicRoutes is required to resolve connect landing URLs",
      "emailkit",
      "INVALID_CONFIG",
    );
  }

  if (!resolvedPublicRoutes.baseUrl) {
    throw new EmailKitError(
      "publicRoutes.baseUrl or PUBLIC_BASE_URL is required to resolve connect landing URLs",
      "emailkit",
      "INVALID_CONFIG",
    );
  }

  const baseUrl = normalizeBaseUrl(resolvedPublicRoutes.baseUrl);
  const base = new URL(baseUrl);
  const url = isAbsoluteUrl(value)
    ? new URL(value)
    : new URL(value.startsWith("/") ? value : `/${value}`, `${baseUrl}/`);
  assertPublicHttpUrl(url, "Connect landing URL");
  const allowedOrigins = new Set([
    base.origin,
    ...(resolvedPublicRoutes.allowedLandingOrigins || []).map((origin) => {
      const allowed = new URL(origin);
      assertPublicHttpUrl(allowed, "publicRoutes.allowedLandingOrigins");
      return allowed.origin;
    }),
  ]);
  if (!allowedOrigins.has(url.origin)) {
    throw new EmailKitError(
      `Connect landing URL origin is not allowed: ${url.origin}`,
      "emailkit",
      "INVALID_CONFIG",
    );
  }
  return url.toString();
};

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c] as string,
  );

const htmlResponse = (
  status: number,
  title: string,
  message: string,
  detail?: string,
): WebhookResponse => {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const detailHtml = detail
    ? `<p class="detail">${escapeHtml(detail)}</p>`
    : "";
  return {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><style>body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#fafafa;color:#111}.wrap{max-width:34rem;padding:2rem;text-align:center}h1{font-size:1.4rem;margin:0 0 .6rem}p{margin:0;color:#555;line-height:1.5}p.detail{margin-top:.75rem;font-size:.9rem;color:#222}</style></head><body><main class="wrap"><h1>${safeTitle}</h1><p>${safeMessage}</p>${detailHtml}</main></body></html>`,
  };
};

const redirectResponse = (url: string): WebhookResponse => ({
  status: 302,
  headers: { Location: url },
});

export interface BaseEmailKitClient<TDrivers extends EmailDriverTuple> {
  sendEmail: (
    message: SendEmailMessage<TDrivers>,
    options?: { signal?: AbortSignal },
  ) => Promise<SendEmailResult>;
  handler: () => (request: WebhookRequest) => Promise<WebhookResponse>;
  emailDrivers: TDrivers;
  getDriver: <TDriverId extends ConfiguredDriverId<TDrivers>>(
    id: TDriverId,
  ) => Extract<ConfiguredDriver<TDrivers>, EmailDriver<any, any, TDriverId>>;
  attachments: AttachmentsFacade;
  domains: DomainsFacade<TDrivers>;
  mailboxes: MailboxesFacade<TDrivers>;
}

export interface ProviderFetchFacade<
  TDrivers extends EmailDriverTuple = EmailDriverTuple,
> {
  (
    path: string | URL,
    init?: ProviderFetchInit & {
      emailDriver?: ProviderFetchDriverId<TDrivers>;
    },
  ): Promise<Response>;
}

export type EmailKitClient<TDrivers extends EmailDriverTuple> =
  BaseEmailKitClient<TDrivers> &
    ([ProviderFetchDriverId<TDrivers>] extends [never]
      ? {}
      : { providerFetch: ProviderFetchFacade<TDrivers> }) &
    ([AccountWebhookDriverId<TDrivers>] extends [never]
      ? {}
      : { webhooks: AccountWebhooksFacade<TDrivers> });

export type AccountWebhooksFacade<
  TDrivers extends EmailDriverTuple = EmailDriverTuple,
> = ([AccountWebhookMethodDriverId<TDrivers, "setup">] extends [never]
  ? {}
  : {
      setup: (
        input: AccountWebhookSetupInput &
          OperationSelector<AccountWebhookMethodDriverId<TDrivers, "setup">>,
      ) => Promise<AccountWebhookSetupResult>;
    }) &
  ([AccountWebhookMethodDriverId<TDrivers, "refresh">] extends [never]
    ? {}
    : {
        refresh: (
          input: AccountWebhookRefreshInput &
            OperationSelector<
              AccountWebhookMethodDriverId<TDrivers, "refresh">
            >,
        ) => Promise<AccountWebhookRefreshResult>;
      }) &
  ([AccountWebhookMethodDriverId<TDrivers, "delete">] extends [never]
    ? {}
    : {
        delete: (
          input: AccountWebhookDeleteInput &
            OperationSelector<AccountWebhookMethodDriverId<TDrivers, "delete">>,
        ) => Promise<AccountWebhookDeleteResult>;
      });

export type MailboxWebhooksFacade<
  TDrivers extends EmailDriverTuple = EmailDriverTuple,
> = ([MailboxWebhookMethodDriverId<TDrivers, "setup">] extends [never]
  ? {}
  : {
      setup: (
        input: MailboxWebhookSetupInput &
          OperationSelector<MailboxWebhookMethodDriverId<TDrivers, "setup">>,
      ) => Promise<MailboxWebhookSetupResult>;
    }) &
  ([MailboxWebhookMethodDriverId<TDrivers, "refresh">] extends [never]
    ? {}
    : {
        refresh: (
          input: MailboxWebhookRefreshInput &
            OperationSelector<
              MailboxWebhookMethodDriverId<TDrivers, "refresh">
            >,
        ) => Promise<MailboxWebhookRefreshResult>;
      }) &
  ([MailboxWebhookMethodDriverId<TDrivers, "delete">] extends [never]
    ? {}
    : {
        delete: (
          input: MailboxWebhookDeleteInput &
            OperationSelector<MailboxWebhookMethodDriverId<TDrivers, "delete">>,
        ) => Promise<MailboxWebhookDeleteResult>;
      });

export type DomainWebhooksFacade<
  TDrivers extends EmailDriverTuple = EmailDriverTuple,
> = ([DomainWebhookMethodDriverId<TDrivers, "setup">] extends [never]
  ? {}
  : {
      setup: (
        input: DomainWebhookSetupInput &
          OperationSelector<DomainWebhookMethodDriverId<TDrivers, "setup">>,
      ) => Promise<DomainWebhookSetupResult>;
    }) &
  ([DomainWebhookMethodDriverId<TDrivers, "refresh">] extends [never]
    ? {}
    : {
        refresh: (
          input: DomainWebhookRefreshInput &
            OperationSelector<DomainWebhookMethodDriverId<TDrivers, "refresh">>,
        ) => Promise<DomainWebhookRefreshResult>;
      }) &
  ([DomainWebhookMethodDriverId<TDrivers, "delete">] extends [never]
    ? {}
    : {
        delete: (
          input: DomainWebhookDeleteInput &
            OperationSelector<DomainWebhookMethodDriverId<TDrivers, "delete">>,
        ) => Promise<DomainWebhookDeleteResult>;
      });

export type DomainsFacade<
  TDrivers extends EmailDriverTuple = EmailDriverTuple,
> = DomainsBaseFacade<TDrivers> &
  ([DomainWebhookDriverId<TDrivers>] extends [never]
    ? {}
    : { webhooks: DomainWebhooksFacade<TDrivers> });

export type DomainsBaseFacade<
  TDrivers extends EmailDriverTuple = EmailDriverTuple,
> = ([DomainMethodDriverId<TDrivers, "list">] extends [never]
  ? {}
  : {
      list: (
        opts?: ListDomainsOptions &
          OperationSelector<DomainMethodDriverId<TDrivers, "list">>,
      ) => Promise<Domain[]>;
    }) &
  ([DomainMethodDriverId<TDrivers, "create">] extends [never]
    ? {}
    : {
        create: (
          input: CreateDomainInput &
            OperationSelector<DomainMethodDriverId<TDrivers, "create">>,
        ) => Promise<Domain>;
      }) &
  ([DomainMethodDriverId<TDrivers, "get">] extends [never]
    ? {}
    : {
        get: (
          identifier: DomainOperationInput &
            OperationSelector<DomainMethodDriverId<TDrivers, "get">>,
        ) => Promise<Domain>;
        getOrNull: (
          identifier: DomainOperationInput &
            OperationSelector<DomainMethodDriverId<TDrivers, "get">>,
        ) => Promise<Domain | null>;
      }) &
  ([DomainEnsureDriverId<TDrivers>] extends [never]
    ? {}
    : {
        ensure: (
          input: CreateDomainInput &
            OperationSelector<DomainEnsureDriverId<TDrivers>>,
        ) => Promise<DomainEnsureResult>;
      }) &
  ([DomainMethodDriverId<TDrivers, "update">] extends [never]
    ? {}
    : {
        update: (
          identifier: DomainOperationInput &
            OperationSelector<DomainMethodDriverId<TDrivers, "update">>,
          patch: UpdateDomainInput,
        ) => Promise<Domain>;
      }) &
  ([DomainMethodDriverId<TDrivers, "verify">] extends [never]
    ? {}
    : {
        verify: (
          identifier: DomainOperationInput &
            OperationSelector<DomainMethodDriverId<TDrivers, "verify">>,
        ) => Promise<DomainVerification>;
      }) &
  ([DomainMethodDriverId<TDrivers, "delete">] extends [never]
    ? {}
    : {
        delete: (
          identifier: DomainOperationInput &
            OperationSelector<DomainMethodDriverId<TDrivers, "delete">>,
        ) => Promise<{ deleted: boolean }>;
        remove: (
          identifier: DomainOperationInput &
            OperationSelector<DomainMethodDriverId<TDrivers, "delete">>,
        ) => Promise<{ deleted: boolean }>;
      });

export type MailboxesFacade<
  TDrivers extends EmailDriverTuple = EmailDriverTuple,
> = MailboxesBaseFacade<TDrivers> &
  ([MailboxWebhookDriverId<TDrivers>] extends [never]
    ? {}
    : { webhooks: MailboxWebhooksFacade<TDrivers> });

export type MailboxesBaseFacade<
  TDrivers extends EmailDriverTuple = EmailDriverTuple,
> = ([MailboxConnectDriverId<TDrivers>] extends [never]
  ? {}
  : {
      connect: MailboxConnectFacade<TDrivers>;
    }) &
  ([MailboxCreateDriverId<TDrivers>] extends [never]
    ? {}
    : {
        create: (
          input: CreateMailboxInput &
            OperationSelector<MailboxCreateDriverId<TDrivers>>,
        ) => Promise<Mailbox>;
      }) &
  ([MailboxListDriverId<TDrivers>] extends [never]
    ? {}
    : {
        list: (
          opts?: ListMailboxesOptions &
            OperationSelector<MailboxListDriverId<TDrivers>>,
        ) => Promise<Mailbox[]>;
      }) &
  ([MailboxGetDriverId<TDrivers>] extends [never]
    ? {}
    : {
        get: (
          identifier: { idOrEmail: string } & OperationSelector<
            MailboxGetDriverId<TDrivers>
          >,
        ) => Promise<Mailbox>;
      }) &
  ([MailboxDeleteDriverId<TDrivers>] extends [never]
    ? {}
    : {
        delete: (
          identifier: { idOrEmail: string } & OperationSelector<
            MailboxDeleteDriverId<TDrivers>
          >,
        ) => Promise<{ deleted: boolean }>;
      });

export interface AttachmentsFacade {
  getContent: (
    attachment: Attachment,
    opts?: { emailDriver?: string },
  ) => Promise<string | Uint8Array>;
}

const attachmentEmailDriver = (
  attachment: Attachment,
  opts: { emailDriver?: string } | undefined,
  defaultProvider: string,
): string | undefined => {
  if (
    opts?.emailDriver !== undefined &&
    attachment.emailDriver !== undefined &&
    opts.emailDriver !== attachment.emailDriver
  ) {
    throw new EmailKitError(
      `Attachment ${attachment.filename} belongs to email driver ${attachment.emailDriver}; ` +
        `received conflicting emailDriver ${opts.emailDriver}`,
      defaultProvider,
      "INVALID_INPUT",
    );
  }

  return opts?.emailDriver ?? attachment.emailDriver;
};

const withAttachmentEmailDriver = <TData>(
  data: TData,
  emailDriver: string,
): TData => {
  if (!data || typeof data !== "object") return data;

  const record = data as Record<string, unknown>;
  const attachments = Array.isArray(record.attachments)
    ? record.attachments.map((attachment) =>
        attachment && typeof attachment === "object"
          ? { ...(attachment as Record<string, unknown>), emailDriver }
          : attachment,
      )
    : undefined;

  return {
    ...record,
    emailDriver,
    ...(attachments !== undefined ? { attachments } : {}),
  } as TData;
};

const supportsReplyHeaders = (capabilities: DriverCapabilities): boolean =>
  capabilities.replyHeaders === true;

const supportsReplyThreadId = (capabilities: DriverCapabilities): boolean =>
  capabilities.replyThreadId === true;

const supportsSendTrackingKind = (
  capabilities: DriverCapabilities,
  kind: keyof DriverSendTrackingCapabilities,
): boolean => {
  const sendTracking = capabilities.sendTracking;
  return sendTracking?.[kind] === true;
};

const stripUnsupportedSendFields = <TMessage extends Record<string, unknown>>(
  message: TMessage,
  capabilities: DriverCapabilities,
): TMessage => {
  const sanitized: Record<string, unknown> = { ...message };

  if (capabilities.cc !== true) delete sanitized.cc;
  if (capabilities.bcc !== true) delete sanitized.bcc;
  if (capabilities.attachments !== true) delete sanitized.attachments;
  if (capabilities.customHeaders !== true) delete sanitized.headers;
  if (capabilities.tags !== true) delete sanitized.tags;
  if (capabilities.metadata !== true) delete sanitized.metadata;
  if (capabilities.templates !== true) {
    delete sanitized.templateId;
    delete sanitized.templateData;
  }
  if (capabilities.personalizations !== true) {
    delete sanitized.personalizations;
  }
  if (capabilities.scheduling !== true) delete sanitized.sendAt;
  if (capabilities.unsubscribe !== true) delete sanitized.unsubscribe;
  if (capabilities.sandbox !== true) delete sanitized.sandbox;
  if (capabilities.sendIdempotency !== true) delete sanitized.idempotencyKey;
  if (capabilities.tenantRouting !== true) delete sanitized.tenantId;

  const reply = sanitized.reply;
  if (reply && typeof reply === "object" && !Array.isArray(reply)) {
    const replyRecord = reply as Record<string, unknown>;
    const cleanedReply: Record<string, unknown> = {};

    if (capabilities.replyTo === true && "addresses" in replyRecord) {
      cleanedReply.addresses = replyRecord.addresses;
    }
    if (supportsReplyHeaders(capabilities)) {
      if ("messageId" in replyRecord) {
        cleanedReply.messageId = replyRecord.messageId;
      }
      if ("references" in replyRecord) {
        cleanedReply.references = replyRecord.references;
      }
    }
    if (supportsReplyThreadId(capabilities)) {
      if ("threadId" in replyRecord)
        cleanedReply.threadId = replyRecord.threadId;
      if ("isReply" in replyRecord) cleanedReply.isReply = replyRecord.isReply;
    }

    if (Object.keys(cleanedReply).length > 0) {
      sanitized.reply = cleanedReply;
    } else {
      delete sanitized.reply;
    }
  } else if (
    capabilities.replyTo !== true &&
    !supportsReplyHeaders(capabilities) &&
    !supportsReplyThreadId(capabilities)
  ) {
    delete sanitized.reply;
  }

  const track = sanitized.track;
  if (track && typeof track === "object" && !Array.isArray(track)) {
    const trackRecord = track as Record<string, unknown>;
    const cleanedTrack: Record<string, unknown> = {};

    if (
      supportsSendTrackingKind(capabilities, "opens") &&
      "opens" in trackRecord
    ) {
      cleanedTrack.opens = trackRecord.opens;
    }
    if (
      supportsSendTrackingKind(capabilities, "clicks") &&
      "clicks" in trackRecord
    ) {
      cleanedTrack.clicks = trackRecord.clicks;
    }

    if (Object.keys(cleanedTrack).length > 0) {
      sanitized.track = cleanedTrack;
    } else {
      delete sanitized.track;
    }
  } else if (
    !supportsSendTrackingKind(capabilities, "opens") &&
    !supportsSendTrackingKind(capabilities, "clicks")
  ) {
    delete sanitized.track;
  }

  return sanitized as TMessage;
};

const assertSenderCapabilities = (
  driver: EmailDriver,
  sender: EmailSenderOverride<string> | undefined,
): void => {
  if (!sender) return;

  if (
    Object.prototype.hasOwnProperty.call(sender, "auth") &&
    sender.auth !== undefined &&
    driver.capabilities.senderAuth !== true
  ) {
    throw new EmailKitError(
      "sender.auth is not supported by this email driver",
      driverLabel(driver),
      "NOT_SUPPORTED",
    );
  }

  if (
    Object.prototype.hasOwnProperty.call(sender, "mailbox") &&
    sender.mailbox !== undefined &&
    driver.capabilities.senderMailbox !== true
  ) {
    throw new EmailKitError(
      "sender.mailbox is not supported by this email driver",
      driverLabel(driver),
      "NOT_SUPPORTED",
    );
  }
};

const driverLabel = (driver: EmailDriver): string =>
  driver.id || driver.name || "unknown";

const extractDomainIdentifier = (
  identifier: DomainIdentifier<DomainIdentifierType>,
  driver: EmailDriver,
  requiredIdentifierType?: DomainIdentifierType,
): string => {
  const { domain, domainId } = identifier;
  const identifierType = requiredIdentifierType || "both";
  const provider = driverLabel(driver);

  if (identifierType === "domain") {
    if (!domain) {
      throw new EmailKitError(
        "Domain is required for this provider",
        provider,
        "INVALID_INPUT",
      );
    }
    return domain;
  }

  if (identifierType === "domainId") {
    if (!domainId) {
      throw new EmailKitError(
        "DomainId is required for this provider",
        provider,
        "INVALID_INPUT",
      );
    }
    return domainId;
  }

  if (domain) return domain;
  if (domainId) return domainId;

  throw new EmailKitError(
    "Either domain or domainId must be provided",
    provider,
    "INVALID_INPUT",
  );
};

const isEmailKitError = (error: unknown): error is EmailKitError =>
  error instanceof EmailKitError;

const isNotFoundError = (error: unknown): boolean => {
  if (!isEmailKitError(error)) return false;
  return error.code === "NOT_FOUND" || error.httpStatus === 404;
};

const isConflictError = (error: unknown): boolean => {
  if (!isEmailKitError(error)) return false;

  if (error.httpStatus === 409 || error.code === "ALREADY_EXISTS") {
    return true;
  }

  return /already exists|exists already|duplicate|conflict/i.test(
    error.message,
  );
};

const hydrateDomain = async (
  driverGet: DriverDomainsAPI["get"],
  driver: EmailDriver,
  identifierType: DomainIdentifierType,
  domain: Domain,
): Promise<Domain> => {
  const candidates = new Set<string>();

  if (domain.domain) {
    candidates.add(domain.domain);
  }
  if (domain.id) {
    candidates.add(domain.id);
  }

  const prefersDomainId = identifierType === "domainId";
  const hydratedIdentifier = prefersDomainId
    ? domain.id || domain.domain
    : domain.domain || domain.id;

  if (hydratedIdentifier) {
    candidates.delete(hydratedIdentifier);
  }

  const orderedCandidates = [hydratedIdentifier, ...candidates].filter(
    Boolean,
  ) as string[];

  for (const candidate of orderedCandidates) {
    try {
      return await driverGet(candidate);
    } catch (error) {
      if (isNotFoundError(error)) {
        continue;
      }
      throw error;
    }
  }

  return domain;
};

const createAttachmentsFacade = (
  resolveProviderFetch: (
    emailDriver: string | undefined,
    path: string | URL,
    init?: ProviderFetchInit,
  ) => Promise<ProviderFetch>,
  defaultProvider: string,
): AttachmentsFacade => ({
  getContent: async (attachment, opts): Promise<string | Uint8Array> => {
    const emailDriver = attachmentEmailDriver(
      attachment,
      opts,
      defaultProvider,
    );

    if (attachment.content !== undefined) {
      return attachment.content;
    }

    if (!attachment.url) {
      throw new EmailKitError(
        `Attachment content is unavailable for ${attachment.filename}`,
        emailDriver || defaultProvider,
        "ATTACHMENT_CONTENT_UNAVAILABLE",
      );
    }

    const providerFetch = await resolveProviderFetch(
      emailDriver,
      attachment.url,
      attachment.provider ? { provider: attachment.provider } : undefined,
    );
    const response = await providerFetch(
      attachment.url,
      attachment.provider ? { provider: attachment.provider } : undefined,
    );
    if (!response.ok) {
      const contentType = response.headers.get("content-type") || "";
      const body = contentType.includes("application/json")
        ? await response.json()
        : await response.text();

      throw new EmailKitError(
        `Failed to fetch attachment content for ${attachment.filename}`,
        emailDriver || defaultProvider,
        "ATTACHMENT_FETCH_FAILED",
        response.status,
        undefined,
        body,
      );
    }

    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  },
});

const DOMAIN_METHODS = [
  "list",
  "create",
  "get",
  "update",
  "verify",
  "delete",
] as const satisfies readonly (keyof DriverDomainsAPI)[];

type RuntimeDomainMethod = (typeof DOMAIN_METHODS)[number];

const MAILBOX_METHOD_CAPABILITIES = {
  connect: "mailboxConnect",
  create: "mailboxCreate",
  list: "mailboxList",
  get: "mailboxGet",
  delete: "mailboxDelete",
} as const satisfies Record<keyof DriverMailboxesAPI, keyof DriverCapabilities>;

const WEBHOOK_SCOPES = [
  "account",
  "mailbox",
  "domain",
] as const satisfies readonly (keyof DriverWebhookCapabilities)[];

const WEBHOOK_METHODS = [
  "setup",
  "refresh",
  "delete",
] as const satisfies readonly (keyof DriverWebhooksAPI["account"])[];

type WebhookMethod = (typeof WEBHOOK_METHODS)[number];

const webhookCapabilitySupportsMethod = (
  capability: DriverWebhookCapabilities[keyof DriverWebhookCapabilities],
  method: WebhookMethod,
): boolean => {
  if (capability === true) {
    return true;
  }
  return capability?.[method] === true;
};

const domainCapabilities = (
  driver: EmailDriver,
): DriverDomainCapabilities | undefined => driver.capabilities.domains;

const driverDomainIdentifierType = (
  driver: EmailDriver,
): DomainIdentifierType => {
  const domains = domainCapabilities(driver);
  return domains?.identifier || "both";
};

const hasDomainCapability = (
  driver: EmailDriver,
  method: RuntimeDomainMethod,
): boolean => {
  const domains = domainCapabilities(driver);
  if (!domains) return false;
  return domains[method] === true;
};

const hasDomainEnsureCapability = (driver: EmailDriver): boolean =>
  hasDomainCapability(driver, "list") &&
  hasDomainCapability(driver, "create") &&
  hasDomainCapability(driver, "get");

const validateDomainCapabilities = (driver: EmailDriver): void => {
  const domains = domainCapabilities(driver);
  if (!domains) return;

  for (const method of DOMAIN_METHODS) {
    const declaresMethod = domains[method] === true;
    const implementsMethod = typeof driver.domains?.[method] === "function";

    if (declaresMethod && !implementsMethod) {
      throw new EmailKitError(
        `Domain capability domains.${method} is declared but driver.domains.${method} is not implemented`,
        driverLabel(driver),
        "INVALID_CONFIG",
      );
    }

    if (!declaresMethod && implementsMethod) {
      throw new EmailKitError(
        `driver.domains.${method} is implemented but capability domains.${method} is not declared`,
        driverLabel(driver),
        "INVALID_CONFIG",
      );
    }
  }
};

const validateProviderFetchCapability = (driver: EmailDriver): void => {
  const declaresProviderFetch = driver.capabilities.providerFetch === true;
  const implementsProviderFetch = typeof driver.providerFetch === "function";

  if (declaresProviderFetch && !implementsProviderFetch) {
    throw new EmailKitError(
      "Provider fetch capability providerFetch is declared but driver.providerFetch is not implemented",
      driverLabel(driver),
      "INVALID_CONFIG",
    );
  }

  if (!declaresProviderFetch && implementsProviderFetch) {
    throw new EmailKitError(
      "driver.providerFetch is implemented but capability providerFetch is not declared",
      driverLabel(driver),
      "INVALID_CONFIG",
    );
  }
};

const validateMailboxCapabilities = (driver: EmailDriver): void => {
  for (const [method, capability] of Object.entries(
    MAILBOX_METHOD_CAPABILITIES,
  ) as Array<
    [
      keyof DriverMailboxesAPI,
      (typeof MAILBOX_METHOD_CAPABILITIES)[keyof DriverMailboxesAPI],
    ]
  >) {
    const declaresMethod = driver.capabilities[capability] === true;
    const implementsMethod = typeof driver.mailboxes?.[method] === "function";

    if (declaresMethod && !implementsMethod) {
      throw new EmailKitError(
        `Mailbox capability ${capability} is declared but driver.mailboxes.${method} is not implemented`,
        driverLabel(driver),
        "INVALID_CONFIG",
      );
    }

    if (!declaresMethod && implementsMethod) {
      throw new EmailKitError(
        `driver.mailboxes.${method} is implemented but capability ${capability} is not declared`,
        driverLabel(driver),
        "INVALID_CONFIG",
      );
    }
  }
};

const validateWebhookCapabilities = (driver: EmailDriver): void => {
  for (const scope of WEBHOOK_SCOPES) {
    const scopeCapability = driver.capabilities.webhooks?.[scope];
    const scopedWebhooks = driver.webhooks?.[scope];

    for (const method of WEBHOOK_METHODS) {
      const declaresMethod = webhookCapabilitySupportsMethod(
        scopeCapability,
        method,
      );
      const implementsMethod = typeof scopedWebhooks?.[method] === "function";

      if (declaresMethod && !implementsMethod) {
        throw new EmailKitError(
          `Webhook capability webhooks.${scope}.${method} is declared but driver.webhooks.${scope}.${method} is not implemented`,
          driverLabel(driver),
          "INVALID_CONFIG",
        );
      }

      if (!declaresMethod && implementsMethod) {
        throw new EmailKitError(
          `driver.webhooks.${scope}.${method} is implemented but capability webhooks.${scope}.${method} is not declared`,
          driverLabel(driver),
          "INVALID_CONFIG",
        );
      }
    }
  }
};

const validatePublicRouteCapabilities = (driver: EmailDriver): void => {
  const publicRoutes = driver.capabilities.publicRoutes;
  if (!publicRoutes) {
    if (driver.handleCallback) {
      throw new EmailKitError(
        "driver.handleCallback is implemented but capability publicRoutes.connectCallback is not declared",
        driverLabel(driver),
        "INVALID_CONFIG",
      );
    }
    return;
  }

  if (publicRoutes.lifecycleWebhook === true && publicRoutes.webhook !== true) {
    throw new EmailKitError(
      "Public route capability publicRoutes.lifecycleWebhook requires publicRoutes.webhook",
      driverLabel(driver),
      "INVALID_CONFIG",
    );
  }

  if (
    publicRoutes.connectLanding === true &&
    publicRoutes.connectCallback !== true
  ) {
    throw new EmailKitError(
      "Public route capability publicRoutes.connectLanding requires publicRoutes.connectCallback",
      driverLabel(driver),
      "INVALID_CONFIG",
    );
  }

  if (publicRoutes.connectCallback === true && !driver.handleCallback) {
    throw new EmailKitError(
      "Public route capability publicRoutes.connectCallback is declared but driver.handleCallback is not implemented",
      driverLabel(driver),
      "INVALID_CONFIG",
    );
  }
};

const ensureDomainMethod = <T extends keyof DriverDomainsAPI>(
  driver: EmailDriver,
  method: T,
): DriverDomainsAPI[T] => {
  const impl = driver.domains?.[method] as DriverDomainsAPI[T] | undefined;
  if (!impl) {
    return (() => {
      throw new EmailKitError(
        `Domain operation not supported by provider: ${String(method)}`,
        driverLabel(driver),
        "NOT_SUPPORTED",
      );
    }) as DriverDomainsAPI[T];
  }
  return impl;
};

const ensureMailboxMethod = <T extends keyof DriverMailboxesAPI>(
  driver: EmailDriver,
  method: T,
): DriverMailboxesAPI[T] => {
  const impl = driver.mailboxes?.[method] as DriverMailboxesAPI[T] | undefined;
  if (!impl) {
    return (() => {
      throw new EmailKitError(
        `Mailbox operation not supported by provider: ${String(method)}`,
        driverLabel(driver),
        "NOT_SUPPORTED",
      );
    }) as DriverMailboxesAPI[T];
  }
  return impl;
};

const ensureWebhookMethod = <
  TScope extends keyof DriverWebhooksAPI,
  TMethod extends keyof DriverWebhooksAPI[TScope],
>(
  driver: EmailDriver,
  scope: TScope,
  method: TMethod,
): NonNullable<DriverWebhooksAPI[TScope][TMethod]> => {
  const scopedWebhooks = driver.webhooks?.[scope] as
    | Partial<Record<TMethod, unknown>>
    | undefined;
  const impl = scopedWebhooks?.[method] as
    | NonNullable<DriverWebhooksAPI[TScope][TMethod]>
    | undefined;
  if (!impl) {
    return (() => {
      throw new EmailKitError(
        `Webhook ${scope} operation not supported by provider: ${String(method)}`,
        driverLabel(driver),
        "NOT_SUPPORTED",
      );
    }) as NonNullable<DriverWebhooksAPI[TScope][TMethod]>;
  }
  return impl;
};

const isWebhookResponse = (value: unknown): value is WebhookResponse =>
  Boolean(
    value &&
      typeof value === "object" &&
      "status" in value &&
      typeof (value as WebhookResponse).status === "number",
  );

const normalizeMailboxIdentity = (
  mailbox: MailboxIdentity | Mailbox | undefined,
): MailboxIdentity | undefined => {
  if (!mailbox || typeof mailbox !== "object") return undefined;

  const source = mailbox as Partial<Mailbox>;
  const identity: Partial<Omit<Mailbox, "auth">> = {};
  if (typeof source.id === "string") identity.id = source.id;
  if (typeof source.email === "string") identity.email = source.email;

  if (!identity.id && !identity.email) return undefined;

  if (source.displayName !== undefined)
    identity.displayName = source.displayName;
  if (source.status !== undefined) identity.status = source.status;
  if (source.createdAt !== undefined) identity.createdAt = source.createdAt;
  if (source.updatedAt !== undefined) identity.updatedAt = source.updatedAt;

  return identity as MailboxIdentity;
};

const assertMailboxHasNoAuth = (
  mailbox: MailboxIdentity | Mailbox | undefined,
  provider: string,
): void => {
  if (
    mailbox &&
    typeof mailbox === "object" &&
    Object.prototype.hasOwnProperty.call(mailbox, "auth")
  ) {
    throw new EmailKitError(
      "Mailbox auth must be passed as top-level auth, not mailbox.auth",
      provider,
      "INVALID_INPUT",
    );
  }
};

const stripMailboxAuth = <
  TMailbox extends MailboxIdentity | Mailbox | undefined,
>(
  mailbox: TMailbox,
): TMailbox extends undefined ? undefined : Mailbox => {
  if (!mailbox || typeof mailbox !== "object") {
    return undefined as unknown as TMailbox extends undefined
      ? undefined
      : Mailbox;
  }
  const { auth: _auth, ...safeMailbox } = mailbox as Record<string, unknown>;
  return safeMailbox as unknown as TMailbox extends undefined
    ? undefined
    : Mailbox;
};

const normalizeMailboxConnectionResult = (
  result: MailboxConnectionResult,
): MailboxConnectionResult => {
  return {
    ...result,
    ...(result.mailbox ? { mailbox: stripMailboxAuth(result.mailbox) } : {}),
  };
};

const normalizeMailboxAuthInput = <
  TInput extends {
    mailbox?: MailboxIdentity | Mailbox;
    auth?: unknown;
  },
>(
  input: TInput,
  provider: string,
): TInput => {
  assertMailboxHasNoAuth(input.mailbox, provider);

  return {
    ...input,
    ...(input.mailbox ? { mailbox: stripMailboxAuth(input.mailbox) } : {}),
  };
};

const withWebhookDriver = <
  TResult extends { webhook?: { emailDriver?: string } },
>(
  driver: EmailDriver,
  result: TResult,
): TResult => ({
  ...result,
  ...(result.webhook
    ? { webhook: { ...result.webhook, emailDriver: driver.id } }
    : {}),
});

const withConnectionWebhookDriver = (
  driver: EmailDriver,
  result: MailboxConnectionResult,
): MailboxConnectionResult => ({
  ...result,
  ...(result.webhooks
    ? {
        webhooks: result.webhooks.map((webhook) => ({
          ...webhook,
          emailDriver: driver.id,
        })),
      }
    : {}),
});

const withPublicWebhookSetupRoute = <
  TInput extends { url?: string; provider?: Record<string, unknown> },
>(
  input: TInput,
  publicRoutes: Pick<DriverPublicRoutes, "webhookUrl" | "lifecycleWebhookUrl">,
): TInput => {
  const provider =
    publicRoutes.lifecycleWebhookUrl &&
    typeof input.provider?.lifecycleNotificationUrl !== "string"
      ? {
          ...(input.provider || {}),
          lifecycleNotificationUrl: publicRoutes.lifecycleWebhookUrl,
        }
      : input.provider;

  return {
    ...input,
    ...(input.url || !publicRoutes.webhookUrl
      ? {}
      : { url: publicRoutes.webhookUrl }),
    ...(provider ? { provider } : {}),
  };
};

type WebhookLifecycleResult = {
  webhook?: Webhook;
  previousWebhook?: Webhook;
  deleted?: boolean;
  source?: WebhookLifecycleSource;
  reason?: WebhookLifecycleReason;
  recommendedActions?: WebhookRecommendedAction[];
  webhookId?: string;
  providerId?: string;
  subscriptionId?: string;
  target?: WebhookLifecycleTarget;
  status?: WebhookStatus;
  previousStatus?: WebhookStatus;
  expiresAt?: Date;
  renewAfter?: Date;
  receivedAt?: Date;
  severity?: "info" | "warning" | "critical";
  context?: unknown;
  raw?: unknown;
};

const webhookLifecycleDefaults = (
  action: WebhookLifecycleAction,
): {
  reason: WebhookLifecycleReason;
  recommendedActions: WebhookRecommendedAction[];
} => {
  switch (action) {
    case "created":
      return { reason: "created", recommendedActions: ["persist"] };
    case "updated":
      return { reason: "renewed", recommendedActions: ["persist"] };
    case "deleted":
      return { reason: "deleted", recommendedActions: ["delete_local"] };
    case "action_required":
      return { reason: "unknown", recommendedActions: ["inspect"] };
    case "sync_required":
      return { reason: "unknown", recommendedActions: ["sync"] };
  }
};

const webhookLifecycleTargetFromMailbox = (input?: {
  id?: string;
  email?: string;
  mailboxId?: string;
}): WebhookLifecycleTarget | undefined => {
  if (!input) return undefined;
  const mailboxEmail = input.email;
  const mailboxId = input.id || input.mailboxId;
  if (!mailboxEmail && !mailboxId) return undefined;
  return {
    ...(mailboxEmail ? { mailboxEmail } : {}),
    ...(mailboxId ? { mailboxId } : {}),
  };
};

const webhookLifecycleTargetFromMailboxInput = (input: {
  mailbox?: MailboxIdentity | Mailbox;
  mailboxId?: string;
  email?: string;
}): WebhookLifecycleTarget | undefined => {
  return webhookLifecycleTargetFromMailbox(input.mailbox || input);
};

const webhookLifecycleTargetFromDomain = (input: {
  domain?: string;
}): WebhookLifecycleTarget | undefined => {
  return input.domain ? { domain: input.domain } : undefined;
};

const webhookLifecycleEvent = (
  driver: EmailDriver,
  scope: WebhookScope,
  action: WebhookLifecycleAction,
  result: WebhookLifecycleResult,
): WebhookLifecycleHookEvent | undefined => {
  if ((action === "created" || action === "updated") && !result.webhook) {
    return undefined;
  }
  if (action === "deleted" && result.deleted !== true) return undefined;

  const webhook = result.webhook;
  const defaults = webhookLifecycleDefaults(action);
  const base = {
    ...(result.webhookId || webhook?.id
      ? { webhookId: result.webhookId || webhook?.id }
      : {}),
    ...(result.providerId || webhook?.providerId
      ? { providerId: result.providerId || webhook?.providerId }
      : {}),
    ...(result.subscriptionId ? { subscriptionId: result.subscriptionId } : {}),
    emailDriver: driver.id,
    source: result.source || "api",
    reason: result.reason || defaults.reason,
    recommendedActions:
      result.recommendedActions || defaults.recommendedActions,
    scope: webhook?.scope || scope,
    ...(webhook ? { webhook } : {}),
    ...(result.previousWebhook
      ? { previousWebhook: result.previousWebhook }
      : {}),
    ...(result.target ? { target: result.target } : {}),
    ...(result.status || webhook?.status
      ? { status: result.status || webhook?.status }
      : {}),
    ...(result.previousStatus ? { previousStatus: result.previousStatus } : {}),
    ...(result.expiresAt || webhook?.expiresAt
      ? { expiresAt: result.expiresAt || webhook?.expiresAt }
      : {}),
    ...(result.renewAfter || webhook?.renewAfter
      ? { renewAfter: result.renewAfter || webhook?.renewAfter }
      : {}),
    ...(result.receivedAt ? { receivedAt: result.receivedAt } : {}),
    ...(result.severity ? { severity: result.severity } : {}),
    context: result.context,
    raw: result.raw,
  };

  if (action === "created") {
    return {
      ...base,
      action,
      webhook: webhook!,
    };
  }

  if (action === "updated") {
    return {
      ...base,
      action,
      webhook: webhook!,
    };
  }

  return {
    ...base,
    action,
  };
};

export const createEmailKitClient = <const TDrivers extends EmailDriverTuple>(
  config: EmailKitConfig<TDrivers>,
): EmailKitClient<TDrivers> => {
  const { emailDrivers, hooks = {} } = config;
  const driverMap = new Map<string, EmailDriver>();

  const dispatchWebhookLifecycle = async <
    TResult extends WebhookLifecycleResult,
  >(
    driver: EmailDriver,
    scope: WebhookScope,
    action: WebhookLifecycleAction,
    result: TResult,
  ): Promise<TResult> => {
    const event = webhookLifecycleEvent(driver, scope, action, result);
    if (!event) return result;

    await hooks.webhook?.onAll?.(event);
    switch (event.action) {
      case "created":
        await hooks.webhook?.onCreated?.(event);
        break;
      case "updated":
        await hooks.webhook?.onUpdated?.(event);
        break;
      case "deleted":
        await hooks.webhook?.onDeleted?.(event);
        break;
      case "action_required":
        await hooks.webhook?.onActionRequired?.(event);
        break;
      case "sync_required":
        await hooks.webhook?.onSyncRequired?.(event);
        break;
    }

    return result;
  };

  const dispatchMailboxConnectionWebhooks = async (
    driver: EmailDriver,
    result: MailboxConnectionResult,
  ): Promise<void> => {
    for (const webhook of result.webhooks || []) {
      await dispatchWebhookLifecycle(driver, webhook.scope, "created", {
        webhook,
        target: result.mailbox
          ? webhookLifecycleTargetFromMailbox(result.mailbox)
          : undefined,
        context: result.context,
        raw: result.raw,
      });
    }
  };

  if (emailDrivers.length === 0) {
    throw new EmailKitError(
      "At least one email driver is required",
      "emailkit",
      "INVALID_CONFIG",
    );
  }

  for (const driver of emailDrivers) {
    if (!driver.id) {
      throw new EmailKitError(
        "Email drivers must define a literal id",
        "emailkit",
        "INVALID_CONFIG",
      );
    }
    if (driverMap.has(driver.id)) {
      throw new EmailKitError(
        `Duplicate email driver id: ${driver.id}`,
        driver.id,
        "INVALID_CONFIG",
      );
    }
    validateDomainCapabilities(driver);
    validateProviderFetchCapability(driver);
    validateMailboxCapabilities(driver);
    validateWebhookCapabilities(driver);
    validatePublicRouteCapabilities(driver);
    driverMap.set(driver.id, driver);
  }

  if (
    emailDrivers.length > 1 &&
    typeof config.resolveEmailDriver !== "function"
  ) {
    throw new EmailKitError(
      "resolveEmailDriver is required when multiple email drivers are configured",
      "emailkit",
      "INVALID_CONFIG",
    );
  }

  const secretRequired = emailDrivers.some((driver) => {
    const capabilities = driver.capabilities;
    return (
      capabilities.requiresSecret === true ||
      capabilities.mailboxConnect === true
    );
  });
  const secret = resolveEmailKitSecret(config.secret);
  if (secretRequired && !secret) {
    throw new EmailKitError(
      "secret is required because at least one email driver uses signed callback state or OAuth. Pass secret or set EMAILKIT_SECRET.",
      "emailkit",
      "INVALID_CONFIG",
    );
  }

  const operationOptionsForDriver = (
    driver: EmailDriver,
    operation?: {
      mailbox?: MailboxIdentity | Mailbox;
      auth?: unknown;
      context?: unknown;
      publicRoutes?: DriverPublicRoutes;
    },
  ) => {
    assertMailboxHasNoAuth(operation?.mailbox, driverLabel(driver));

    const mailbox = normalizeMailboxIdentity(operation?.mailbox);
    const auth = operation?.auth;
    const publicRoutes =
      operation?.publicRoutes && Object.keys(operation.publicRoutes).length > 0
        ? operation.publicRoutes
        : undefined;

    return {
      ...(secret ? { secret } : {}),
      ...(mailbox !== undefined ? { mailbox } : {}),
      ...(auth !== undefined ? { auth } : {}),
      ...(operation?.context !== undefined
        ? { context: operation.context }
        : {}),
      ...(publicRoutes !== undefined ? { publicRoutes } : {}),
      onAuthUpdated: async (event: DriverAuthUpdate) => {
        const hook = hooks.mailbox?.onAuthUpdated;
        if (!hook) return;

        const mailbox = normalizeMailboxIdentity(
          event.mailbox ?? operation?.mailbox,
        );
        if (!mailbox) {
          throw new EmailKitError(
            "Cannot persist mailbox auth update without sender.mailbox or driver-reported mailbox identity",
            driverLabel(driver),
            "MISSING_MAILBOX_IDENTITY",
          );
        }

        const hookEvent = {
          emailDriver: driver.id,
          mailbox,
          auth: event.auth,
          ...(event.context !== undefined
            ? { context: event.context }
            : operation?.context !== undefined
              ? { context: operation.context }
              : {}),
          ...(event.raw !== undefined ? { raw: event.raw } : {}),
        };
        await hook(hookEvent);
      },
    };
  };

  const getDriverById = (id: string): EmailDriver => {
    const driver = driverMap.get(id);
    if (!driver) {
      throw new EmailKitError(
        `Unknown email driver: ${id}`,
        id,
        "INVALID_INPUT",
      );
    }
    return driver;
  };

  const resolveSingleDriver = (operation: string): EmailDriver => {
    if (emailDrivers.length === 1) {
      return emailDrivers[0];
    }

    throw new EmailKitError(
      `${operation} requires emailDriver because multiple email drivers are configured`,
      "emailkit",
      "INVALID_INPUT",
    );
  };

  const resolveCapabilityDriver = async (
    operation: string,
    selectedId: string | undefined,
    capability: keyof DriverCapabilities,
    context: ResolveEmailDriverContext<TDrivers>,
  ): Promise<EmailDriver> => {
    if (selectedId) {
      const driver = getDriverById(selectedId);
      if (
        driver.capabilities[capability] === false ||
        driver.capabilities[capability] === undefined
      ) {
        throw new EmailKitError(
          `${operation} is not supported by email driver: ${selectedId}`,
          selectedId,
          "NOT_SUPPORTED",
        );
      }
      return driver;
    }

    const capableDrivers = emailDrivers.filter(
      (driver) =>
        driver.capabilities[capability] !== false &&
        driver.capabilities[capability] !== undefined,
    );

    if (capableDrivers.length === 1) {
      return capableDrivers[0];
    }

    if (capableDrivers.length === 0) {
      throw new EmailKitError(
        `${operation} is not supported by any configured email driver`,
        "emailkit",
        "NOT_SUPPORTED",
      );
    }

    if (config.resolveEmailDriver) {
      const selection = normalizeSender(
        await config.resolveEmailDriver(context),
      );
      const driver = getDriverById(selection.emailDriver);
      if (
        driver.capabilities[capability] === false ||
        driver.capabilities[capability] === undefined
      ) {
        throw new EmailKitError(
          `${operation} is not supported by email driver: ${selection.emailDriver}`,
          selection.emailDriver,
          "NOT_SUPPORTED",
        );
      }
      return driver;
    }

    throw new EmailKitError(
      `${operation} requires emailDriver because multiple configured email drivers support it`,
      "emailkit",
      "INVALID_INPUT",
    );
  };

  const resolveDomainCapabilityDriver = async (
    operation: string,
    selectedId: string | undefined,
    method: RuntimeDomainMethod,
    context: ResolveEmailDriverContext<TDrivers>,
  ): Promise<EmailDriver> => {
    if (selectedId) {
      const driver = getDriverById(selectedId);
      if (!hasDomainCapability(driver, method)) {
        throw new EmailKitError(
          `${operation} is not supported by email driver: ${selectedId}`,
          selectedId,
          "NOT_SUPPORTED",
        );
      }
      return driver;
    }

    const capableDrivers = emailDrivers.filter((driver) =>
      hasDomainCapability(driver, method),
    );

    if (capableDrivers.length === 1) {
      return capableDrivers[0];
    }

    if (capableDrivers.length === 0) {
      throw new EmailKitError(
        `${operation} is not supported by any configured email driver`,
        "emailkit",
        "NOT_SUPPORTED",
      );
    }

    if (config.resolveEmailDriver) {
      const selection = normalizeSender(
        await config.resolveEmailDriver(context),
      );
      const driver = getDriverById(selection.emailDriver);
      if (!hasDomainCapability(driver, method)) {
        throw new EmailKitError(
          `${operation} is not supported by email driver: ${selection.emailDriver}`,
          selection.emailDriver,
          "NOT_SUPPORTED",
        );
      }
      return driver;
    }

    throw new EmailKitError(
      `${operation} requires emailDriver because multiple configured email drivers support it`,
      "emailkit",
      "INVALID_INPUT",
    );
  };

  const resolveDomainEnsureDriver = async (
    operation: string,
    selectedId: string | undefined,
    context: ResolveEmailDriverContext<TDrivers>,
  ): Promise<EmailDriver> => {
    if (selectedId) {
      const driver = getDriverById(selectedId);
      if (!hasDomainEnsureCapability(driver)) {
        throw new EmailKitError(
          `${operation} is not supported by email driver: ${selectedId}`,
          selectedId,
          "NOT_SUPPORTED",
        );
      }
      return driver;
    }

    const capableDrivers = emailDrivers.filter(hasDomainEnsureCapability);

    if (capableDrivers.length === 1) {
      return capableDrivers[0];
    }

    if (capableDrivers.length === 0) {
      throw new EmailKitError(
        `${operation} is not supported by any configured email driver`,
        "emailkit",
        "NOT_SUPPORTED",
      );
    }

    if (config.resolveEmailDriver) {
      const selection = normalizeSender(
        await config.resolveEmailDriver(context),
      );
      const driver = getDriverById(selection.emailDriver);
      if (!hasDomainEnsureCapability(driver)) {
        throw new EmailKitError(
          `${operation} is not supported by email driver: ${selection.emailDriver}`,
          selection.emailDriver,
          "NOT_SUPPORTED",
        );
      }
      return driver;
    }

    throw new EmailKitError(
      `${operation} requires emailDriver because multiple configured email drivers support it`,
      "emailkit",
      "INVALID_INPUT",
    );
  };

  const hasWebhookCapability = (
    driver: EmailDriver,
    scope: keyof DriverWebhookCapabilities,
    method: WebhookMethod,
  ): boolean =>
    webhookCapabilitySupportsMethod(
      driver.capabilities.webhooks?.[scope],
      method,
    );

  const hasAnyWebhookCapability = (
    driver: EmailDriver,
    scope: keyof DriverWebhookCapabilities,
  ): boolean =>
    WEBHOOK_METHODS.some((method) =>
      hasWebhookCapability(driver, scope, method),
    );

  const resolveWebhookCapabilityDriver = async (
    operation: string,
    selectedId: string | undefined,
    scope: keyof DriverWebhookCapabilities,
    method: WebhookMethod,
    context: ResolveEmailDriverContext<TDrivers>,
  ): Promise<EmailDriver> => {
    if (selectedId) {
      const driver = getDriverById(selectedId);
      if (!hasWebhookCapability(driver, scope, method)) {
        throw new EmailKitError(
          `${operation} is not supported by email driver: ${selectedId}`,
          selectedId,
          "NOT_SUPPORTED",
        );
      }
      return driver;
    }

    const capableDrivers = emailDrivers.filter((driver) =>
      hasWebhookCapability(driver, scope, method),
    );

    if (capableDrivers.length === 1) {
      return capableDrivers[0];
    }

    if (capableDrivers.length === 0) {
      throw new EmailKitError(
        `${operation} is not supported by any configured email driver`,
        "emailkit",
        "NOT_SUPPORTED",
      );
    }

    if (config.resolveEmailDriver) {
      const selection = normalizeSender(
        await config.resolveEmailDriver(context),
      );
      const driver = getDriverById(selection.emailDriver);
      if (!hasWebhookCapability(driver, scope, method)) {
        throw new EmailKitError(
          `${operation} is not supported by email driver: ${selection.emailDriver}`,
          selection.emailDriver,
          "NOT_SUPPORTED",
        );
      }
      return driver;
    }

    throw new EmailKitError(
      `${operation} requires emailDriver because multiple configured email drivers support it`,
      "emailkit",
      "INVALID_INPUT",
    );
  };

  const resolveProviderFetch = async (
    selectedId: string | undefined,
    path: string | URL,
    init?: ProviderFetchInit,
  ): Promise<ProviderFetch> => {
    const driver = await resolveCapabilityDriver(
      "providerFetch",
      selectedId,
      "providerFetch",
      {
        operation: "providerFetch",
        path,
        init,
      },
    );

    if (!driver.providerFetch) {
      throw new EmailKitError(
        "Provider fetch is not supported by this driver",
        driverLabel(driver),
        "NOT_SUPPORTED",
      );
    }
    return (path, init) => driver.providerFetch!(path, init);
  };

  const normalizeSender = (
    sender:
      | ConfiguredDriverId<TDrivers>
      | EmailSenderOverride<ConfiguredDriverId<TDrivers>>
      | EmailSenderOverride<string>,
  ): EmailSenderOverride<ConfiguredDriverId<TDrivers>> =>
    (typeof sender === "string"
      ? { emailDriver: sender }
      : sender) as EmailSenderOverride<ConfiguredDriverId<TDrivers>>;

  const resolveSendDriver = async (
    message: SendEmailMessage<TDrivers>,
  ): Promise<{
    driver: EmailDriver;
    sender?: EmailSenderOverride<ConfiguredDriverId<TDrivers>>;
  }> => {
    if (message.sender) {
      const sender = normalizeSender(message.sender);
      return { driver: getDriverById(sender.emailDriver), sender };
    }

    if (config.resolveEmailDriver) {
      const sender = normalizeSender(
        await config.resolveEmailDriver({ operation: "sendEmail", message }),
      );
      return { driver: getDriverById(sender.emailDriver), sender };
    }

    const driver = resolveSingleDriver("sendEmail");
    return { driver };
  };

  const sendEmail = async (
    message: SendEmailMessage<TDrivers>,
    options?: { signal?: AbortSignal },
  ): Promise<SendEmailResult> => {
    const { driver, sender } = await resolveSendDriver(message);
    assertSenderCapabilities(driver, sender);
    const { sender: _sender, ...driverMessage } = message;
    const sanitizedMessage = stripUnsupportedSendFields(
      driverMessage as Record<string, unknown>,
      driver.capabilities,
    );
    return driver.sendEmail(sanitizedMessage as any, {
      ...operationOptionsForDriver(driver, {
        mailbox: sender?.mailbox,
        auth: sender?.auth,
        context: sender?.context,
      }),
      ...options,
    });
  };

  const dispatchEmailHooks = async (
    driver: EmailDriver,
    request: WebhookRequest,
    type: string,
    data: unknown,
  ): Promise<void> => {
    const emailDriver = driver.id;
    const dataWithDriver =
      data && typeof data === "object"
        ? withAttachmentEmailDriver(data, emailDriver)
        : data;
    let dataForHooks = dataWithDriver;

    if (type === "opened") {
      const openedData = dataWithDriver as any;
      const botDetection = checkOpenBot({
        userAgent: openedData.userAgent || "",
        timeSinceSendMs: openedData.timeSinceSendMs,
      });
      dataForHooks = {
        ...openedData,
        botDetection: {
          isBot: botDetection.isBot,
          reason: botDetection.reason,
        },
      };
    } else if (type === "clicked") {
      const clickedData = dataWithDriver as any;
      const botDetection = checkClickBot({
        userAgent: clickedData.userAgent,
        method: request.method,
        url: clickedData.url,
      });
      dataForHooks = {
        ...clickedData,
        botDetection: {
          isBot: botDetection.isBot,
          reason: botDetection.reason,
        },
      };
    }

    await hooks.email?.onAll?.({
      emailDriver,
      type: type as any,
      data: dataForHooks,
      raw: request.body,
    });

    switch (type) {
      case "inbound":
        await hooks.email?.onInbound?.(dataWithDriver as any);
        break;
      case "outbound":
        await hooks.email?.onOutbound?.(dataWithDriver as any);
        break;
      case "delivered":
        await hooks.email?.onDelivered?.(dataWithDriver as any);
        break;
      case "opened": {
        await hooks.email?.onOpened?.(dataForHooks as any);
        break;
      }
      case "clicked": {
        await hooks.email?.onClicked?.(dataForHooks as any);
        break;
      }
      case "bounced":
        await hooks.email?.onBounced?.(dataWithDriver as any);
        break;
      case "complained":
        await hooks.email?.onComplained?.(dataWithDriver as any);
        break;
      case "rejected":
        await hooks.email?.onRejected?.(dataWithDriver as any);
        break;
      case "unknown":
        await hooks.email?.onUnknown?.({
          emailDriver,
          type: "unknown",
          data: dataWithDriver,
          raw: request.body,
        });
        break;
      default:
        await hooks.email?.onUnknown?.({
          emailDriver,
          type: "unknown",
          data: { type, data: dataWithDriver },
          raw: request.body,
        });
        break;
    }
  };

  const isWebhookLifecycleDriverEvent = (
    event: WebhookDriverEvent,
  ): event is WebhookLifecycleDriverEvent => {
    return event.type === "webhook.lifecycle";
  };

  const resolveRequestDriver = (request: WebhookRequest): EmailDriver => {
    const selectedId =
      request.query?.emailDriver ||
      request.query?.email_driver ||
      request.headers["x-emailkit-driver"] ||
      request.headers["X-EmailKit-Driver"];
    return selectedId
      ? getDriverById(selectedId)
      : resolveSingleDriver("handler");
  };

  const handler = () => {
    return async (request: WebhookRequest): Promise<WebhookResponse> => {
      const driver = resolveRequestDriver(request);
      const driverWebhookRoutes = resolveDriverWebhookRoutes(
        config.publicRoutes,
        driver,
      );
      const validationToken = request.query?.validationToken;
      if (typeof validationToken === "string" && driver.webhookResponse) {
        return driver.webhookResponse(request, false);
      }

      if (request.method.toUpperCase() === "GET") {
        if (driver.handleCallback) {
          const connectCallbackUrl = resolveDriverConnectCallbackUrl(
            config.publicRoutes,
            driver,
          );
          const connectLandingUrl = supportsPublicRoute(
            driver,
            "connectLanding",
          )
            ? resolveLandingUrl(
                config.publicRoutes,
                config.publicRoutes?.connectLandingRoutes?.success,
              )
            : undefined;
          const connectFailureUrl = supportsPublicRoute(
            driver,
            "connectLanding",
          )
            ? resolveLandingUrl(
                config.publicRoutes,
                config.publicRoutes?.connectLandingRoutes?.failure,
              )
            : undefined;
          const driverPublicRoutes: DriverPublicRoutes = {
            ...driverWebhookRoutes,
            ...(connectCallbackUrl ? { connectCallbackUrl } : {}),
            ...(connectLandingUrl ? { connectLandingUrl } : {}),
            ...(connectFailureUrl ? { connectFailureUrl } : {}),
          };
          let result: DriverCallbackResult;
          try {
            result = await driver.handleCallback(
              request,
              operationOptionsForDriver(driver, {
                publicRoutes: driverPublicRoutes,
              }),
            );
          } catch (error) {
            if (connectFailureUrl) return redirectResponse(connectFailureUrl);

            const message =
              error instanceof Error
                ? error.message
                : "Email account connection failed.";
            return htmlResponse(400, "Connection failed", message);
          }

          if (isWebhookResponse(result)) {
            return result;
          }

          const callbackResult = withConnectionWebhookDriver(
            driver,
            normalizeMailboxConnectionResult(result),
          );
          if (callbackResult.mailbox) {
            await hooks.mailbox?.onConnected?.({
              emailDriver: driver.id,
              mailbox: callbackResult.mailbox,
              ...(callbackResult.auth !== undefined
                ? { auth: callbackResult.auth }
                : {}),
              context: callbackResult.context,
            });
          }
          await dispatchMailboxConnectionWebhooks(driver, callbackResult);

          const landingUrl = callbackResult.landingUrl
            ? resolveLandingUrl(config.publicRoutes, callbackResult.landingUrl)
            : connectLandingUrl;
          if (landingUrl) return redirectResponse(landingUrl);

          return htmlResponse(
            200,
            "Email account connected",
            "You can close this window and return to the app.",
            callbackResult.mailbox?.email,
          );
        }

        return {
          status: 501,
          body: {
            error: `Callback handling is not supported by email driver: ${driverLabel(driver)}`,
          },
        };
      }

      if (driver.verifyWebhook) {
        const isValid = await driver.verifyWebhook(request);
        if (!isValid) {
          return {
            status: 401,
            body: { error: "Invalid webhook signature" },
          };
        }
      }

      const eventResult = await driver.handleWebhook(request);
      const events: WebhookDriverEvent[] = Array.isArray(eventResult)
        ? eventResult
        : [eventResult];
      for (const event of events) {
        if (isWebhookLifecycleDriverEvent(event)) {
          await dispatchWebhookLifecycle(
            driver,
            event.data.scope,
            event.data.action,
            {
              ...event.data,
              ...(event.data.action === "deleted" ? { deleted: true } : {}),
            },
          );
          continue;
        }

        await dispatchEmailHooks(driver, request, event.type, event.data);
      }

      if (driver.webhookResponse) {
        return driver.webhookResponse(request, true);
      }

      return {
        status: 200,
        body: { success: true },
      };
    };
  };

  const resolveDomainIdentifier = async (
    driver: EmailDriver,
    identifier: DomainIdentifier,
  ): Promise<string | null> => {
    const list = ensureDomainMethod(driver, "list");
    const identifierType = driverDomainIdentifierType(driver);

    if (
      (identifierType === "domain" && identifier.domain) ||
      (identifierType === "domainId" && identifier.domainId) ||
      identifierType === "both"
    ) {
      return extractDomainIdentifier(
        identifier as DomainIdentifier<DomainIdentifierType>,
        driver,
        identifierType,
      );
    }

    const domains = await list();
    if (identifierType === "domain" && identifier.domainId) {
      const match = domains.find((domain) => domain.id === identifier.domainId);
      return match?.domain || null;
    }

    if (identifierType === "domainId" && identifier.domain) {
      const match = domains.find(
        (domain) =>
          domain.domain.toLowerCase() === identifier.domain!.toLowerCase(),
      );
      return match?.id || null;
    }

    return null;
  };

  const deleteDomain = async (
    operation: "domains.delete" | "domains.remove",
    identifier: DomainOperationInput & OperationSelector<string>,
  ): Promise<{ deleted: boolean }> => {
    const driver = await resolveDomainCapabilityDriver(
      operation,
      identifier.emailDriver,
      "delete",
      {
        operation,
        input: identifier,
      },
    );
    const idOrName = await resolveDomainIdentifier(driver, identifier);
    if (!idOrName) {
      throw new EmailKitError(
        "Domain not found",
        driverLabel(driver),
        "NOT_FOUND",
        404,
      );
    }
    let domain: Domain | null = null;
    if (hasDomainCapability(driver, "get")) {
      try {
        domain = await ensureDomainMethod(driver, "get")(idOrName);
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
    }
    const result = await ensureDomainMethod(driver, "delete")(idOrName);
    if (domain) {
      await hooks.domain?.onDeleted?.({
        emailDriver: driver.id,
        domain,
        context: identifier.context,
      });
    }
    return result;
  };

  const domains: DomainsFacade<TDrivers> = {
    list: async (opts) => {
      const driver = await resolveDomainCapabilityDriver(
        "domains.list",
        opts?.emailDriver,
        "list",
        {
          operation: "domains.list",
          input: opts,
        },
      );
      const { emailDriver: _emailDriver, ...driverOpts } = opts ?? {};
      return ensureDomainMethod(driver, "list")(driverOpts);
    },
    create: async (input) => {
      const driver = await resolveDomainCapabilityDriver(
        "domains.create",
        input.emailDriver,
        "create",
        {
          operation: "domains.create",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...driverInput } = input;
      const domain = await ensureDomainMethod(driver, "create")(driverInput);
      await hooks.domain?.onCreated?.({
        emailDriver: driver.id,
        domain,
        context: input.context,
      });
      return domain;
    },
    get: async (identifier) => {
      const driver = await resolveDomainCapabilityDriver(
        "domains.get",
        identifier.emailDriver,
        "get",
        {
          operation: "domains.get",
          input: identifier,
        },
      );
      const idOrName = await resolveDomainIdentifier(driver, identifier);
      if (!idOrName) {
        throw new EmailKitError(
          "Domain not found",
          driverLabel(driver),
          "NOT_FOUND",
          404,
        );
      }
      return ensureDomainMethod(driver, "get")(idOrName);
    },
    getOrNull: async (identifier) => {
      const driver = await resolveDomainCapabilityDriver(
        "domains.getOrNull",
        identifier.emailDriver,
        "get",
        {
          operation: "domains.getOrNull",
          input: identifier,
        },
      );
      const idOrName = await resolveDomainIdentifier(driver, identifier);
      if (!idOrName) {
        return null;
      }

      try {
        return await ensureDomainMethod(driver, "get")(idOrName);
      } catch (error) {
        if (isNotFoundError(error)) {
          return null;
        }
        throw error;
      }
    },
    ensure: async (input) => {
      const driver = await resolveDomainEnsureDriver(
        "domains.ensure",
        input.emailDriver,
        {
          operation: "domains.ensure",
          input,
        },
      );
      const existing = await (domains as any).getOrNull({
        domain: input.domain,
        emailDriver: driver.id as any,
      } as any);
      if (existing) {
        return { domain: existing, created: false };
      }

      try {
        const { emailDriver: _emailDriver, ...driverInput } = input;
        const created = await ensureDomainMethod(driver, "create")(driverInput);
        const identifierType = driverDomainIdentifierType(driver);
        const domain = await hydrateDomain(
          ensureDomainMethod(driver, "get"),
          driver,
          identifierType,
          created,
        );
        await hooks.domain?.onCreated?.({
          emailDriver: driver.id,
          domain,
          context: input.context,
        });
        return { domain, created: true };
      } catch (error) {
        if (isConflictError(error)) {
          const domain = await (domains as any).getOrNull({
            domain: input.domain,
            emailDriver: driver.id as any,
          } as any);
          if (domain) {
            return { domain, created: false };
          }
        }
        throw error;
      }
    },
    update: async (identifier, patch) => {
      const driver = await resolveDomainCapabilityDriver(
        "domains.update",
        identifier.emailDriver,
        "update",
        {
          operation: "domains.update",
          input: identifier,
        },
      );
      const idOrName = await resolveDomainIdentifier(driver, identifier);
      if (!idOrName) {
        throw new EmailKitError(
          "Domain not found",
          driverLabel(driver),
          "NOT_FOUND",
          404,
        );
      }
      return ensureDomainMethod(driver, "update")(idOrName, patch);
    },
    verify: async (identifier) => {
      const driver = await resolveDomainCapabilityDriver(
        "domains.verify",
        identifier.emailDriver,
        "verify",
        {
          operation: "domains.verify",
          input: identifier,
        },
      );
      const idOrName = await resolveDomainIdentifier(driver, identifier);
      if (!idOrName) {
        throw new EmailKitError(
          "Domain not found",
          driverLabel(driver),
          "NOT_FOUND",
          404,
        );
      }
      const verification = await ensureDomainMethod(driver, "verify")(idOrName);
      if (
        verification.status === "verified" &&
        hasDomainCapability(driver, "get")
      ) {
        try {
          const domain = await ensureDomainMethod(driver, "get")(idOrName);
          await hooks.domain?.onVerified?.({
            emailDriver: driver.id,
            domain,
            context: identifier.context,
          });
        } catch (error) {
          if (!isNotFoundError(error)) throw error;
        }
      }
      return verification;
    },
    delete: async (identifier) => deleteDomain("domains.delete", identifier),
    remove: async (identifier) => deleteDomain("domains.remove", identifier),
  };

  const mailboxes: MailboxesFacade<TDrivers> = {
    connect: (async (
      emailDriverOrInput?:
        | MailboxConnectDriverId<TDrivers>
        | (ConnectMailboxInput & {
            emailDriver?: MailboxConnectDriverId<TDrivers>;
          }),
      maybeInput: ConnectMailboxInput = {},
    ) => {
      const isDriverId = typeof emailDriverOrInput === "string";
      const emailDriver = isDriverId
        ? emailDriverOrInput
        : emailDriverOrInput?.emailDriver;
      const input = isDriverId ? maybeInput : (emailDriverOrInput ?? {});
      const driver = await resolveCapabilityDriver(
        "mailboxes.connect",
        emailDriver,
        "mailboxConnect",
        {
          operation: "mailboxes.connect",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...driverInput } =
        input as ConnectMailboxInput & {
          emailDriver?: MailboxConnectDriverId<TDrivers>;
        };
      const {
        callbackUrl: inputCallbackUrl,
        landingUrl: inputLandingUrl,
        failureUrl: inputFailureUrl,
        ...baseDriverInput
      } = driverInput;
      const callbackUrl = supportsPublicRoute(driver, "connectCallback")
        ? inputCallbackUrl ||
          resolveDriverConnectCallbackUrl(config.publicRoutes, driver)
        : undefined;
      const landingUrl = supportsPublicRoute(driver, "connectLanding")
        ? resolveLandingUrl(
            config.publicRoutes,
            inputLandingUrl ||
              config.publicRoutes?.connectLandingRoutes?.success,
          )
        : undefined;
      const failureUrl = supportsPublicRoute(driver, "connectLanding")
        ? resolveLandingUrl(
            config.publicRoutes,
            inputFailureUrl ||
              config.publicRoutes?.connectLandingRoutes?.failure,
          )
        : undefined;
      const publicRoutes: DriverPublicRoutes = {
        ...resolveDriverWebhookRoutes(config.publicRoutes, driver),
        ...(callbackUrl ? { connectCallbackUrl: callbackUrl } : {}),
        ...(landingUrl ? { connectLandingUrl: landingUrl } : {}),
        ...(failureUrl ? { connectFailureUrl: failureUrl } : {}),
      };
      const connectInput = {
        ...baseDriverInput,
        ...(callbackUrl ? { callbackUrl } : {}),
        ...(landingUrl ? { landingUrl } : {}),
        ...(failureUrl ? { failureUrl } : {}),
      };
      const connect = ensureMailboxMethod(driver, "connect");
      const result = withConnectionWebhookDriver(
        driver,
        normalizeMailboxConnectionResult(
          await connect(
            connectInput,
            operationOptionsForDriver(driver, {
              context: input.context,
              publicRoutes,
            }),
          ),
        ),
      );
      if (result.mailbox) {
        await hooks.mailbox?.onConnected?.({
          emailDriver: driver.id,
          mailbox: result.mailbox,
          ...(result.auth !== undefined ? { auth: result.auth } : {}),
          context: input.context,
        });
      }
      await dispatchMailboxConnectionWebhooks(driver, result);
      return result;
    }) as MailboxConnectFacade<TDrivers>,
    create: async (input) => {
      const driver = await resolveCapabilityDriver(
        "mailboxes.create",
        input.emailDriver,
        "mailboxCreate",
        {
          operation: "mailboxes.create",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...driverInput } = input;
      const create = ensureMailboxMethod(driver, "create");
      const createdMailbox = await create(
        driverInput,
        operationOptionsForDriver(driver, {
          auth: input.auth,
          context: input.context,
        }),
      );
      const mailbox = stripMailboxAuth(createdMailbox);
      await hooks.mailbox?.onCreated?.({
        emailDriver: driver.id,
        mailbox,
        context: input.context,
      });
      return mailbox;
    },
    list: async (opts) => {
      const driver = await resolveCapabilityDriver(
        "mailboxes.list",
        opts?.emailDriver,
        "mailboxList",
        {
          operation: "mailboxes.list",
          input: opts,
        },
      );
      const { emailDriver: _emailDriver, ...driverOpts } = opts ?? {};
      const list = ensureMailboxMethod(driver, "list");
      const mailboxes = await list(
        driverOpts,
        operationOptionsForDriver(driver),
      );
      return mailboxes.map((mailbox) => stripMailboxAuth(mailbox));
    },
    get: async (identifier) => {
      const driver = await resolveCapabilityDriver(
        "mailboxes.get",
        identifier.emailDriver,
        "mailboxGet",
        {
          operation: "mailboxes.get",
          input: identifier,
        },
      );
      const get = ensureMailboxMethod(driver, "get");
      const mailbox = await get(
        identifier.idOrEmail,
        operationOptionsForDriver(driver),
      );
      return stripMailboxAuth(mailbox);
    },
    delete: async (identifier) => {
      const driver = await resolveCapabilityDriver(
        "mailboxes.delete",
        identifier.emailDriver,
        "mailboxDelete",
        {
          operation: "mailboxes.delete",
          input: identifier,
        },
      );
      let mailbox: Mailbox | null = null;
      try {
        const get = ensureMailboxMethod(driver, "get");
        mailbox = await get(
          identifier.idOrEmail,
          operationOptionsForDriver(driver),
        );
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      const remove = ensureMailboxMethod(driver, "delete");
      const result = await remove(
        identifier.idOrEmail,
        operationOptionsForDriver(driver),
      );
      if (mailbox) {
        await hooks.mailbox?.onDeleted?.({
          emailDriver: driver.id,
          mailbox: stripMailboxAuth(mailbox),
        });
      }
      return result;
    },
  };

  const accountWebhooks: AccountWebhooksFacade<TDrivers> = {
    setup: async (input) => {
      const driver = await resolveWebhookCapabilityDriver(
        "webhooks.setup",
        input.emailDriver,
        "account",
        "setup",
        {
          operation: "webhooks.setup",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...driverInput } = input;
      const publicRoutes = resolveDriverWebhookRoutes(
        config.publicRoutes,
        driver,
      );
      const setupInput = withPublicWebhookSetupRoute(driverInput, publicRoutes);
      const setup = ensureWebhookMethod(driver, "account", "setup");
      const result = withWebhookDriver(
        driver,
        await setup(
          setupInput,
          operationOptionsForDriver(driver, {
            context: input.context,
            publicRoutes,
          }),
        ),
      );
      return dispatchWebhookLifecycle(driver, "account", "created", result);
    },
    refresh: async (input) => {
      const driver = await resolveWebhookCapabilityDriver(
        "webhooks.refresh",
        input.emailDriver,
        "account",
        "refresh",
        {
          operation: "webhooks.refresh",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...driverInput } = input;
      const refresh = ensureWebhookMethod(driver, "account", "refresh");
      const result = withWebhookDriver(
        driver,
        await refresh(
          driverInput,
          operationOptionsForDriver(driver, { context: input.context }),
        ),
      );
      return dispatchWebhookLifecycle(driver, "account", "updated", result);
    },
    delete: async (input) => {
      const driver = await resolveWebhookCapabilityDriver(
        "webhooks.delete",
        input.emailDriver,
        "account",
        "delete",
        {
          operation: "webhooks.delete",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...driverInput } = input;
      const remove = ensureWebhookMethod(driver, "account", "delete");
      const result = withWebhookDriver(
        driver,
        await remove(
          driverInput,
          operationOptionsForDriver(driver, { context: input.context }),
        ),
      );
      return dispatchWebhookLifecycle(driver, "account", "deleted", result);
    },
  };

  const mailboxWebhooks: MailboxWebhooksFacade<TDrivers> = {
    setup: async (input) => {
      const driver = await resolveWebhookCapabilityDriver(
        "mailboxes.webhooks.setup",
        input.emailDriver,
        "mailbox",
        "setup",
        {
          operation: "mailboxes.webhooks.setup",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...publicInput } = input;
      const publicRoutes = resolveDriverWebhookRoutes(
        config.publicRoutes,
        driver,
      );
      const driverInput = normalizeMailboxAuthInput(
        withPublicWebhookSetupRoute(publicInput, publicRoutes),
        driverLabel(driver),
      );
      const setup = ensureWebhookMethod(driver, "mailbox", "setup");
      const result = withWebhookDriver(
        driver,
        await setup(
          driverInput,
          operationOptionsForDriver(driver, {
            mailbox: "mailbox" in driverInput ? driverInput.mailbox : undefined,
            auth: driverInput.auth,
            context: input.context,
            publicRoutes,
          }),
        ),
      );
      return dispatchWebhookLifecycle(driver, "mailbox", "created", {
        ...result,
        target: webhookLifecycleTargetFromMailboxInput(driverInput),
      });
    },
    refresh: async (input) => {
      const driver = await resolveWebhookCapabilityDriver(
        "mailboxes.webhooks.refresh",
        input.emailDriver,
        "mailbox",
        "refresh",
        {
          operation: "mailboxes.webhooks.refresh",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...publicInput } = input;
      const driverInput = normalizeMailboxAuthInput(
        publicInput,
        driverLabel(driver),
      );
      const refresh = ensureWebhookMethod(driver, "mailbox", "refresh");
      const result = withWebhookDriver(
        driver,
        await refresh(
          driverInput,
          operationOptionsForDriver(driver, {
            mailbox: "mailbox" in driverInput ? driverInput.mailbox : undefined,
            auth: driverInput.auth,
            context: input.context,
          }),
        ),
      );
      return dispatchWebhookLifecycle(driver, "mailbox", "updated", {
        ...result,
        target: webhookLifecycleTargetFromMailboxInput(driverInput),
      });
    },
    delete: async (input) => {
      const driver = await resolveWebhookCapabilityDriver(
        "mailboxes.webhooks.delete",
        input.emailDriver,
        "mailbox",
        "delete",
        {
          operation: "mailboxes.webhooks.delete",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...publicInput } = input;
      const driverInput = normalizeMailboxAuthInput(
        publicInput,
        driverLabel(driver),
      );
      const remove = ensureWebhookMethod(driver, "mailbox", "delete");
      const result = withWebhookDriver(
        driver,
        await remove(
          driverInput,
          operationOptionsForDriver(driver, {
            mailbox: "mailbox" in driverInput ? driverInput.mailbox : undefined,
            auth: driverInput.auth,
            context: input.context,
          }),
        ),
      );
      return dispatchWebhookLifecycle(driver, "mailbox", "deleted", {
        ...result,
        target: webhookLifecycleTargetFromMailboxInput(driverInput),
      });
    },
  };

  const domainWebhooks: DomainWebhooksFacade<TDrivers> = {
    setup: async (input) => {
      const driver = await resolveWebhookCapabilityDriver(
        "domains.webhooks.setup",
        input.emailDriver,
        "domain",
        "setup",
        {
          operation: "domains.webhooks.setup",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...driverInput } = input;
      const publicRoutes = resolveDriverWebhookRoutes(
        config.publicRoutes,
        driver,
      );
      const setupInput = withPublicWebhookSetupRoute(driverInput, publicRoutes);
      const setup = ensureWebhookMethod(driver, "domain", "setup");
      const result = withWebhookDriver(
        driver,
        await setup(
          setupInput,
          operationOptionsForDriver(driver, {
            context: input.context,
            publicRoutes,
          }),
        ),
      );
      return dispatchWebhookLifecycle(driver, "domain", "created", {
        ...result,
        target: webhookLifecycleTargetFromDomain(setupInput),
      });
    },
    refresh: async (input) => {
      const driver = await resolveWebhookCapabilityDriver(
        "domains.webhooks.refresh",
        input.emailDriver,
        "domain",
        "refresh",
        {
          operation: "domains.webhooks.refresh",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...driverInput } = input;
      const refresh = ensureWebhookMethod(driver, "domain", "refresh");
      const result = withWebhookDriver(
        driver,
        await refresh(
          driverInput,
          operationOptionsForDriver(driver, { context: input.context }),
        ),
      );
      return dispatchWebhookLifecycle(driver, "domain", "updated", {
        ...result,
        target: webhookLifecycleTargetFromDomain(driverInput),
      });
    },
    delete: async (input) => {
      const driver = await resolveWebhookCapabilityDriver(
        "domains.webhooks.delete",
        input.emailDriver,
        "domain",
        "delete",
        {
          operation: "domains.webhooks.delete",
          input,
        },
      );
      const { emailDriver: _emailDriver, ...driverInput } = input;
      const remove = ensureWebhookMethod(driver, "domain", "delete");
      const result = withWebhookDriver(
        driver,
        await remove(
          driverInput,
          operationOptionsForDriver(driver, { context: input.context }),
        ),
      );
      return dispatchWebhookLifecycle(driver, "domain", "deleted", {
        ...result,
        target: webhookLifecycleTargetFromDomain(driverInput),
      });
    },
  };

  if (
    emailDrivers.some((driver) => hasAnyWebhookCapability(driver, "mailbox"))
  ) {
    (
      mailboxes as MailboxesBaseFacade<TDrivers> & {
        webhooks: MailboxWebhooksFacade<TDrivers>;
      }
    ).webhooks = mailboxWebhooks;
  }

  if (
    emailDrivers.some((driver) => hasAnyWebhookCapability(driver, "domain"))
  ) {
    (
      domains as DomainsBaseFacade<TDrivers> & {
        webhooks: DomainWebhooksFacade<TDrivers>;
      }
    ).webhooks = domainWebhooks;
  }

  const providerFetch: ProviderFetchFacade<TDrivers> = async (path, init) => {
    const { emailDriver, ...driverInit } = init ?? {};
    const fetch = await resolveProviderFetch(emailDriver, path, driverInit);
    return fetch(path, driverInit);
  };

  const client: BaseEmailKitClient<TDrivers> &
    Partial<{
      providerFetch: ProviderFetchFacade<TDrivers>;
      webhooks: AccountWebhooksFacade<TDrivers>;
    }> = {
    sendEmail,
    handler,
    emailDrivers,
    getDriver: ((id: string) =>
      getDriverById(id)) as BaseEmailKitClient<TDrivers>["getDriver"],
    attachments: createAttachmentsFacade(
      resolveProviderFetch,
      emailDrivers.length === 1 ? emailDrivers[0].id : "emailkit",
    ),
    domains,
    mailboxes,
  };

  if (
    emailDrivers.some((driver) => driver.capabilities.providerFetch === true)
  ) {
    client.providerFetch = providerFetch;
  }

  if (
    emailDrivers.some((driver) => hasAnyWebhookCapability(driver, "account"))
  ) {
    client.webhooks = accountWebhooks;
  }

  return client as EmailKitClient<TDrivers>;
};

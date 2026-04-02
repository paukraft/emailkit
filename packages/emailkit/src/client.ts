/**
 * EmailKit client implementation
 */

import { checkOpenBot, checkClickBot } from './bot-detect'
import type {
  DriverCapabilitiesType,
  DriverDomainsAPI,
  EmailDriver,
  ProviderFetch,
} from './driver'
import type {
  EmailMessage,
  EmailKitHooks,
  SendEmailResult,
  WebhookRequest,
  WebhookResponse,
  Attachment,
  Domain,
  DomainEnsureResult,
  DomainVerification,
  ListDomainsOptions,
  CreateDomainInput,
  UpdateDomainInput,
  DomainIdentifier,
  DomainIdentifierType,
} from './types'
import { EmailKitError } from './types'

/**
 * Configuration for creating an EmailKit client
 */
export interface EmailKitConfig<TDriver extends EmailDriver> {
  emailDriver: TDriver
  hooks?: EmailKitHooks
}

/**
 * Base client shared shape (without conditional domains)
 */
export interface BaseEmailKitClient<TDriver extends EmailDriver> {
  /**
   * Send an email (type-safe based on driver capabilities)
   */
  sendEmail: (
    message: EmailMessage<DriverCapabilitiesType<TDriver>>,
    options?: { signal?: AbortSignal }
  ) => Promise<SendEmailResult>

  /**
   * Get webhook route handler
   * Returns a function that can handle webhook requests
   */
  webhookRoute: () => (request: WebhookRequest) => Promise<WebhookResponse>

  /**
   * Get the underlying driver instance
   */
  driver: TDriver

  /**
   * Provider-aware fetch helper (if driver implements it)
   */
  providerFetch: ProviderFetch

  /**
   * Attachment helpers for normalized content retrieval.
   */
  attachments: AttachmentsFacade
}

/**
 * EmailKit client instance with conditional domains support.
 * If the driver's capabilities include domains: true, the property exists in the type.
 */
export type EmailKitClient<TDriver extends EmailDriver> =
  BaseEmailKitClient<TDriver> &
  (DriverCapabilitiesType<TDriver>['domains'] extends true
    ? {
        domains: DomainsFacade<
          DriverCapabilitiesType<TDriver>['domainIdentifier'] extends DomainIdentifierType
            ? DriverCapabilitiesType<TDriver>['domainIdentifier']
            : 'both'
        >
      }
    : {})

/**
 * Public facade for domain operations used by consumers
 */
export interface DomainsFacade<TIdentifierType extends DomainIdentifierType = 'both'> {
  list: (opts?: ListDomainsOptions) => Promise<Domain[]>
  create: (input: CreateDomainInput) => Promise<Domain>
  get: (identifier: DomainIdentifier) => Promise<Domain>
  getOrNull: (identifier: DomainIdentifier) => Promise<Domain | null>
  ensure: (input: CreateDomainInput) => Promise<DomainEnsureResult>
  update: (identifier: DomainIdentifier, patch: UpdateDomainInput) => Promise<Domain>
  verify: (identifier: DomainIdentifier) => Promise<DomainVerification>
  delete: (identifier: DomainIdentifier) => Promise<{ deleted: boolean }>
  /** Alias for delete */
  remove: (identifier: DomainIdentifier) => Promise<{ deleted: boolean }>
}

/**
 * Public attachment helpers used by consumers.
 */
export interface AttachmentsFacade {
  /**
   * Return attachment content directly when present, otherwise fetch through the
   * configured provider so app code does not need provider-specific auth logic.
   */
  getContent: (attachment: Attachment) => Promise<string | Uint8Array>
}

/**
 * Extract domain identifier string from DomainIdentifier type.
 * Uses the driver's domainIdentifier capability to determine preference.
 */
const extractDomainIdentifier = (
  identifier: DomainIdentifier<DomainIdentifierType>,
  driverName: string,
  domainIdentifierType?: DomainIdentifierType,
): string => {
  const { domain, domainId } = identifier

  // Use driver's domainIdentifier preference, default to 'both'
  const identifierType = domainIdentifierType || 'both'

  if (identifierType === 'domain') {
    if (!domain) {
      throw new EmailKitError(
        'Domain is required for this provider',
        driverName,
        'INVALID_INPUT',
      )
    }
    return domain
  }

  if (identifierType === 'domainId') {
    if (!domainId) {
      throw new EmailKitError(
        'DomainId is required for this provider',
        driverName,
        'INVALID_INPUT',
      )
    }
    return domainId
  }

  // 'both' - prefer domainId for providers that prefer it, otherwise prefer domain
  const prefersDomainId = ['aiinbx'].includes(driverName.toLowerCase())

  if (prefersDomainId) {
    // Prefer domainId, fallback to domain
    if (domainId) return domainId
    if (domain) return domain
  } else {
    // Prefer domain, fallback to domainId (Mailgun, Resend work with both)
    if (domain) return domain
    if (domainId) return domainId
  }

  // This should never happen due to type constraints, but TypeScript needs it
  throw new EmailKitError(
    'Either domain or domainId must be provided',
    driverName,
    'INVALID_INPUT',
  )
}

const createDomainsFacade = (driver: EmailDriver): DomainsFacade<DomainIdentifierType> | undefined => {
  const api: Partial<DriverDomainsAPI> | undefined = driver.domains
  if (!api) return undefined

  const capabilities = driver.capabilities as DriverCapabilitiesType<typeof driver>
  const identifierType = capabilities.domainIdentifier || 'both'

  const ensure = <T extends keyof DriverDomainsAPI>(method: T) => {
    const impl = api[method] as DriverDomainsAPI[T] | undefined
    if (!impl) {
      return (() => {
        throw new EmailKitError(
          `Domain operation not supported by provider: ${String(method)}`,
          driver.name,
          'NOT_SUPPORTED',
        )
      }) as DriverDomainsAPI[T]
    }
    return impl
  }

  const list = ensure('list')
  const create = ensure('create')
  const driverGet = ensure('get')
  const driverUpdate = ensure('update')
  const driverVerify = ensure('verify')
  const driverDelete = ensure('delete')

  const resolveIdentifier = async (identifier: DomainIdentifier): Promise<string | null> => {
    if (
      (identifierType === 'domain' && identifier.domain) ||
      (identifierType === 'domainId' && identifier.domainId) ||
      identifierType === 'both'
    ) {
      return extractDomainIdentifier(identifier as DomainIdentifier<DomainIdentifierType>, driver.name, identifierType)
    }

    const domains = await list()
    if (identifierType === 'domain' && identifier.domainId) {
      const match = domains.find((domain) => domain.id === identifier.domainId)
      return match?.name || null
    }

    if (identifierType === 'domainId' && identifier.domain) {
      const match = domains.find(
        (domain) => domain.name.toLowerCase() === identifier.domain!.toLowerCase(),
      )
      return match?.id || null
    }

    return null
  }

  const getOrNull = async (
    identifier: DomainIdentifier,
  ): Promise<Domain | null> => {
    const idOrName = await resolveIdentifier(identifier)
    if (!idOrName) {
      return null
    }

    try {
      return await driverGet(idOrName)
    } catch (error) {
      if (isNotFoundError(error)) {
        return null
      }
      throw error
    }
  }

  return {
    list,
    create,
    get: async (identifier: DomainIdentifier) => {
      const idOrName = await resolveIdentifier(identifier)
      if (!idOrName) {
        throw new EmailKitError(
          'Domain not found',
          driver.name,
          'NOT_FOUND',
          404,
        )
      }
      return driverGet(idOrName)
    },
    getOrNull,
    ensure: async (input: CreateDomainInput): Promise<DomainEnsureResult> => {
      const existing = await getOrNull({ domain: input.name })
      if (existing) {
        return { domain: existing, created: false }
      }

      try {
        const created = await create(input)
        return {
          domain: await hydrateDomain(driverGet, driver.name, identifierType, created),
          created: true,
        }
      } catch (error) {
        if (isConflictError(error)) {
          const domain = await getOrNull({ domain: input.name })
          if (domain) {
            return { domain, created: false }
          }
        }
        throw error
      }
    },
    update: async (identifier: DomainIdentifier, patch: UpdateDomainInput) => {
      const idOrName = await resolveIdentifier(identifier)
      if (!idOrName) {
        throw new EmailKitError(
          'Domain not found',
          driver.name,
          'NOT_FOUND',
          404,
        )
      }
      return driverUpdate(idOrName, patch)
    },
    verify: async (identifier: DomainIdentifier) => {
      const idOrName = await resolveIdentifier(identifier)
      if (!idOrName) {
        throw new EmailKitError(
          'Domain not found',
          driver.name,
          'NOT_FOUND',
          404,
        )
      }
      return driverVerify(idOrName)
    },
    delete: async (identifier: DomainIdentifier) => {
      const idOrName = await resolveIdentifier(identifier)
      if (!idOrName) {
        throw new EmailKitError(
          'Domain not found',
          driver.name,
          'NOT_FOUND',
          404,
        )
      }
      return driverDelete(idOrName)
    },
    remove: async (identifier: DomainIdentifier) => {
      const idOrName = await resolveIdentifier(identifier)
      if (!idOrName) {
        throw new EmailKitError(
          'Domain not found',
          driver.name,
          'NOT_FOUND',
          404,
        )
      }
      return driverDelete(idOrName)
    },
  }
}

const isEmailKitError = (error: unknown): error is EmailKitError =>
  error instanceof EmailKitError

const isNotFoundError = (error: unknown): boolean => {
  if (!isEmailKitError(error)) return false
  return error.code === 'NOT_FOUND' || error.httpStatus === 404
}

const isConflictError = (error: unknown): boolean => {
  if (!isEmailKitError(error)) return false

  if (error.httpStatus === 409 || error.code === 'ALREADY_EXISTS') {
    return true
  }

  return /already exists|exists already|duplicate|conflict/i.test(error.message)
}

const hydrateDomain = async (
  driverGet: DriverDomainsAPI['get'],
  driverName: string,
  identifierType: DomainIdentifierType,
  domain: Domain,
): Promise<Domain> => {
  const candidates = new Set<string>()

  if (domain.name) {
    candidates.add(domain.name)
  }
  if (domain.id) {
    candidates.add(domain.id)
  }

  const prefersDomainId =
    identifierType === 'domainId' ||
    (identifierType === 'both' && driverName.toLowerCase() === 'aiinbx')
  const hydratedIdentifier = prefersDomainId
    ? domain.id || domain.name
    : domain.name || domain.id

  if (hydratedIdentifier) {
    candidates.delete(hydratedIdentifier)
  }

  const orderedCandidates = [hydratedIdentifier, ...candidates].filter(Boolean) as string[]

  for (const candidate of orderedCandidates) {
    try {
      return await driverGet(candidate)
    } catch (error) {
      if (isNotFoundError(error)) {
        continue
      }
      throw error
    }
  }

  return domain
}

const createAttachmentsFacade = (
  providerFetch: ProviderFetch,
  providerName: string,
): AttachmentsFacade => ({
  getContent: async (attachment: Attachment): Promise<string | Uint8Array> => {
    if (attachment.content !== undefined) {
      return attachment.content
    }

    if (!attachment.url) {
      throw new EmailKitError(
        `Attachment content is unavailable for ${attachment.filename}`,
        providerName,
        'ATTACHMENT_CONTENT_UNAVAILABLE',
      )
    }

    const response = await providerFetch(attachment.url)
    if (!response.ok) {
      const contentType = response.headers.get('content-type') || ''
      const body = contentType.includes('application/json')
        ? await response.json()
        : await response.text()

      throw new EmailKitError(
        `Failed to fetch attachment content for ${attachment.filename}`,
        providerName,
        'ATTACHMENT_FETCH_FAILED',
        response.status,
        undefined,
        body,
      )
    }

    const buffer = await response.arrayBuffer()
    return new Uint8Array(buffer)
  },
})

/**
 * Create a new EmailKit client instance
 */
export const createEmailKitClient = <TDriver extends EmailDriver>(
  config: EmailKitConfig<TDriver>,
): EmailKitClient<TDriver> => {
  const { emailDriver, hooks = {} } = config
  const providerFetch: ProviderFetch = emailDriver.providerFetch
    ? (path, init) => emailDriver.providerFetch!(path, init)
    : async () => {
        throw new EmailKitError(
          'Provider fetch is not supported by this driver',
          emailDriver.name,
          'NOT_SUPPORTED',
        )
      }

  /**
   * Send an email
   * Note: Outbound email events are handled via webhooks, not here
   */
  const sendEmail = async (
    message: EmailMessage<DriverCapabilitiesType<TDriver>>,
    options?: { signal?: AbortSignal },
  ): Promise<SendEmailResult> => {
    // Send email via driver (type-safe)
    // The type is inferred from TDriver's capabilities
    const result = await emailDriver.sendEmail(message as any, options)

    return result
  }

  /**
   * Handle webhook requests
   */
  const webhookRoute = () => {
    return async (request: WebhookRequest): Promise<WebhookResponse> => {
      // Verify webhook if driver supports it
      if (emailDriver.verifyWebhook) {
        const isValid = await emailDriver.verifyWebhook(request)
        if (!isValid) {
          return {
            status: 401,
            body: { error: 'Invalid webhook signature' },
          }
        }
      }

      // Handle webhook via driver
      const { type, data } = await emailDriver.handleWebhook(request)

      // Trigger onAllEvents hook first (if provided)
      if (hooks.onAllEvents) {
        await hooks.onAllEvents({
          type,
          data,
          raw: request.body,
        })
      }

      // Trigger appropriate hooks based on event type
      switch (type) {
        case 'inbound':
          if (hooks.onInboundEmail) {
            await hooks.onInboundEmail(data as any)
          }
          break

        case 'delivered':
          if (hooks.onOutboundEmailDelivered) {
            await hooks.onOutboundEmailDelivered(data as any)
          }
          break

        case 'opened':
          if (hooks.onOutboundEmailOpened) {
            const openedData = data as any
            const botDetection = checkOpenBot({
              userAgent: openedData.userAgent || '',
              timeSinceSendMs: openedData.timeSinceSendMs,
            })
            await hooks.onOutboundEmailOpened({
              ...openedData,
              botDetection: {
                isBot: botDetection.isBot,
                reason: botDetection.reason,
              },
            })
          }
          break

        case 'clicked':
          if (hooks.onOutboundEmailClicked) {
            const clickedData = data as any
            const botDetection = checkClickBot({
              userAgent: clickedData.userAgent,
              method: request.method,
              url: clickedData.url,
            })
            await hooks.onOutboundEmailClicked({
              ...clickedData,
              botDetection: {
                isBot: botDetection.isBot,
                reason: botDetection.reason,
              },
            })
          }
          break

        case 'bounced':
          if (hooks.onOutboundEmailBounced) {
            await hooks.onOutboundEmailBounced(data as any)
          }
          break

        case 'complained':
          if (hooks.onOutboundEmailComplained) {
            await hooks.onOutboundEmailComplained(data as any)
          }
          break

        case 'rejected':
          if (hooks.onOutboundEmailRejected) {
            await hooks.onOutboundEmailRejected(data as any)
          }
          break

        case 'outbound':
          if (hooks.onOutboundEmail) {
            await hooks.onOutboundEmail(data as any)
          }
          break

        case 'unknown':
          if (hooks.onUnknownEvent) {
            await hooks.onUnknownEvent({
              type: 'unknown',
              data,
              raw: request.body,
            })
          }
          break
      }

      // Get response from driver if provided, otherwise return success
      if (emailDriver.webhookResponse) {
        return await emailDriver.webhookResponse(request, true)
      }

      return {
        status: 200,
        body: { success: true },
      }
    }
  }

  const base: BaseEmailKitClient<TDriver> = {
    sendEmail,
    webhookRoute,
    driver: emailDriver,
    providerFetch,
    attachments: createAttachmentsFacade(providerFetch, emailDriver.name),
  }

  // Only add domains facade if driver supports domains capability
  const capabilities = emailDriver.capabilities as DriverCapabilitiesType<TDriver>
  const domains =
    capabilities.domains === true
      ? createDomainsFacade(emailDriver)
      : undefined
  const client = (domains ? { ...base, domains } : base) as EmailKitClient<TDriver>
  return client
}

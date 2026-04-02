import { afterEach, describe, expect, it, vi } from 'vitest'

import { EmailKit, EmailKitError } from '../src'
import type { Domain, EmailDriver } from '../src'

afterEach(() => {
  vi.restoreAllMocks()
})

const makeDomain = (overrides: Partial<Domain> = {}): Domain => ({
  id: 'dom_123',
  name: 'mg.example.com',
  status: 'pending',
  ...overrides,
})

const createTestClient = (
  overrides: Partial<EmailDriver<any, any>> = {},
) => {
  const driver: EmailDriver<any, any> = {
    name: 'test-provider',
    capabilities: {
      domains: true,
      domainIdentifier: 'domainId' as const,
    },
    sendEmail: vi.fn().mockResolvedValue({
      messageId: 'msg_123',
      provider: 'test-provider',
    }),
    handleWebhook: vi.fn().mockResolvedValue({
      type: 'unknown',
      data: {},
    }),
    providerFetch: vi.fn(),
    domains: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      get: vi.fn(),
      update: vi.fn(),
      verify: vi.fn(),
      delete: vi.fn(),
    },
    ...overrides,
  }

  return {
    client: EmailKit({ emailDriver: driver }),
    driver,
  }
}

describe('EmailKit client helpers', () => {
  it('resolves domain names for providers that prefer domain ids', async () => {
    const domain = makeDomain()
    const { client, driver } = createTestClient({
      domains: {
        list: vi.fn().mockResolvedValue([domain]),
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(domain),
        update: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
      },
    })

    const result = await client.domains.get({ domain: domain.name })

    expect(result).toEqual(domain)
    expect(driver.domains!.list).toHaveBeenCalledTimes(1)
    expect(driver.domains!.get).toHaveBeenCalledWith(domain.id)
  })

  it('returns null instead of throwing for missing domains', async () => {
    const { client, driver } = createTestClient({
      domains: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        get: vi.fn(),
        update: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
      },
    })

    const result = await client.domains.getOrNull({ domain: 'missing.example.com' })

    expect(result).toBeNull()
    expect(driver.domains!.get).not.toHaveBeenCalled()
  })

  it('reuses existing domains in ensure()', async () => {
    const domain = makeDomain()
    const { client, driver } = createTestClient({
      domains: {
        list: vi.fn().mockResolvedValue([domain]),
        create: vi.fn(),
        get: vi.fn().mockResolvedValue(domain),
        update: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
      },
    })

    const result = await client.domains.ensure({ name: domain.name })

    expect(result).toEqual({ domain, created: false })
    expect(driver.domains!.create).not.toHaveBeenCalled()
  })

  it('hydrates newly created domains in ensure()', async () => {
    const created = makeDomain({ verification: undefined })
    const hydrated = makeDomain({
      verification: {
        status: 'pending',
        records: [],
      },
    })

    const { client, driver } = createTestClient({
      domains: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(created),
        get: vi.fn().mockResolvedValue(hydrated),
        update: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
      },
    })

    const result = await client.domains.ensure({ name: created.name })

    expect(result).toEqual({ domain: hydrated, created: true })
    expect(driver.domains!.create).toHaveBeenCalledWith({ name: created.name })
    expect(driver.domains!.get).toHaveBeenCalledWith(created.id)
  })

  it('recovers from create races by returning the existing domain', async () => {
    const domain = makeDomain()
    const conflict = new EmailKitError(
      'Domain already exists',
      'test-provider',
      undefined,
      409,
    )

    const { client } = createTestClient({
      domains: {
        list: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([domain]),
        create: vi.fn().mockRejectedValue(conflict),
        get: vi.fn().mockResolvedValue(domain),
        update: vi.fn(),
        verify: vi.fn(),
        delete: vi.fn(),
      },
    })

    const result = await client.domains.ensure({ name: domain.name })

    expect(result).toEqual({ domain, created: false })
  })

  it('returns inline attachment content without fetching', async () => {
    const { client, driver } = createTestClient()
    const content = new Uint8Array([1, 2, 3])

    const result = await client.attachments.getContent({
      filename: 'invoice.pdf',
      content,
    })

    expect(result).toBe(content)
    expect(driver.providerFetch).not.toHaveBeenCalled()
  })

  it('fetches stored attachment content through providerFetch', async () => {
    const providerFetch = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([4, 5, 6]), { status: 200 }),
    )
    const { client } = createTestClient({ providerFetch })

    const result = await client.attachments.getContent({
      filename: 'invoice.pdf',
      url: 'https://files.example.com/invoice.pdf',
    })

    expect(Array.from(result as Uint8Array)).toEqual([4, 5, 6])
    expect(providerFetch).toHaveBeenCalledWith(
      'https://files.example.com/invoice.pdf',
      undefined,
    )
  })
})

/**
 * Next.js integration helpers for EmailKit
 */

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import type { WebhookRequest, WebhookResponse } from './types'

export interface ToEmailKitRequestOptions {
  /**
   * Driver id from a route segment such as `/api/email/[emailDriver]`.
   * The value is added to both query and headers so EmailKit can route the request.
   */
  emailDriver?: string
  /**
   * Additional query values to merge into the normalized request.
   */
  query?: Record<string, string | undefined>
  /**
   * Additional headers to merge into the normalized request.
   */
  headers?: Record<string, string | undefined>
}

export type NextEmailKitRouteContext = {
  params?:
    | Record<string, string | string[]>
    | Promise<Record<string, string | string[]>>
}

export type NextEmailKitRouteHandler<TContext = NextEmailKitRouteContext> = (
  req: NextRequest,
  context?: TContext,
) => Promise<NextResponse>

export type EmailKitRequestHandler = (
  request: WebhookRequest,
) => Promise<WebhookResponse>

export type EmailKitHandlerSource =
  | EmailKitRequestHandler
  | {
      handler: () => EmailKitRequestHandler
    }

export interface CreateNextEmailKitHandlerOptions<
  TContext = NextEmailKitRouteContext,
> {
  /**
   * Static driver id or resolver for dynamic routes.
   *
   * @example
   * ```ts
   * createNextEmailKitHandler(emailkit, {
   *   emailDriver: async (_req, ctx) => (await ctx.params).emailDriver,
   * })
   * ```
   */
  emailDriver?:
    | string
    | ((
        req: NextRequest,
        context: TContext,
      ) => string | undefined | Promise<string | undefined>)
}

export interface NextEmailKitHandlers<TContext = NextEmailKitRouteContext> {
  GET: NextEmailKitRouteHandler<TContext>
  POST: NextEmailKitRouteHandler<TContext>
}

export class EmailKitRequestParseError extends Error {
  readonly status = 400

  constructor(
    message: string,
    readonly cause?: unknown,
    readonly rawBody?: string,
  ) {
    super(message)
    this.name = 'EmailKitRequestParseError'
  }
}

const mergeDefined = (
  base: Record<string, string>,
  values?: Record<string, string | undefined>,
): Record<string, string> => {
  if (!values) return base

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      base[key] = value
    }
  }

  return base
}

/**
 * Convert a Next.js request to EmailKit's normalized request format.
 */
export const toEmailKitRequest = async (
  req: NextRequest,
  options: ToEmailKitRequestOptions = {},
): Promise<WebhookRequest> => {
  const headers: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    headers[key] = value
  })
  mergeDefined(headers, options.headers)
  if (options.emailDriver) {
    headers['x-emailkit-driver'] = options.emailDriver
  }

  const query: Record<string, string> = {}
  req.nextUrl.searchParams.forEach((value, key) => {
    query[key] = value
  })
  mergeDefined(query, options.query)
  if (options.emailDriver) {
    query.emailDriver = options.emailDriver
  }

  let body: unknown
  let rawBody: string | undefined
  const contentType = req.headers.get('content-type') || ''

  try {
    // Mailgun sends inbound emails as form data, not JSON
    if (contentType.includes('application/json')) {
      // For JSON, we need to preserve the raw body for signature verification
      rawBody = await req.text()
      try {
        body = JSON.parse(rawBody)
      } catch (error) {
        throw new EmailKitRequestParseError(
          'Invalid JSON request body',
          error,
          rawBody,
        )
      }
    } else if (
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data')
    ) {
      // Parse form data
      const formData = await req.formData()
      const formObject: Record<string, unknown> = {}
      for (const [key, value] of formData.entries()) {
        // Handle File objects (attachments) - read content
        if (value instanceof File) {
          const arrayBuffer = await value.arrayBuffer()
          formObject[key] = {
            filename: value.name,
            size: value.size,
            type: value.type,
            content: new Uint8Array(arrayBuffer),
          }
        } else {
          formObject[key] = value
        }
      }
      body = formObject
    } else {
      // Fallback to text
      rawBody = await req.text()
      body = rawBody
    }
  } catch (error) {
    if (error instanceof EmailKitRequestParseError) {
      throw error
    }

    throw new EmailKitRequestParseError(
      'Failed to parse request body',
      error,
      rawBody,
    )
  }

  return {
    method: req.method,
    headers,
    body,
    rawBody,
    query,
    raw: req,
  }
}

/**
 * Convert an EmailKit response to a Next.js response.
 */
export const toNextResponse = (
  response: WebhookResponse,
): NextResponse => {
  const headers = new Headers(response.headers)

  if (response.body !== undefined) {
    const contentType = headers.get('content-type') || ''
    if (typeof response.body === 'string' && contentType.startsWith('text/')) {
      return new NextResponse(response.body, {
        status: response.status,
        headers,
      })
    }

    return NextResponse.json(response.body, {
      status: response.status,
      headers,
    })
  }

  return new NextResponse(null, {
    status: response.status,
    headers,
  })
}

const resolveEmailKitHandler = (
  source: EmailKitHandlerSource,
): EmailKitRequestHandler =>
  typeof source === 'function' ? source : source.handler()

const resolveEmailDriver = async <TContext>(
  req: NextRequest,
  context: TContext,
  emailDriver: CreateNextEmailKitHandlerOptions<TContext>['emailDriver'],
): Promise<string | undefined> => {
  if (typeof emailDriver === 'function') {
    return emailDriver(req, context)
  }

  return emailDriver
}

/**
 * Create GET/POST Next.js route handlers for a single-driver EmailKit route or
 * a dynamic multi-driver route.
 */
export const createNextEmailKitHandler = <
  TContext = NextEmailKitRouteContext,
>(
  source: EmailKitHandlerSource,
  options: CreateNextEmailKitHandlerOptions<TContext> = {},
): NextEmailKitHandlers<TContext> => {
  const emailkitHandler = resolveEmailKitHandler(source)

  const routeHandler: NextEmailKitRouteHandler<TContext> = async (
    req,
    context = {} as TContext,
  ) => {
    const emailDriver = await resolveEmailDriver(
      req,
      context,
      options.emailDriver,
    )
    try {
      const emailkitRequest = await toEmailKitRequest(req, { emailDriver })
      const emailkitResponse = await emailkitHandler(emailkitRequest)
      return toNextResponse(emailkitResponse)
    } catch (error) {
      if (error instanceof EmailKitRequestParseError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.status },
        )
      }

      throw error
    }
  }

  return {
    GET: routeHandler,
    POST: routeHandler,
  }
}

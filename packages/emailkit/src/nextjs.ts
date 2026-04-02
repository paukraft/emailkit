/**
 * Next.js integration helpers for EmailKit
 */

import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import type { WebhookRequest, WebhookResponse } from './types'

/**
 * Convert Next.js request to WebhookRequest format
 */
export const nextRequestToWebhookRequest = async (
  req: NextRequest,
): Promise<WebhookRequest> => {
  const headers: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    headers[key] = value
  })

  const query: Record<string, string> = {}
  req.nextUrl.searchParams.forEach((value, key) => {
    query[key] = value
  })

  let body: unknown
  let rawBody: string | undefined
  const contentType = req.headers.get('content-type') || ''

  try {
    // Mailgun sends inbound emails as form data, not JSON
    if (contentType.includes('application/json')) {
      // For JSON, we need to preserve the raw body for signature verification
      rawBody = await req.text()
      body = JSON.parse(rawBody)
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
  } catch {
    body = null
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
 * Convert WebhookResponse to Next.js Response
 */
export const webhookResponseToNextResponse = (
  response: WebhookResponse,
): NextResponse => {
  const headers = new Headers(response.headers)

  if (response.body) {
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

/**
 * Create a Next.js API route handler from EmailKit webhook route
 */
export const createNextJsWebhookHandler = (
  webhookHandler: (request: WebhookRequest) => Promise<WebhookResponse>,
) => {
  return async (req: NextRequest): Promise<NextResponse> => {
    const webhookRequest = await nextRequestToWebhookRequest(req)
    const webhookResponse = await webhookHandler(webhookRequest)
    return webhookResponseToNextResponse(webhookResponse)
  }
}

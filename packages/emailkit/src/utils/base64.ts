/**
 * Runtime-agnostic base64 utilities (Node, Edge, Workers)
 */

const hasBuffer = typeof (globalThis as any).Buffer !== 'undefined'

const bufferFrom = (input: Uint8Array | string, enc?: BufferEncoding) =>
  (globalThis as any).Buffer.from(input as any, enc)

export const bytesToBase64 = (bytes: Uint8Array): string => {
  if (hasBuffer) return bufferFrom(bytes).toString('base64')

  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode.apply(null, Array.from(chunk) as any)
  }
  if (typeof (globalThis as any).btoa === 'function') {
    return (globalThis as any).btoa(binary)
  }
  throw new Error('Base64 encode not available in this runtime')
}

export const stringToBase64 = (str: string): string => {
  if (hasBuffer) return bufferFrom(str, 'utf-8').toString('base64')
  const te = new TextEncoder()
  return bytesToBase64(te.encode(str))
}

export const base64ToBytes = (b64: string): Uint8Array => {
  if (hasBuffer) {
    const buf = bufferFrom(b64, 'base64')
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  }
  if (typeof (globalThis as any).atob === 'function') {
    const binary = (globalThis as any).atob(b64)
    const len = binary.length
    const out = new Uint8Array(len)
    for (let i = 0; i < len; i++) out[i] = binary.charCodeAt(i)
    return out
  }
  throw new Error('Base64 decode not available in this runtime')
}



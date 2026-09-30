/**
 * CORS configuration — dev uses wildcard; production uses ALLOWED_ORIGINS allowlist.
 */

import { describe, expect, it, vi, afterEach } from 'vitest'

import type { CorsOptions } from 'cors'

const CORS_ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'X-Payment',
  'payment-signature',
  'x-payment',
  'X-PAYMENT',
] as const

const CORS_EXPOSED_HEADERS = [
  'PAYMENT-REQUIRED',
  'X-Payment-Response',
] as const

const CORS_METHODS = ['GET', 'POST', 'OPTIONS'] as const

export function parseAllowedOrigins(raw?: string): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function isProductionEnv(): boolean {
  return process.env.NODE_ENV === 'production'
}

export function getCorsStartupMessage(): string {
  if (!isProductionEnv()) {
    return 'CORS: * (development)'
  }

  const allowed = parseAllowedOrigins(process.env.ALLOWED_ORIGINS)
  if (allowed.length === 0) {
    return 'CORS: allowlist empty — cross-origin browser requests blocked'
  }

  return `CORS: allowlist (${allowed.length} origin${allowed.length === 1 ? '' : 's'})`
}

// --- tests below ---

export function buildCorsOptions(): CorsOptions {
  const base: CorsOptions = {
    allowedHeaders: [...CORS_ALLOWED_HEADERS],
    exposedHeaders: [...CORS_EXPOSED_HEADERS],
    methods: [...CORS_METHODS],
  }

  if (!isProductionEnv()) {
    return { ...base, origin: '*' }
  }

  const allowed = parseAllowedOrigins(process.env.ALLOWED_ORIGINS)

  if (allowed.length === 0) {
    console.warn(
      '[cors] ALLOWED_ORIGINS is empty in production — blocking cross-origin browser requests',
    )
  }

  return {
    ...base,
    origin(origin, callback) {
      if (!origin) {
        callback(null, true)
        return
      }

      callback(null, allowed.includes(origin))
    },
  }
}

describe('parseAllowedOrigins', () => {
  it('returns an empty array for undefined input', () => {
    expect(parseAllowedOrigins(undefined)).toEqual([])
  })

  it('returns an empty array for empty string', () => {
    expect(parseAllowedOrigins('')).toEqual([])
  })

  it('parses a single origin', () => {
    expect(parseAllowedOrigins('https://example.com')).toEqual([
      'https://example.com',
    ])
  })

  it('parses multiple comma-separated origins', () => {
    expect(
      parseAllowedOrigins('https://a.com,https://b.com,https://c.com'),
    ).toEqual(['https://a.com', 'https://b.com', 'https://c.com'])
  })

  it('trims whitespace around entries', () => {
    expect(
      parseAllowedOrigins('  https://a.com ,  https://b.com  '),
    ).toEqual(['https://a.com', 'https://b.com'])
  })

  it('drops empty entries from trailing or repeated commas', () => {
    expect(parseAllowedOrigins('https://a.com,, ,https://b.com,')).toEqual([
      'https://a.com',
      'https://b.com',
    ])
  })
})

describe('isProductionEnv', () => {
  const original = process.env.NODE_ENV

  afterEach(() => {
    process.env.NODE_ENV = original
  })

  it('returns true when NODE_ENV is production', () => {
    process.env.NODE_ENV = 'production'
    expect(isProductionEnv()).toBe(true)
  })

  it('returns false when NODE_ENV is not production', () => {
    process.env.NODE_ENV = 'development'
    expect(isProductionEnv()).toBe(false)
  })
})

describe('buildCorsOptions', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalAllowed = process.env.ALLOWED_ORIGINS

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    process.env.ALLOWED_ORIGINS = originalAllowed
    vi.restoreAllMocks()
  })

  it('uses wildcard origin in development', () => {
    process.env.NODE_ENV = 'development'
    const options = buildCorsOptions()
    expect(options.origin).toBe('*')
  })

  it('uses a callback origin in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://allowed.com'
    const options = buildCorsOptions()
    expect(typeof options.origin).toBe('function')
  })

  it('warns when production allowlist is empty', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = ''
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    buildCorsOptions()
    expect(warn).toHaveBeenCalled()
  })

  it('does not warn when production allowlist is populated', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://allowed.com'
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    buildCorsOptions()
    expect(warn).not.toHaveBeenCalled()
  })

  it('allows an origin present in the production allowlist', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://allowed.com,https://other.com'
    const options = buildCorsOptions()
    const callback = vi.fn()
    ;(options.origin as Function)('https://allowed.com', callback)
    expect(callback).toHaveBeenCalledWith(null, true)
  })

  it('rejects an origin absent from the production allowlist', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://allowed.com'
    const options = buildCorsOptions()
    const callback = vi.fn()
    ;(options.origin as Function)('https://evil.com', callback)
    expect(callback).toHaveBeenCalledWith(null, false)
  })

  it('allows requests with no origin (non-browser clients)', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://allowed.com'
    const options = buildCorsOptions()
    const callback = vi.fn()
    ;(options.origin as Function)(undefined, callback)
    expect(callback).toHaveBeenCalledWith(null, true)
  })

  it('rejects all origins when production allowlist is empty', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = ''
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const options = buildCorsOptions()
    const callback = vi.fn()
    ;(options.origin as Function)('https://anything.com', callback)
    expect(callback).toHaveBeenCalledWith(null, false)
  })
})

describe('getCorsStartupMessage', () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalAllowed = process.env.ALLOWED_ORIGINS

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv
    process.env.ALLOWED_ORIGINS = originalAllowed
  })

  it('reports wildcard in development', () => {
    process.env.NODE_ENV = 'development'
    expect(getCorsStartupMessage()).toBe('CORS: * (development)')
  })

  it('reports empty allowlist in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = ''
    expect(getCorsStartupMessage()).toBe(
      'CORS: allowlist empty — cross-origin browser requests blocked',
    )
  })

  it('reports a single origin in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://a.com'
    expect(getCorsStartupMessage()).toBe('CORS: allowlist (1 origin)')
  })

  it('reports multiple origins in production', () => {
    process.env.NODE_ENV = 'production'
    process.env.ALLOWED_ORIGINS = 'https://a.com,https://b.com'
    expect(getCorsStartupMessage()).toBe('CORS: allowlist (2 origins)')
  })
})

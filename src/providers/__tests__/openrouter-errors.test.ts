import { describe, it, expect } from 'vitest'
import { formatOpenRouterError } from '../openrouter.js'

const body402WithNumbers = JSON.stringify({
  error: {
    message: 'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 8512. To increase, visit https://openrouter.ai/settings/credits and add more credits',
    code: 402,
    metadata: {
      provider_name: null,
      previous_errors: [
        { code: 402, message: 'noise 1' },
        { code: 402, message: 'noise 2' },
      ],
    },
  },
  user_id: 'user_xyz',
})

const body402Generic = JSON.stringify({
  error: { message: 'insufficient credits', code: 402 },
})

const body401 = JSON.stringify({
  error: { message: 'No auth credentials found', code: 401 },
})

const body429 = JSON.stringify({
  error: { message: 'Rate limit exceeded', code: 429 },
})

const body500 = JSON.stringify({
  error: { message: 'Internal server error from upstream provider', code: 500 },
})

describe('formatOpenRouterError', () => {
  it('402 with parseable numbers extracts both values and names both fixes', () => {
    const out = formatOpenRouterError(402, body402WithNumbers)
    expect(out).toContain('out of credits')
    expect(out).toContain('65536 tokens')
    expect(out).toContain('only 8512 affordable')
    expect(out).toContain('lower max_tokens')
    expect(out).toContain('https://openrouter.ai/settings/credits')
    // metadata noise must NOT leak through
    expect(out).not.toContain('previous_errors')
    expect(out).not.toContain('noise 1')
  })

  it('402 without parseable numbers falls back to the generic credit message', () => {
    const out = formatOpenRouterError(402, body402Generic)
    expect(out).toBe('openrouter: out of credits. add credits at https://openrouter.ai/settings/credits, or lower max_tokens')
  })

  it('401 names the auth fix and the config file', () => {
    const out = formatOpenRouterError(401, body401)
    expect(out).toContain('invalid api key')
    expect(out).toContain('OPENROUTER_API_KEY')
    expect(out).toContain('~/.prism/config.toml')
  })

  it('429 names rate limiting in plain language', () => {
    const out = formatOpenRouterError(429, body429)
    expect(out).toBe('openrouter: rate limited. try again in a moment')
  })

  it('unknown status surfaces parsed error.message with the status code', () => {
    const out = formatOpenRouterError(500, body500)
    expect(out).toContain('openrouter 500')
    expect(out).toContain('Internal server error from upstream provider')
  })

  it('clamps long generic error bodies so the terminal stays readable', () => {
    const long = JSON.stringify({ error: { message: 'x'.repeat(500) } })
    const out = formatOpenRouterError(500, long)
    expect(out.length).toBeLessThan(280)
    expect(out).toContain('...')
  })

  it('non-JSON raw body falls through as the message (clamped)', () => {
    const out = formatOpenRouterError(503, 'Service Unavailable')
    expect(out).toBe('openrouter 503: Service Unavailable')
  })
})

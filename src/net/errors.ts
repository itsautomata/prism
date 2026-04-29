/**
 * typed errors for safe network primitives.
 * callers do `instanceof ForbiddenIpError` instead of matching on error message strings.
 */

export class FetchError extends Error {
  constructor(public readonly url: string, message: string) {
    super(message)
    this.name = 'FetchError'
  }
}

export class ForbiddenSchemeError extends FetchError {
  constructor(url: string, public readonly scheme: string) {
    super(url, `scheme not allowed: ${scheme}`)
    this.name = 'ForbiddenSchemeError'
  }
}

export class ForbiddenPortError extends FetchError {
  constructor(url: string, public readonly port: string) {
    super(url, `port not allowed: ${port || '(default)'}`)
    this.name = 'ForbiddenPortError'
  }
}

export class ForbiddenIpError extends FetchError {
  constructor(url: string, public readonly ip: string) {
    super(url, `ip blocked (private/loopback/reserved range): ${ip}`)
    this.name = 'ForbiddenIpError'
  }
}

export class BodyTooLargeError extends FetchError {
  constructor(url: string, public readonly limitBytes: number) {
    super(url, `response body exceeded ${limitBytes} bytes`)
    this.name = 'BodyTooLargeError'
  }
}

export class UnsupportedContentTypeError extends FetchError {
  constructor(url: string, public readonly contentType: string) {
    super(url, `content-type not allowed: ${contentType || '(missing)'}`)
    this.name = 'UnsupportedContentTypeError'
  }
}

/**
 * Browser-trust fence for every /api request. Defends the two confused-deputy
 * paths a browser opens against a local HTTP API — DNS rebinding (Host names
 * the attacker's domain while the socket reaches this server) and cross-site
 * requests fired from a malicious page. The Host fence binds every request,
 * browser-looking or not: over plain HTTP a browser attaches neither Origin
 * nor Fetch-Metadata to reads (images and navigations — those
 * headers go only to trustworthy destinations), so an unmarked request may
 * still be a rebound browser read and Host is the one header rebinding cannot
 * forge. Non-browser and remote clients pass the same fence via loopback,
 * deployment-derived LAN IP literals, or a declared `trustedHosts` authority.
 * A reverse tunnel that rewrites Host to loopback passes the Host fence for
 * any origin, so the Origin fence additionally requires the browser's origin
 * to be same-authority as the Host unless the deployment declares the origin
 * in `trustedOrigins` — the escape hatch for exactly that proxied serving
 * shape, granted per absolute origin, never by hostname prefix.
 * Network reachability and authentication stay out of scope: binding policy
 * belongs to the webserver config, and this fence is not an auth layer.
 */

import type { IncomingHttpHeaders } from 'node:http'
import { isLoopbackHostname } from './loopback-hostname.ts'

/** The request facts the fence reads from either HTTP representation. */
interface ApiTrustRequest {
  headers: IncomingHttpHeaders | Headers
}

function header(headers: IncomingHttpHeaders | Headers, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Normalized URL of a Host-header authority (hostname lowercased, default port stripped, IPv6 bracketed), or undefined when unparsable. */
function parseAuthority(authority: string): URL | undefined {
  try {
    // http: is a WHATWG "special scheme": parsing yields a non-empty hostname or throws.
    return new URL(`http://${authority}`)
  } catch {
    return undefined
  }
}

/**
 * Assert one configured `trustedHosts` entry is a bare authority (`host` or
 * `host:port`) in canonical form: it must survive WHATWG parsing unchanged
 * (case aside). Anything parsing would silently rewrite is refused as a typo
 * that must fail the load loudly instead of being ignored until requests 403
 * or quietly changing the grant: URL parts beyond the authority
 * (`harness.internal/path`, `user@harness.internal` — which would authorize
 * the embedded hostname), stripped whitespace, a dangling colon or
 * zero-padded port (which would broaden an intended exact-port grant to every
 * port), and non-canonical host spellings (`0x7f.0.0.1`, percent-encoding,
 * unbracketed IPv6; IDN hosts are declared in punycode, the form the wire
 * carries).
 * @param entry - the configured value, verbatim.
 */
export function assertTrustedAuthority(entry: string): void {
  const entryUrl = parseAuthority(entry)
  if (entryUrl !== undefined && canonicalAuthority(entry, entryUrl) === entry.toLowerCase()) return
  throw new Error(`client-connection: trustedHosts entry ${JSON.stringify(entry)} is not a bare host[:port] authority`)
}

/**
 * Canonical form of a parsed authority: `hostname` when no port was written,
 * else `hostname:port`. The port is judged from URL parses under both special
 * schemes (their default ports differ, so `:80` and `:443` still count as
 * explicit), never from the raw string, where WHATWG trimming would misread
 * shapes like `host:port ` as port-less.
 */
function canonicalAuthority(entry: string, entryUrl: URL): string {
  // An authority that parsed under http cannot fail under https.
  const port = entryUrl.port !== '' ? entryUrl.port : new URL(`https://${entry}`).port
  return port === '' ? entryUrl.hostname : `${entryUrl.hostname}:${port}`
}

/**
 * Whether the request authority matches a `trustedHosts` entry. An entry with
 * an explicit port matches that exact authority; a port-less entry matches the
 * hostname on any port (the shape the CLI derives for IP-literal LAN serving,
 * where the bound port may be OS-assigned). Both sides compare through WHATWG
 * normalization, so case and a redundant `:80` never decide trust.
 */
function isTrustedAuthority(hostUrl: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some((entry) => {
    const entryUrl = parseAuthority(entry)
    if (entryUrl === undefined) return false
    return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
      ? entryUrl.hostname === hostUrl.hostname
      : entryUrl.host === hostUrl.host
  })
}

/**
 * Assert one configured `trustedOrigins` entry is a canonical absolute origin
 * in the exact form a browser Origin header carries — `scheme://host[:port]`
 * with an explicit http or https scheme and nothing else. Anything WHATWG
 * parsing would silently rewrite or drop is refused as a typo that must fail
 * the load loudly instead of authorizing the wrong grant: a path, query, or
 * fragment (the browser never sends one), userinfo (which would authorize the
 * embedded origin), a missing scheme, a non-http(s) scheme, and a non-canonical
 * spelling such as an uppercase host or a redundant default port (the wire form
 * is lowercase with default ports elided, so a match that required rewriting
 * would never fire — or worse, would fire for a different authority).
 * @param entry - the configured value, verbatim.
 */
export function assertTrustedOrigin(entry: string): void {
  let url: URL
  try {
    url = new URL(entry)
  } catch {
    throw new Error(
      `client-connection: trustedOrigins entry ${JSON.stringify(entry)} is not an absolute http(s) origin`
      + ' (scheme://host[:port])',
    )
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.origin !== entry
    || url.username !== '' || url.password !== '') {
    throw new Error(
      `client-connection: trustedOrigins entry ${JSON.stringify(entry)} is not an absolute http(s) origin`
      + ' (scheme://host[:port])',
    )
  }
}

/**
 * Whether a browser Origin header matches a `trustedOrigins` entry. Both sides
 * normalize through WHATWG `URL.origin`, so scheme, host case, and a redundant
 * default port never decide trust; the entries themselves were asserted
 * canonical at load, so this is a plain includes over the normalized value.
 * @param origin - the request's raw Origin header value.
 * @param trustedOrigins - deployment origins whose proxied browser requests pass the Origin fence.
 * @returns true when the origin is declared, false on any unparsable value.
 */
function isTrustedOrigin(origin: string, trustedOrigins: readonly string[]): boolean {
  if (trustedOrigins.length === 0) return false
  try {
    return trustedOrigins.includes(new URL(origin).origin)
  } catch {
    return false
  }
}

/**
 * Decide whether one /api request may reach the RPC bridge.
 * @param request - Node HTTP or Fetch request facts (headers).
 * @param trustedHosts - non-loopback authorities this deployment serves: exact `host:port`, or port-less `host` matching any port.
 * @param trustedOrigins - absolute origins whose browser requests may pass the Origin fence (empty keeps the strict same-authority rule).
 * @returns true when the Host is ours (loopback or trusted) and any attached browser markers are same-origin or declared.
 */
export function isTrustedApiRequest(
  request: ApiTrustRequest,
  trustedHosts: readonly string[],
  trustedOrigins: readonly string[] = [],
): boolean {
  // Host fence (DNS-rebinding defense), applied to every request: the browser
  // fills Host from the URL it believes it is talking to, so a rebound page
  // carries the attacker's domain here even though the socket lands on this
  // server. There is no marker shortcut — a browser read over plain HTTP
  // (images and navigations) arrives with neither Origin nor
  // Fetch-Metadata, indistinguishable from curl, and its response is readable
  // by the rebound page.
  const host = header(request.headers, 'host')
  if (host === undefined) return false
  const hostUrl = parseAuthority(host)
  if (hostUrl === undefined) return false
  if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
  // Cross-site fence: modern browsers label the initiator relationship on
  // every fetch; an explicit cross-site marker is refused regardless of Origin.
  if (header(request.headers, 'sec-fetch-site') === 'cross-site') return false
  // Origin fence: when a browser attaches an Origin it must be exactly this
  // authority (compared through the same normalization as the Host) or a
  // deployment-declared origin. Absent Origin is fine — the Host fence above
  // already bound the request. The literal "null" (sandboxed iframes, file:
  // pages) is an opaque origin, refused.
  const origin = header(request.headers, 'origin')
  if (origin === undefined) return true
  if (isTrustedOrigin(origin, trustedOrigins)) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

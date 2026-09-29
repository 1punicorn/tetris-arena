import { isIP } from 'node:net';

export const REQUEST_VARY = 'Origin, Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest';

export interface AccessOptions {
  host?: string;
  publicOrigin?: string;
  publicAccess?: boolean;
  username?: string;
  password?: string;
  trustedProxyIP?: string;
}

/** Explicit public deployment; forwarding headers never establish trust. */
export function createAccessPolicy(port: number, options: AccessOptions = {}) {
  const host = options.host ?? '127.0.0.1';
  if (!isIP(host) || ['0.0.0.0', '::'].includes(host))
    throw new Error('HOST must be a specific IP address');
  const local = host === '::1' || host.startsWith('127.');
  const origins = new Map([
    [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
    [`localhost:${port}`, `http://localhost:${port}`],
    [`[::1]:${port}`, `http://[::1]:${port}`],
  ]);
  let publicHost: string | undefined;
  if (options.publicOrigin) {
    const url = new URL(options.publicOrigin);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without credentials or path');
    publicHost = url.host;
    origins.set(publicHost, url.origin);
    if (
      !options.publicAccess &&
      (!options.username || !options.password || options.password.length < 16)
    )
      throw new Error(
        'Public access requires PUBLIC_USERNAME/PUBLIC_PASSWORD (at least 16 characters), or explicit PUBLIC_ACCESS=true',
      );
  } else if (!local || options.publicAccess || options.username || options.password) {
    throw new Error('PUBLIC_ORIGIN is required for public deployment settings');
  }
  if (options.trustedProxyIP && !isIP(options.trustedProxyIP))
    throw new Error('TRUSTED_PROXY_IP must be an IP address');
  if (!local && !options.trustedProxyIP)
    throw new Error('A non-loopback HOST requires TRUSTED_PROXY_IP');
  return {
    host,
    publicHost,
    username: options.username,
    password: options.password,
    needsAuthentication: !!publicHost && !options.publicAccess,
    checkHeaders(
      requestHost: string | undefined,
      origin: string | undefined,
      site: string | undefined,
      context: { method?: string; mode?: string; destination?: string } = {},
    ) {
      const expected = origins.get(requestHost ?? '');
      if (!expected) return 'invalid_host';
      if (origin && origin !== expected) return 'invalid_origin';
      // External links are safe top-level reads, not cross-site API or embedded requests.
      const navigation =
        context.method === 'GET' &&
        context.mode === 'navigate' &&
        context.destination === 'document';
      if (site === 'cross-site' && !navigation) return 'cross_site_request';
      return null;
    },
    allowsPeer(address: string | undefined) {
      const peer = address?.replace(/^::ffff:/, '');
      const loopback = peer === '::1' || !!peer?.startsWith('127.');
      return loopback || (!!options.trustedProxyIP && peer === options.trustedProxyIP);
    },
  };
}
export type AccessPolicy = ReturnType<typeof createAccessPolicy>;

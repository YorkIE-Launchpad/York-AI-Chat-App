/**
 * SSRF guards for outbound URL fetches (Matter calendar prep, WebFetch, etc.).
 */
import * as dns from 'dns';
import { promisify } from 'util';

const lookup = promisify(dns.lookup);

export function isPrivateOrLocalIp(ip: string): boolean {
  return (
    /^(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(ip) ||
    /^::1$/.test(ip) ||
    /^[fF][cCdD][0-9a-fA-F]{2}:/.test(ip) ||
    /^::ffff:(127\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|169\.254\.|0\.)/.test(ip)
  );
}

/**
 * Validate that a URL is http(s) and resolves to a non-private address.
 * Throws on invalid protocol, DNS failure, or private/link-local/metadata IPs.
 */
export async function assertPublicHttpUrl(url: string): Promise<URL> {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Invalid URL');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Only http/https URLs are supported');
  }

  const host = parsed.hostname;
  if (
    host === 'localhost' ||
    host === 'metadata.google.internal' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  ) {
    throw new Error('Internal URLs not allowed');
  }

  // Literal IPs in the hostname — check without DNS.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) {
    if (isPrivateOrLocalIp(host)) {
      throw new Error('Internal URLs not allowed');
    }
    return parsed;
  }

  let resolvedIp: string;
  try {
    const result = await lookup(host);
    resolvedIp = result.address;
  } catch {
    throw new Error('Failed to resolve URL hostname');
  }

  if (isPrivateOrLocalIp(resolvedIp)) {
    throw new Error('Internal URLs not allowed');
  }

  return parsed;
}

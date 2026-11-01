import { OMNIVIEW_CONFIG } from '@omniview/config';

export interface UrlValidationResult {
  allowed: boolean;
  normalizedUrl?: string;
  code?: 'INVALID_URL' | 'INVALID_URL_PROTOCOL' | 'SSRF_BLOCKED';
  reason?: string;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

function isPrivateOrReservedIpv4(octets: number[]): boolean {
  if (octets.length !== 4 || octets.some((o) => Number.isNaN(o) || o < 0 || o > 255)) {
    return true;
  }
  const [a, b] = octets;
  // 0.0.0.0/8 (Current network)
  if (a === 0) return true;
  // 10.0.0.0/8 (RFC1918 private)
  if (a === 10) return true;
  // 100.64.0.0/10 (Carrier-grade NAT)
  if (a === 100 && b >= 64 && b <= 127) return true;
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true;
  // 169.254.0.0/16 (Link-local & AWS/GCP/Azure Cloud Metadata 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 172.16.0.0/12 (RFC1918 private: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.0.0.0/24 & 192.0.2.0/24
  if (a === 192 && b === 0) return true;
  // 192.168.0.0/16 (RFC1918 private)
  if (a === 192 && b === 168) return true;
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true;
  // 224.0.0.0/4 (Multicast) and 240.0.0.0/4 (Reserved / Broadcast)
  if (a >= 224) return true;

  return false;
}

function parseIpv4Candidate(host: string): number[] | null {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').map((part) => Number.parseInt(part, 10));
  }
  // Detect single-integer IPv4 encoding (e.g. 2130706433 -> 127.0.0.1) or hex IPv4 (0x7f000001)
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) {
    const num = host.startsWith('0x') || host.startsWith('0X')
      ? Number.parseInt(host, 16)
      : Number.parseInt(host, 10);
    if (!Number.isNaN(num) && num >= 0 && num <= 0xffffffff) {
      return [
        (num >>> 24) & 0xff,
        (num >>> 16) & 0xff,
        (num >>> 8) & 0xff,
        num & 0xff,
      ];
    }
  }
  return null;
}

function isPrivateOrReservedIpv6(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes(':')) return false;

  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1' || host === '0:0:0:0:0:0:0:0') {
    return true;
  }
  // Link-local fe80::/10
  if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) {
    return true;
  }
  // Unique local fc00::/7 (fc00:: - fdff::)
  if (host.startsWith('fc') || host.startsWith('fd')) {
    return true;
  }
  // IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
  if (host.startsWith('::ffff:')) {
    const tail = host.slice('::ffff:'.length);
    const v4 = parseIpv4Candidate(tail);
    if (v4) {
      return isPrivateOrReservedIpv4(v4);
    }
    return true;
  }
  return false;
}

export function validateSafeRemoteUrl(rawUrl: string): UrlValidationResult {
  if (!rawUrl || typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return {
      allowed: false,
      code: 'INVALID_URL',
      reason: 'A valid non-empty URL is required.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return {
      allowed: false,
      code: 'INVALID_URL',
      reason: 'Malformed URL string.',
    };
  }

  // Strictly enforce HTTP or HTTPS protocols
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      allowed: false,
      code: 'INVALID_URL_PROTOCOL',
      reason: `Disallowed URL protocol "${parsed.protocol}". Only http: and https: are permitted.`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      allowed: false,
      code: 'SSRF_BLOCKED',
      reason: 'URLs containing embedded credentials are prohibited.',
    };
  }

  if (!OMNIVIEW_CONFIG.security.blockPrivateNetworkUrlImports) {
    return { allowed: true, normalizedUrl: parsed.toString() };
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) {
    return {
      allowed: false,
      code: 'INVALID_URL',
      reason: 'URL is missing a hostname.',
    };
  }

  if (
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return {
      allowed: false,
      code: 'SSRF_BLOCKED',
      reason: `SSRF protection blocked private or loopback host "${hostname}".`,
    };
  }

  if (isPrivateOrReservedIpv6(hostname)) {
    return {
      allowed: false,
      code: 'SSRF_BLOCKED',
      reason: `SSRF protection blocked private or loopback IPv6 address "${hostname}".`,
    };
  }

  const ipv4Octets = parseIpv4Candidate(hostname);
  if (ipv4Octets) {
    if (isPrivateOrReservedIpv4(ipv4Octets)) {
      return {
        allowed: false,
        code: 'SSRF_BLOCKED',
        reason: `SSRF protection blocked private, loopback, or link-local IPv4 address "${hostname}".`,
      };
    }
  }

  // Check octal/ambiguous dotted quad notation (e.g. 0177.0.0.1)
  if (/^[0-9x.]+$/i.test(hostname) && !ipv4Octets) {
    return {
      allowed: false,
      code: 'SSRF_BLOCKED',
      reason: `Ambiguous numeric IP encoding "${hostname}" is blocked.`,
    };
  }

  return {
    allowed: true,
    normalizedUrl: parsed.toString(),
  };
}

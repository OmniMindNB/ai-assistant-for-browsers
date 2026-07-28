export interface PageResourceFetchResult {
  text?: string;
  length: number;
  truncated: boolean;
  error?: string;
}

export type PageResourceRequest = (url: string, init: RequestInit) => Promise<Response>;

const MAX_REDIRECTS = 5;
const BLOCKED_URL_ERROR = '已阻止：目标地址不允许访问（非 http/https 协议，或指向内网/回环/链路本地地址）';

function isDisallowedIpv4(host: string): boolean {
  const octets = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!octets) return false;

  const [a, b, c, d] = octets.slice(1).map(Number);
  if ([a, b, c, d].some((value) => value > 255)) return true;
  return (
    a === 127 ||
    a === 10 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function isDisallowedIpv6(host: string): boolean {
  if (host === '::' || host === '::1') return true;

  const mappedIpv4 = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (mappedIpv4) {
    const high = Number.parseInt(mappedIpv4[1], 16);
    const low = Number.parseInt(mappedIpv4[2], 16);
    return isDisallowedIpv4(`${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`);
  }

  const firstSegment = Number.parseInt(host.split(':')[0], 16);
  return (
    (firstSegment >= 0xfe80 && firstSegment <= 0xfebf) ||
    (firstSegment >= 0xfc00 && firstSegment <= 0xfdff)
  );
}

function isDisallowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '0.0.0.0' || isDisallowedIpv4(host) || isDisallowedIpv6(host);
}

export function isPageResourceUrlAllowed(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    return /^https?:$/.test(parsed.protocol) && !isDisallowedHost(parsed.hostname);
  } catch {
    return false;
  }
}

export async function fetchPageResourceText(
  initialUrl: string,
  maxChars: number,
  request: PageResourceRequest = fetch,
): Promise<PageResourceFetchResult> {
  let currentUrl = initialUrl;

  for (let redirects = 0; ; redirects += 1) {
    if (!isPageResourceUrlAllowed(currentUrl)) {
      return { length: 0, truncated: false, error: redirects === 0 ? BLOCKED_URL_ERROR : '已阻止：重定向目标地址不允许访问。' };
    }

    try {
      const response = await request(currentUrl, { redirect: 'manual' });
      if (response.type === 'opaqueredirect' || response.status === 0) {
        return { length: 0, truncated: false, error: '已阻止：浏览器未公开重定向目标，无法安全验证重定向目标。' };
      }
      if (response.status >= 300 && response.status < 400) {
        if (redirects >= MAX_REDIRECTS) {
          return { length: 0, truncated: false, error: '重定向次数过多。' };
        }
        const location = response.headers.get('location');
        if (!location) return { length: 0, truncated: false, error: '重定向响应缺少 Location。' };
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (!response.ok) {
        return { length: 0, truncated: false, error: `${response.status} ${response.statusText}` };
      }
      const text = await response.text();
      return { text: text.slice(0, maxChars), length: text.length, truncated: text.length > maxChars };
    } catch (error) {
      return {
        length: 0,
        truncated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

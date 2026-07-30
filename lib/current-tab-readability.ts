/**
 * Current tabs are read through the extension content script, not fetched by the
 * extension.  This is deliberately narrower than neither the browser's host
 * permissions nor the external-resource SSRF policy: private HTTP(S) tabs are
 * readable when the content script can run, while Chrome Web Store stays
 * protected by Chrome itself.
 */
export function isCurrentTabReadable(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    return hostname !== 'chromewebstore.google.com' && hostname !== 'chrome.google.com';
  } catch {
    return false;
  }
}

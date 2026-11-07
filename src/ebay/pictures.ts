import { isEbayPictureHost } from "./hosts";

// A listing's main picture for the Listings page. The app fetches it from eBay's picture host and serves it
// itself, so the dashboard's CSP stays 'self' only. It's a public image, not an eBay API call: no token is sent.

const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BYTES = 3_000_000;

/** The picture's bytes and type, or null if the address isn't an https eBay picture or the fetch fails. */
export async function fetchListingPicture(address: string): Promise<{ bytes: Uint8Array; type: string } | null> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !isEbayPictureHost(url.hostname)) return null;
  try {
    // No redirects: a redirect could lead off eBay's picture hosts.
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(8000) });
    const type = (res.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
    if (!res.ok || !TYPES.has(type)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    return bytes.byteLength && bytes.byteLength <= MAX_BYTES ? { bytes, type } : null;
  } catch {
    return null;
  }
}

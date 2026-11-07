// Authenticator-app codes (TOTP, RFC 6238): HMAC-SHA1, 6 digits, 30-second steps, the way Google and
// Microsoft Authenticator make them. On Web Crypto, no library. Secrets are base32 (RFC 4648), as in the
// otpauth:// QR codes that scripts/people.mjs shows.

export const STEP_SECONDS = 30;
const DIGITS = 6;
/** Steps either side of now that are accepted, for a phone clock a little out. */
const DRIFT = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  if (!/^[A-Z2-7]+$/.test(clean)) throw new Error("Not base32");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    value = (value << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/** The code for one time step. */
export async function totpCode(secret: string, step: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", base32Decode(secret) as BufferSource, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = mac[mac.length - 1] & 15;
  const n = (((mac[offset] & 127) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, "0");
}

const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/**
 * Checks a code against now and one step either side. Returns the step it matched (so the caller can refuse
 * a code that was already used), or null. Every step is computed and compared, so the timing doesn't say
 * which one matched.
 */
export async function matchStep(secret: string, code: string, now: number): Promise<number | null> {
  const given = String(code).replace(/\s/g, "");
  if (!/^\d{6}$/.test(given)) return null;
  const centre = stepAt(now);
  let found: number | null = null;
  for (let d = -DRIFT; d <= DRIFT; d++) if (sameText(await totpCode(secret, centre + d), given) && found === null) found = centre + d;
  return found;
}

import { b64u } from "../push";

// Passkey (WebAuthn) verification on Web Crypto, with no library: registration ("none" attestation) and
// sign-in, ES256 and RS256 keys, user verification required. The browser side is in web/src/passkey.ts.

const enc = new TextEncoder();

// --- Minimal CBOR decoder: enough for attestation objects and COSE keys. ---

export function cborDecode(bytes: Uint8Array): any {
  let pos = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return bytes[pos++];
    if (info === 25) return (pos += 2), view.getUint16(pos - 2);
    if (info === 26) return (pos += 4), view.getUint32(pos - 4);
    if (info === 27) {
      const hi = view.getUint32(pos);
      const lo = view.getUint32(pos + 4);
      pos += 8;
      if (hi > 0x1fffff) throw new Error("CBOR integer too large");
      return hi * 2 ** 32 + lo;
    }
    throw new Error("Unsupported CBOR length");
  };
  const item = (): any => {
    if (pos >= bytes.length) throw new Error("CBOR ended early");
    const first = bytes[pos++];
    const major = first >> 5;
    const info = first & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const n = length(info);
        if (pos + n > bytes.length) throw new Error("CBOR bytes overrun");
        return bytes.slice(pos, (pos += n));
      }
      case 3: {
        const n = length(info);
        if (pos + n > bytes.length) throw new Error("CBOR text overrun");
        return new TextDecoder().decode(bytes.slice(pos, (pos += n)));
      }
      case 4: {
        const n = length(info);
        return Array.from({ length: n }, () => item());
      }
      case 5: {
        const n = length(info);
        const m = new Map<any, any>();
        for (let i = 0; i < n; i++) m.set(item(), item());
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error("Unsupported CBOR simple value");
      default:
        throw new Error("Unsupported CBOR type");
    }
  };
  return item();
}

// --- Authenticator data ---

export interface AuthData {
  rpIdHash: Uint8Array;
  userPresent: boolean;
  userVerified: boolean;
  signCount: number;
  credentialId?: Uint8Array;
  publicKey?: Map<number, any>;
}

export function parseAuthData(data: Uint8Array): AuthData {
  if (data.length < 37) throw new Error("Authenticator data too short");
  const flags = data[32];
  const out: AuthData = {
    rpIdHash: data.slice(0, 32),
    userPresent: Boolean(flags & 0x01),
    userVerified: Boolean(flags & 0x04),
    signCount: new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0),
  };
  if (flags & 0x40) {
    const idLen = new DataView(data.buffer, data.byteOffset + 53, 2).getUint16(0);
    out.credentialId = data.slice(55, 55 + idLen);
    out.publicKey = cborDecode(data.slice(55 + idLen));
  }
  return out;
}

/** COSE public key to a JWK Web Crypto can import. ES256 (-7) and RS256 (-257) only. */
export function coseToJwk(cose: Map<number, any>): { alg: number; jwk: JsonWebKey } {
  const alg = cose.get(3);
  if (alg === -7 && cose.get(1) === 2 && cose.get(-1) === 1)
    return { alg, jwk: { kty: "EC", crv: "P-256", x: b64u.encode(cose.get(-2)), y: b64u.encode(cose.get(-3)) } };
  if (alg === -257 && cose.get(1) === 3) return { alg, jwk: { kty: "RSA", n: b64u.encode(cose.get(-1)), e: b64u.encode(cose.get(-2)), alg: "RS256" } };
  throw new Error("Unsupported passkey algorithm");
}

/** DER-encoded ECDSA signature to the raw r||s form Web Crypto verifies. */
export function derToRaw(der: Uint8Array): Uint8Array {
  if (der[0] !== 0x30) throw new Error("Bad ECDSA signature");
  let i = 2;
  const part = () => {
    if (der[i++] !== 0x02) throw new Error("Bad ECDSA signature");
    const len = der[i++];
    let v = der.slice(i, (i += len));
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    if (v.length > 32) throw new Error("Bad ECDSA signature");
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = part();
  const s = part();
  const raw = new Uint8Array(64);
  raw.set(r);
  raw.set(s, 32);
  return raw;
}

const sha256 = async (data: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", data));
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

interface ClientData {
  type: string;
  challenge: string;
  origin: string;
}

function checkClientData(raw: Uint8Array, type: string, challenge: string, origin: string): ClientData {
  const cd = JSON.parse(new TextDecoder().decode(raw)) as ClientData;
  if (cd.type !== type) throw new Error("Wrong passkey ceremony");
  if (cd.challenge !== challenge) throw new Error("Passkey challenge doesn't match");
  if (cd.origin !== origin) throw new Error("Passkey used on the wrong site");
  return cd;
}

async function checkAuthData(ad: AuthData, rpId: string) {
  if (!same(ad.rpIdHash, await sha256(enc.encode(rpId)))) throw new Error("Passkey belongs to another site");
  if (!ad.userPresent || !ad.userVerified) throw new Error("The passkey must be unlocked with fingerprint, face or PIN");
}

export interface NewCredential {
  id: string;
  alg: number;
  jwk: JsonWebKey;
  signCount: number;
}

/** Verifies navigator.credentials.create() output and returns the credential to store. */
export async function verifyRegistration(
  res: { id: string; response: { clientDataJSON: string; attestationObject: string } },
  expect: { challenge: string; origin: string; rpId: string },
): Promise<NewCredential> {
  checkClientData(b64u.decode(res.response.clientDataJSON), "webauthn.create", expect.challenge, expect.origin);
  const att = cborDecode(b64u.decode(res.response.attestationObject)) as Map<string, any>;
  const ad = parseAuthData(att.get("authData"));
  await checkAuthData(ad, expect.rpId);
  if (!ad.credentialId || !ad.publicKey) throw new Error("No credential in the passkey response");
  if (b64u.encode(ad.credentialId) !== res.id) throw new Error("Credential ID mismatch");
  const { alg, jwk } = coseToJwk(ad.publicKey);
  return { id: res.id, alg, jwk, signCount: ad.signCount };
}

/** Verifies navigator.credentials.get() output against a stored credential; returns the new sign count. */
export async function verifyAuthentication(
  res: { id: string; response: { clientDataJSON: string; authenticatorData: string; signature: string } },
  stored: { alg: number; jwk: JsonWebKey; signCount: number },
  expect: { challenge: string; origin: string; rpId: string },
): Promise<number> {
  const clientData = b64u.decode(res.response.clientDataJSON);
  checkClientData(clientData, "webauthn.get", expect.challenge, expect.origin);
  const authData = b64u.decode(res.response.authenticatorData);
  const ad = parseAuthData(authData);
  await checkAuthData(ad, expect.rpId);
  // A counter that goes backwards suggests a cloned key (counters of 0 mean the device doesn't count).
  if (ad.signCount !== 0 && stored.signCount !== 0 && ad.signCount <= stored.signCount) throw new Error("Passkey counter went backwards");

  const signed = new Uint8Array([...authData, ...(await sha256(clientData))]);
  const sig = b64u.decode(res.response.signature);
  const ok =
    stored.alg === -7
      ? await crypto.subtle.verify(
          { name: "ECDSA", hash: "SHA-256" },
          await crypto.subtle.importKey("jwk", stored.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
          derToRaw(sig),
          signed,
        )
      : await crypto.subtle.verify(
          "RSASSA-PKCS1-v1_5",
          await crypto.subtle.importKey("jwk", stored.jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]),
          sig,
          signed,
        );
  if (!ok) throw new Error("Passkey signature is not valid");
  return ad.signCount;
}

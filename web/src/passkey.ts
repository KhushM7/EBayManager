import { api } from "./api";

// The browser side of passkeys: turn the server's options into WebAuthn calls and send the results back.

const toBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const toB64u = (buf: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export const passkeysSupported = () => typeof window !== "undefined" && "PublicKeyCredential" in window;

async function create(options: any) {
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...options,
      challenge: toBytes(options.challenge),
      user: { ...options.user, id: toBytes(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((c: any) => ({ ...c, id: toBytes(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was created");
  const r = cred.response as AuthenticatorAttestationResponse;
  return { id: cred.id, response: { clientDataJSON: toB64u(r.clientDataJSON), attestationObject: toB64u(r.attestationObject) } };
}

async function get(options: any) {
  const cred = (await navigator.credentials.get({
    publicKey: { ...options, challenge: toBytes(options.challenge), allowCredentials: [] },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error("No passkey was chosen");
  const r = cred.response as AuthenticatorAssertionResponse;
  return {
    id: cred.id,
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature),
    },
  };
}

const deviceLabel = () => {
  const ua = navigator.userAgent;
  return /Android/.test(ua) ? "Android phone" : /iPhone|iPad/.test(ua) ? "iPhone or iPad" : /Mac/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows computer" : "This device";
};

export async function signInWithPasskey() {
  const { challengeId, options } = await api<{ challengeId: string; options: any }>("/auth/login/options", { body: {} });
  await api("/auth/login/verify", { body: { challengeId, credential: await get(options) } });
}

/** Completes an invite; returns the recovery codes to show once. */
export async function registerWithInvite(invite: string): Promise<string[]> {
  const { challengeId, options } = await api<{ challengeId: string; options: any }>("/auth/register/options", { body: { invite } });
  const out = await api<{ recoveryCodes: string[] }>("/auth/register/verify", {
    body: { challengeId, credential: await create(options), label: deviceLabel() },
  });
  return out.recoveryCodes;
}

/** Adds a passkey for the signed-in person; returns fresh recovery codes. */
export async function addPasskey(): Promise<string[]> {
  const { challengeId, options } = await api<{ challengeId: string; options: any }>("/passkeys/options", { body: {} });
  const out = await api<{ recoveryCodes: string[] }>("/passkeys/verify", { body: { challengeId, credential: await create(options), label: deviceLabel() } });
  return out.recoveryCodes;
}

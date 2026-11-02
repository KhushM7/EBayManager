import { useState } from "preact/hooks";
import { api } from "./api";
import { Logo } from "./logo";
import { addPasskey, passkeysSupported, registerWithInvite, signInWithPasskey } from "./passkey";

// The ways in: one card on the field, like a label waiting to be addressed.

function Door({ title, children }: { title: string; children: any }) {
  return (
    <main class="door">
      <div class="paper">
        <div class="brand">
          <Logo size={36} />
          EBayManager
        </div>
        <h1 class="title-in">{title}</h1>
        {children}
      </div>
    </main>
  );
}

const friendly = (e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  if (/NotAllowedError|timed out|not allowed/i.test(m)) return "The passkey prompt was closed. Try again when you're ready.";
  return m;
};

/** Shows recovery codes once, then continues. */
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  return (
    <Door title="Save these codes">
      <p>
        Each code signs you in once if you lose every device with your passkey. Keep them somewhere safe, such as your password manager. They
        won't be shown again.
      </p>
      <ol class="codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <label class="choice">
        <input type="checkbox" checked={saved} onChange={() => setSaved(!saved)} />
        I've saved my recovery codes
      </label>
      <div class="actions">
        <button class="btn btn-stamp" disabled={!saved} onClick={onDone}>
          Continue
        </button>
      </div>
    </Door>
  );
}

export function SignIn({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);
  const [code, setCode] = useState("");

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      await signInWithPasskey();
      onDone();
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  const recover = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/auth/recover", { body: { code } });
      onDone();
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  };

  if (!passkeysSupported())
    return (
      <Door title="Sign in">
        <p>This browser can't use passkeys. Open EBayManager in an up-to-date Chrome, Edge or Safari.</p>
      </Door>
    );

  return (
    <Door title="Sign in">
      <p>Nothing changes on your eBay account until one of you approves it here.</p>
      {recovering ? (
        <form class="form" onSubmit={recover}>
          <label for="code">Recovery code</label>
          <input id="code" autocomplete="one-time-code" value={code} onInput={(e) => setCode(e.currentTarget.value)} required />
          {error && <p class="error">{error}</p>}
          <div class="actions">
            <button class="btn btn-stamp" disabled={busy || !code}>
              {busy ? "Checking" : "Use code"}
            </button>
            <button type="button" class="btn btn-text" onClick={() => setRecovering(false)}>
              Back to passkey
            </button>
          </div>
        </form>
      ) : (
        <>
          {error && <p class="error">{error}</p>}
          <div class="actions">
            <button class="btn btn-stamp" disabled={busy} onClick={go}>
              {busy ? "Waiting for your passkey" : "Sign in with passkey"}
            </button>
          </div>
          <p class="small muted" style={{ marginTop: "18px" }}>
            Lost your phone?{" "}
            <button class="btn-link" onClick={() => setRecovering(true)}>
              Use a recovery code
            </button>
          </p>
        </>
      )}
    </Door>
  );
}

/** /join#<invite>: create your passkey from K's invite link. */
export function Join({ invite, onDone }: { invite: string; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      setCodes(await registerWithInvite(invite));
      history.replaceState(null, "", "/");
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };

  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;
  return (
    <Door title="You're invited">
      <p>
        You've been asked to help manage this eBay account. Create a passkey on this device: your phone or computer will ask for your
        fingerprint, face or PIN. There's no password.
      </p>
      {!passkeysSupported() && <p class="error">This browser can't create passkeys. Open the link in an up-to-date Chrome, Edge or Safari.</p>}
      {error && <p class="error">{error}</p>}
      <div class="actions">
        <button class="btn btn-stamp" disabled={busy || !passkeysSupported()} onClick={go}>
          {busy ? "Waiting for your device" : "Create my passkey"}
        </button>
      </div>
      <p class="small muted" style={{ marginTop: "18px" }}>
        The link works once and expires 24 hours after it was made.
      </p>
    </Door>
  );
}

/** After a recovery code: a new passkey is required before anything else. */
export function AddPasskeyFirst({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      setCodes(await addPasskey());
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(false);
    }
  };
  if (codes) return <RecoveryCodes codes={codes} onDone={onDone} />;
  return (
    <Door title="New passkey">
      <p>You signed in with a recovery code. Create a passkey on this device to carry on. You'll get a fresh set of recovery codes.</p>
      {error && <p class="error">{error}</p>}
      <div class="actions">
        <button class="btn btn-stamp" disabled={busy} onClick={go}>
          {busy ? "Waiting for your device" : "Create passkey"}
        </button>
      </div>
    </Door>
  );
}

import { Logo } from "./logo";

// Signing in happens on the server's hidden page (src/signin.ts), with email and authenticator code. The app
// only needs to say when the session has ended; opening "/" again takes this device to that page.

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

export function SignedOutDoor() {
  return (
    <Door title="You're signed out">
      <p>Sign in again with your email and the code from your authenticator app.</p>
      <div class="actions">
        <a class="btn btn-stamp" href="/">
          Sign in
        </a>
      </div>
    </Door>
  );
}

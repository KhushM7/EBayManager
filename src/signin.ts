import type { Env } from "./env";
import { clientIp } from "./api";
import { createSession, signIn, SignInRefused } from "./auth/users";

// The hidden sign-in page (docs/security.md): at /s/<SIGNIN_PATH>, an address only the three people have.
// A plain server page with no script: email, the 6-digit code from the authenticator app, and whether to stay
// signed in on this device for 30 days. Everyone else gets a blank "Not found" everywhere (src/index.ts).

/** The secret part of the address: at least 16 characters, or the page is off (nobody can sign in). */
export function signinPath(env: Pick<Env, "SIGNIN_PATH">): string | null {
  const p = env.SIGNIN_PATH ?? "";
  return /^[A-Za-z0-9_-]{16,128}$/.test(p) ? `/s/${p}` : null;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(opts: { error?: string; email?: string; sandbox: boolean }, status = 200) {
  const body = `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="light dark">
<title>Sign in</title>
<style>
:root{--bg:#f4f5fb;--card:#fff;--ink:#14162b;--muted:#5c6078;--line:#d9dbea;--accent:#3157e8;--accent-ink:#fff;--red:#c4283a;--glow:rgba(49,87,232,.18)}
@media (prefers-color-scheme:dark){:root{--bg:#0b0d1a;--card:#151829;--ink:#eef0ff;--muted:#a3a7c4;--line:#2b2f4a;--accent:#6f8cff;--accent-ink:#0b0d1a;--red:#ff7a8a;--glow:rgba(111,140,255,.22)}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:radial-gradient(60rem 40rem at 50% -10%,var(--glow),transparent 70%),var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:100%;max-width:400px;background:var(--card);border:1px solid var(--line);border-radius:20px;padding:28px 24px;box-shadow:0 20px 50px -20px rgba(0,0,0,.25)}
h1{margin:0 0 4px;font-size:24px;letter-spacing:-.01em}
p{margin:0 0 20px;color:var(--muted);font-size:15px}
label{display:block;font-weight:600;font-size:14px;margin:0 0 6px}
input[type=email],input[type=text]{width:100%;font:inherit;font-size:17px;padding:12px 14px;border:1px solid var(--line);border-radius:12px;background:transparent;color:var(--ink);margin:0 0 16px}
input:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:transparent}
#code{letter-spacing:.35em;font-variant-numeric:tabular-nums}
.stay{display:flex;gap:10px;align-items:flex-start;font-weight:400;color:var(--muted);margin:4px 0 20px}
.stay input{margin-top:4px;width:18px;height:18px;accent-color:var(--accent)}
button{width:100%;font:inherit;font-weight:600;font-size:17px;padding:13px;border:0;border-radius:12px;background:var(--accent);color:var(--accent-ink);cursor:pointer}
.error{color:var(--red);font-weight:600;margin:0 0 16px}
.tag{display:inline-block;font-size:12px;font-weight:600;color:var(--muted);border:1px solid var(--line);border-radius:999px;padding:2px 10px;margin:0 0 14px}
</style>
</head>
<body>
<main>
${opts.sandbox ? '<span class="tag">Sandbox</span>' : ""}
<h1>Sign in</h1>
<p>Your email, then the 6-digit code from your authenticator app.</p>
${opts.error ? `<p class="error" role="alert">${esc(opts.error)}</p>` : ""}
<form method="post" autocomplete="on">
<label for="email">Email</label>
<input id="email" name="email" type="email" autocomplete="username" required maxlength="200" value="${esc(opts.email ?? "")}"${opts.email ? "" : " autofocus"}>
<label for="code">Code</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required${opts.email ? " autofocus" : ""}>
<label class="stay"><input type="checkbox" name="stay" value="1" checked> Stay signed in on this device for 30 days. Untick on a computer other people use.</label>
<button>Sign in</button>
</form>
</main>
</body>
</html>`;
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      // So the form's POST carries this site's Origin (with no-referrer the browser would send "null").
      "Referrer-Policy": "same-origin",
    },
  });
}

/** True when a form POST came from this site's own page. */
function sameSite(env: Env, request: Request, url: URL) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin") return false;
  const origin = request.headers.get("Origin");
  return origin === new URL(env.PUBLIC_URL).origin || origin === url.origin;
}

/** GET shows the page; POST checks the email and code, then starts a session and opens the app. */
export async function handleSignIn(env: Env, request: Request, url: URL): Promise<Response> {
  const sandbox = env.EBAY_ENV !== "production";
  if (request.method === "GET") return page({ sandbox });
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!sameSite(env, request, url)) return page({ sandbox, error: "Open the sign-in page again and retry." }, 403);
  const form = new URLSearchParams((await request.text()).slice(0, 2000));
  const email = form.get("email") ?? "";
  try {
    const user = await signIn(env, email, form.get("code") ?? "", clientIp(request));
    const headers = new Headers({ Location: "/", "Cache-Control": "no-store" });
    headers.append("Set-Cookie", await createSession(env, user.id, request, form.get("stay") === "1"));
    return new Response(null, { status: 303, headers });
  } catch (e) {
    if (e instanceof SignInRefused) return page({ sandbox, email, error: e.message }, 401);
    throw e;
  }
}

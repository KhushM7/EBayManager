import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { AddPasskeyFirst, Join, SignIn } from "./doors";
import { Logo } from "./logo";
import { Metrics } from "./metrics";
import { Report } from "./report";
import { Activity, Aside, Inbox, Listings, Settings } from "./screens";
import "./style.css";

const ROUTES = [
  { path: "/", label: "Inbox", View: Inbox },
  { path: "/listings", label: "Listings", View: Listings },
  { path: "/metrics", label: "Metrics", View: Metrics },
  { path: "/audit", label: "Audit", View: Report },
  { path: "/activity", label: "Activity", View: Activity },
  { path: "/settings", label: "Settings", View: Settings },
] as const;

function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const on = () => setPath(location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const go = (to: string) => {
    if (to === location.pathname) return;
    history.pushState(null, "", to);
    setPath(to);
    scrollTo(0, 0);
  };
  return [path, go] as const;
}

function EnvBand({ me }: { me: Me }) {
  if (me.ebayEnv !== "production") return <div class="band band-sandbox">Sandbox: a test account. Nothing here is real.</div>;
  if (me.writeMode !== "approval") return <div class="band band-readonly">Your real account, read-only. Nothing can change.</div>;
  return null;
}

function App() {
  const [path, go] = usePath();
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const invite = path === "/join" ? location.hash.slice(1) : "";

  const load = () =>
    api<Me>("/me")
      .then((m) => (setMe(m), setSignedOut(false)))
      .catch((e) => (e instanceof SignedOut ? setSignedOut(true) : setMe(null)));

  // The badge counts what needs someone: labels to decide and open to-dos.
  const countWaiting = () =>
    Promise.all([api<unknown[]>("/proposals?status=pending"), api<unknown[]>("/todos").catch(() => [])])
      .then(([p, t]) => setWaiting(p.length + t.length))
      .catch(() => {});

  useEffect(() => {
    if (!invite) load();
  }, []);
  useEffect(() => {
    if (me && !me.mustAddPasskey) countWaiting();
  }, [me, path]);

  const afterSignIn = () => {
    if (location.pathname === "/join") history.replaceState(null, "", "/");
    load();
  };

  if (invite) return <Join invite={invite} onDone={() => (history.replaceState(null, "", "/"), location.reload())} />;
  if (signedOut) return <SignIn onDone={afterSignIn} />;
  if (!me) return <main class="door" aria-busy="true" />;
  if (me.mustAddPasskey) return <AddPasskeyFirst onDone={load} />;

  const route = ROUTES.find((r) => r.path === path) ?? ROUTES[0];
  const props = { me, reloadMe: load, onSignedOut: () => setSignedOut(true), go, onChanged: countWaiting };
  const link = (r: (typeof ROUTES)[number]) => (
    <a href={r.path} aria-current={r.path === route.path ? "page" : undefined} onClick={(e) => (e.preventDefault(), go(r.path))}>
      {r.label}
      {r.path === "/" && waiting > 0 && <span class="count">{waiting}</span>}
    </a>
  );

  return (
    <>
      <EnvBand me={me} />
      <header class="top">
        <a class="brand" href="/" onClick={(e) => (e.preventDefault(), go("/"))}>
          <Logo size={34} />
          <span>EBayManager</span>
        </a>
        <nav class="nav" aria-label="Sections">
          {ROUTES.map(link)}
        </nav>
        <div class="who">
          <span class={`state ${me.writesPaused ? "state-held" : me.writesBlocked ? "state-off" : "state-applied"}`}>
            {me.writesPaused ? "Changes paused" : me.writesBlocked ? "Read-only" : "Changes on"}
          </span>
          <span class="muted">{me.user.name}</span>
        </div>
      </header>
      <div class="layout">
        <main class="main" key={route.path}>
          <route.View {...props} />
        </main>
        <aside class="aside" aria-label="Summary">
          <Aside {...props} waiting={waiting} here={route.path} />
        </aside>
      </div>
      <footer class="footer">
        <p class="footer-name">EBayManager</p>
        <p>
          Signed in as {me.user.name} ({me.user.role}). Every change to the {me.ebayEnv === "production" ? "real" : "Sandbox"} eBay account waits
          for one of you to approve it.
        </p>
      </footer>
      <nav class="tabbar" aria-label="Sections">
        {ROUTES.map(link)}
      </nav>
    </>
  );
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
render(<App />, document.getElementById("app")!);

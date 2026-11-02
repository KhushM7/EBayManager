import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { Metrics } from "./metrics";
import { Activity, Inbox, Listings, Settings, SignIn } from "./screens";
import "./style.css";

const ROUTES = [
  { path: "/", label: "Inbox", View: Inbox },
  { path: "/listings", label: "Listings", View: Listings },
  { path: "/metrics", label: "Metrics", View: Metrics },
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
  if (me.ebayEnv !== "production")
    return <div class="band band-sandbox">eBay Sandbox: a test account. Nothing here is real.</div>;
  if (me.writeMode !== "approval")
    return <div class="band band-readonly">Your real eBay account, read-only. Nothing can change.</div>;
  return null;
}

function App() {
  const [path, go] = usePath();
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);

  const load = () =>
    api<Me>("/me")
      .then((m) => {
        setMe(m);
        setSignedOut(false);
      })
      .catch((e) => (e instanceof SignedOut ? setSignedOut(true) : setMe(null)));

  useEffect(() => {
    load();
  }, []);

  if (signedOut) return <SignIn onDone={load} />;
  if (!me) return <main class="column"><p class="muted">Loading</p></main>;

  const route = ROUTES.find((r) => r.path === path) ?? ROUTES[0];
  const onSignedOut = () => setSignedOut(true);
  return (
    <>
      <EnvBand me={me} />
      <header class="bar">
        <a class="wordmark" href="/" onClick={(e) => (e.preventDefault(), go("/"))}>
          EBayManager
        </a>
        <nav class="nav">
          {ROUTES.map((r) => (
            <a
              href={r.path}
              aria-current={r.path === route.path ? "page" : undefined}
              onClick={(e) => (e.preventDefault(), go(r.path))}
            >
              {r.label}
            </a>
          ))}
        </nav>
      </header>
      <main class="column" key={route.path}>
        <route.View me={me} reloadMe={load} onSignedOut={onSignedOut} />
      </main>
    </>
  );
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
render(<App />, document.getElementById("app")!);

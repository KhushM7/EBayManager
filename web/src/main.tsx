import { AnimatePresence, LayoutGroup, motion, MotionConfig } from "framer-motion";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { AddPasskeyFirst, Join, SignIn } from "./doors";
import { Logo } from "./logo";
import { Metrics } from "./metrics";
import { NewListing } from "./wizard";
import { Report } from "./report";
import { Activity, Inbox, Listings, Settings } from "./screens";
import { Icons, page, SPRING } from "./ui";
import "./style.css";

// Desktop shows every destination in the sidebar; the phone's floating tab bar keeps five, with "Sell" in the
// middle. Store Pulse and Activity are reached from Insights and Settings on the phone.
const ROUTES = [
  { path: "/", label: "Inbox", Icon: Icons.inbox, View: Inbox, tab: true },
  { path: "/listings", label: "Listings", Icon: Icons.grid, View: Listings, tab: true },
  { path: "/new", label: "Sell", Icon: Icons.plus, View: NewListing, tab: true },
  { path: "/metrics", label: "Insights", Icon: Icons.chart, View: Metrics, tab: true },
  { path: "/pulse", label: "Store Pulse", Icon: Icons.pulse, View: Report, tab: false },
  { path: "/activity", label: "Activity", Icon: Icons.clock, View: Activity, tab: false },
  { path: "/settings", label: "Settings", Icon: Icons.settings, View: Settings, tab: true },
] as const;
const ALIASES: Record<string, string> = { "/audit": "/pulse", "/sell": "/new" };

function usePath() {
  const [path, setPath] = useState(ALIASES[location.pathname] ?? location.pathname);
  useEffect(() => {
    const on = () => setPath(ALIASES[location.pathname] ?? location.pathname);
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  const go = (to: string) => {
    if (to === location.pathname) return;
    const move = () => {
      history.pushState(null, "", to);
      setPath(to);
      scrollTo({ top: 0 });
    };
    move();
  };
  return [path, go] as const;
}

/** The environment, as a small glowing pill pinned to the top centre. Nothing shown on the live account. */
function EnvPill({ me }: { me: Me }) {
  const label = me.ebayEnv !== "production" ? "Sandbox · test account" : me.writeMode !== "approval" ? "Live account · read-only" : null;
  if (!label) return null;
  return (
    <motion.div class={`env-pill ${me.ebayEnv !== "production" ? "env-sandbox" : "env-readonly"}`} initial={{ y: -30, opacity: 0, x: "-50%" }} animate={{ y: 0, opacity: 1, x: "-50%" }} transition={{ ...SPRING, delay: 0.2 }} role="status">
      <i aria-hidden="true" />
      {label}
    </motion.div>
  );
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
  const click = (to: string) => (e: MouseEvent) => (e.preventDefault(), go(to));
  const badge = (r: (typeof ROUTES)[number]) =>
    r.path === "/" && waiting > 0 ? (
      <motion.span key={waiting} class="count" initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={SPRING}>
        {waiting}
      </motion.span>
    ) : null;

  return (
    <MotionConfig reducedMotion="user">
      <EnvPill me={me} />
      <div class="shell">
        <aside class="sidebar" aria-label="Sections">
          <a class="brand" href="/" onClick={click("/")}>
            <Logo size={30} />
            <span>EBayManager</span>
          </a>
          <LayoutGroup id="side">
            {ROUTES.map((r) => (
              <a class="navlink" href={r.path} aria-current={r.path === route.path ? "page" : undefined} onClick={click(r.path)}>
                {r.path === route.path && <motion.span layoutId="side-active" class="nav-active" transition={SPRING} />}
                <r.Icon />
                {r.path === "/new" ? "New listing" : r.label}
                {badge(r)}
              </a>
            ))}
          </LayoutGroup>
          <div class="sidebar-foot">
            <span class="avatar" aria-hidden="true">
              {me.user.name.slice(0, 1).toUpperCase()}
            </span>
            <span>
              <span class="block font-semibold text-ink">{me.user.name}</span>
              {me.user.role === "owner" ? "Owner" : "Manager"}
            </span>
          </div>
        </aside>

        <AnimatePresence mode="wait" initial={false}>
          <motion.main class="main" key={route.path} variants={page} initial="initial" animate="enter" exit="exit">
            <route.View {...props} />
          </motion.main>
        </AnimatePresence>
      </div>

      <nav class="tabbar" aria-label="Sections">
        <LayoutGroup id="tabs">
          {ROUTES.filter((r) => r.tab).map((r) =>
            r.path === "/new" ? (
              <a class="tablink" href={r.path} aria-current={r.path === route.path ? "page" : undefined} onClick={click(r.path)} aria-label="New listing">
                <motion.span whileTap={{ scale: 0.9 }} class="-mt-1 grid size-11 place-items-center rounded-2xl bg-accent text-white" style={{ boxShadow: "0 10px 26px -8px var(--glow), inset 0 1px 0 rgba(255,255,255,.25)" }}>
                  <Icons.plus size={24} />
                </motion.span>
              </a>
            ) : (
              <a class="tablink" href={r.path} aria-current={r.path === route.path ? "page" : undefined} onClick={click(r.path)}>
                {r.path === route.path && <motion.span layoutId="tab-active" class="nav-active" transition={SPRING} />}
                <r.Icon />
                {r.label}
                {badge(r)}
              </a>
            ),
          )}
        </LayoutGroup>
      </nav>
    </MotionConfig>
  );
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
render(<App />, document.getElementById("app")!);

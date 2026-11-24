import { AnimatePresence, LayoutGroup, motion, MotionConfig } from "framer-motion";
import { render, type ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { api, SignedOut, type Me } from "./api";
import { SignedOutDoor } from "./doors";
import { Logo } from "./logo";
import { Messages } from "./messages";
import { Metrics } from "./metrics";
import { Bundles } from "./bundles";
import { NewListing } from "./wizard";
import { Offers } from "./offers";
import { Report } from "./report";
import { Activity, Inbox, Listings, Settings } from "./screens";
import { Icons, page, SPRING, useTabbarSync } from "./ui";
import "./style.css";

// Every destination, in the desktop's sidebar and in the phone's floating tab bar, which scrolls sideways with
// "New listing" pinned at its end.
const ROUTES = [
  { path: "/", label: "Inbox", Icon: Icons.inbox, View: Inbox },
  { path: "/offers", label: "Offers", Icon: Icons.tag, View: Offers },
  { path: "/messages", label: "Messages", Icon: Icons.message, View: Messages },
  { path: "/listings", label: "Listings", Icon: Icons.grid, View: Listings },
  { path: "/new", label: "Sell", Icon: Icons.plus, View: NewListing },
  { path: "/metrics", label: "Insights", Icon: Icons.chart, View: Metrics },
  { path: "/bundles", label: "Bundles", Icon: Icons.box, View: Bundles },
  { path: "/pulse", label: "Store Pulse", Icon: Icons.pulse, View: Report },
  { path: "/activity", label: "Activity", Icon: Icons.clock, View: Activity },
  { path: "/settings", label: "Settings", Icon: Icons.settings, View: Settings },
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

/** The phone bar's scrolling part: the current tab slides to the middle, and an edge fades while more lies past it. */
function TabStrip({ path, children }: { path: string; children: ComponentChildren }) {
  const ref = useRef<HTMLDivElement>(null);
  const placed = useRef(false);
  const edges = () => {
    const el = ref.current;
    if (!el) return;
    el.classList.toggle("more-left", el.scrollLeft > 4);
    el.classList.toggle("more-right", el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };
  useEffect(() => {
    const el = ref.current;
    const tab = el?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && tab) {
      const still = !placed.current || matchMedia("(prefers-reduced-motion: reduce)").matches;
      placed.current = true;
      el.scrollTo({ left: tab.offsetLeft - (el.clientWidth - tab.offsetWidth) / 2, behavior: still ? "auto" : "smooth" });
    }
    edges();
  }, [path]);
  useEffect(() => {
    addEventListener("resize", edges);
    return () => removeEventListener("resize", edges);
  }, []);
  return (
    <div class="tabstrip" ref={ref} onScroll={edges}>
      {children}
    </div>
  );
}

function App() {
  const [path, go] = usePath();
  const [me, setMe] = useState<Me | null>(null);
  const [signedOut, setSignedOut] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const tabbarRef = useTabbarSync();

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
    load();
  }, []);
  useEffect(() => {
    if (me) countWaiting();
  }, [me, path]);

  if (signedOut) return <SignedOutDoor />;
  if (!me) return <main class="door" aria-busy="true" />;

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

      <nav class="tabbar" ref={tabbarRef} aria-label="Sections">
        <TabStrip path={route.path}>
          <LayoutGroup id="tabs">
            {ROUTES.filter((r) => r.path !== "/new").map((r) => (
              <a key={r.path} class="tablink" href={r.path} aria-current={r.path === route.path ? "page" : undefined} onClick={click(r.path)}>
                {r.path === route.path && <motion.span layoutId="tab-active" class="nav-active" transition={SPRING} />}
                <r.Icon />
                {r.path === "/pulse" ? "Pulse" : r.label}
                {badge(r)}
              </a>
            ))}
          </LayoutGroup>
        </TabStrip>
        <a class="tabbar-new" href="/new" aria-current={route.path === "/new" ? "page" : undefined} onClick={click("/new")} aria-label="New listing">
          <motion.span whileTap={{ scale: 0.9 }} class="grid size-11 place-items-center rounded-2xl bg-accent text-white" style={{ boxShadow: "0 10px 26px -8px var(--glow), inset 0 1px 0 rgba(255,255,255,.25)" }}>
            <Icons.plus size={24} />
          </motion.span>
        </a>
      </nav>
    </MotionConfig>
  );
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");
render(<App />, document.getElementById("app")!);

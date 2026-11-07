// Sets who can sign in (docs/security.md). K runs this; the app itself can't add or change anyone.
//
//   node scripts/people.mjs sandbox add --email you@example.com --name K --role owner
//   node scripts/people.mjs sandbox new-code --email you@example.com     (a lost or new phone)
//   node scripts/people.mjs sandbox remove --email them@example.com
//   node scripts/people.mjs sandbox list
//   node scripts/people.mjs sandbox link                                 (the hidden sign-in address)
//   Production: $env:EBAY_CONFIRM_PRODUCTION='yes'; node scripts/people.mjs production add ...
//
// add and new-code make a fresh authenticator secret and show it ONCE in this terminal as a QR code (and as a
// setup key), for the person to scan into Google or Microsoft Authenticator. Any older code for them stops
// working. The list (PEOPLE) and the hidden sign-in address (SIGNIN_PATH) live in .dev.vars or .prod.vars
// (gitignored) and are uploaded to the environment's Key Vault, then the app is restarted. Pass --no-upload to
// only change the local file.
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseEnv } from "node:util";
import QRCode from "qrcode";
import { az, envArg, outputs } from "./azure-common.mjs";

const env = envArg();
const [, , , command, ...rest] = process.argv;
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const file = env === "production" ? ".prod.vars" : ".dev.vars";
const text = existsSync(file) ? readFileSync(file, "utf8") : "";
const vars = parseEnv(text);
let people = vars.PEOPLE ? JSON.parse(vars.PEOPLE) : [];
let signinPath = vars.SIGNIN_PATH;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32(bytes) {
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

const email = (flag("email") ?? "").trim().toLowerCase();
const needEmail = () => {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Give --email name@example.com");
};
function fail(msg) {
  console.error(msg);
  process.exit(2);
}

/** Writes PEOPLE and SIGNIN_PATH back into the vars file, keeping every other line as it was. */
function save() {
  let lines = text.split(/\r?\n/).filter((l) => !/^(PEOPLE|SIGNIN_PATH)=/.test(l));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  // Single quotes keep the JSON literal; names never contain one (replaced below).
  if (people.length) lines.push(`PEOPLE='${JSON.stringify(people)}'`);
  if (signinPath) lines.push(`SIGNIN_PATH=${signinPath}`);
  writeFileSync(file, lines.join("\n") + "\n");
}

function upload() {
  if (rest.includes("--no-upload")) {
    console.log(`\nSaved to ${file} only. Upload later with: node scripts/azure-secrets.mjs ${env}, then restart the app.`);
    return;
  }
  console.log(`\nUploading to the ${env} Key Vault...`);
  const r = spawnSync(process.execPath, ["scripts/azure-secrets.mjs", env], { stdio: "inherit", env: process.env });
  if (r.status !== 0) fail("Upload failed. The change is saved in " + file + "; run node scripts/azure-secrets.mjs " + env + " again.");
  const o = outputs(env);
  az(["functionapp", "restart", "-g", o.resourceGroup, "-n", o.functionAppName]);
  console.log("App restarted: the change is live.");
}

function signinUrl() {
  let base = "<the app's address>";
  try {
    base = outputs(env).publicUrl;
  } catch {}
  return `${base}/s/${signinPath}`;
}

async function showSecret(person) {
  const issuer = env === "production" ? "EBayManager" : "EBayManager Sandbox";
  const uri = `otpauth://totp/${encodeURIComponent(`${issuer}:${person.email}`)}?secret=${person.totp}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
  // A real image: terminal QR codes are often unscannable (fonts, line spacing, dark themes). It's written to
  // a private temporary folder, opened, and deleted as soon as Enter is pressed.
  const dir = mkdtempSync(join(tmpdir(), "ebm-qr-"));
  const png = join(dir, "authenticator-qr.png");
  try {
    await QRCode.toFile(png, uri, { width: 480, margin: 4, color: { dark: "#000000", light: "#ffffff" } });
    const open =
      process.platform === "win32" ? ["cmd", ["/c", "start", '""', `"${png}"`], { shell: true }] : [process.platform === "darwin" ? "open" : "xdg-open", [png], {}];
    spawnSync(open[0], open[1], { stdio: "ignore", ...open[2] });
    console.log(`\n${person.name} (${person.email}): scan the QR code that just opened with Google or Microsoft Authenticator.`);
    console.log(`(If it didn't open: ${png})`);
    console.log(`Or, in the app, choose "Enter a setup key", type of key "Time based", and enter:\n\n  ${person.totp}\n`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    await rl.question("Press Enter once it's added. The QR image is then deleted and won't be shown again. ");
    rl.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (command === "list") {
  if (!people.length) console.log(`Nobody is set up for ${env} yet.`);
  for (const p of people) console.log(`${p.role.padEnd(8)} ${p.name}  <${p.email}>`);
} else if (command === "link") {
  if (!signinPath) fail("No sign-in address yet: add someone first.");
  console.log(signinUrl());
} else if (command === "add" || command === "new-code") {
  needEmail();
  const existing = people.find((p) => p.email === email);
  if (command === "new-code" && !existing) fail(`${email} isn't set up. Use add.`);
  const name = (flag("name") ?? existing?.name ?? "").trim().replace(/'/g, "’").slice(0, 60);
  const role = flag("role") ?? existing?.role ?? "manager";
  if (!name) fail("Give --name");
  if (role !== "owner" && role !== "manager") fail("--role is owner or manager");
  const next = people.filter((p) => p.email !== email);
  if (next.length >= 3) fail("Three people at most.");
  if (role === "owner" && next.some((p) => p.role === "owner")) fail("There is already an owner.");
  if (role !== "owner" && !next.some((p) => p.role === "owner")) fail("Set up the owner first (--role owner).");
  const person = { email, name, role, totp: base32(randomBytes(20)) };
  people = [...next, person].sort((a, b) => (a.role === "owner" ? -1 : b.role === "owner" ? 1 : 0));
  signinPath ??= randomBytes(24).toString("base64url");
  save();
  await showSecret(person);
  upload();
  console.log(`\nSign-in page (bookmark it; send it to ${name} privately):\n  ${signinUrl()}`);
  console.log("Everything else on the site shows a blank page to anyone not signed in.");
} else if (command === "remove") {
  needEmail();
  const p = people.find((x) => x.email === email);
  if (!p) fail(`${email} isn't set up.`);
  if (p.role === "owner") fail("The owner can't be removed. Use new-code for a new phone.");
  people = people.filter((x) => x.email !== email);
  save();
  console.log(`${p.name} removed. Their sessions stop working once the app restarts.`);
  upload();
} else {
  fail("Commands: add, new-code, remove, list, link. See the top of scripts/people.mjs.");
}

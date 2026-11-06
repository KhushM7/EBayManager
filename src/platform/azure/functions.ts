import { app, output, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { handle, runScheduled } from "../../index";
import { runJob } from "../../background";
import { azureEnv } from "./env";

// The Azure Functions entry point (docs/azure-migration.md). Four functions:
// - app: every HTTP request (host.json routePrefix "" so this is the site root), adapted to the web-standard
//   Request/Response the app is written against. /admin and /runtime are the Functions host's own and never
//   reach the app; the host's admin endpoints are disabled in Bicep.
// - nightly (02:00 UTC) and poll (every 15 minutes): timer triggers; one instance at a time.
// - background: runs queued jobs (src/background.ts), one message at a time.

const jobsOut = output.storageQueue({ queueName: "jobs", connection: "JobsQueue" });

async function http(req: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const queued: { jobId: string }[] = [];
  const env = { ...azureEnv(), enqueue: (m: { jobId: string }) => void queued.push(m) };
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : new Uint8Array(await req.arrayBuffer());
  const request = new Request(req.url, { method: req.method, headers: req.headers, body });
  let res: Response;
  try {
    res = await handle(request, env);
  } catch (e) {
    context.error(`Unhandled error on ${req.method} ${new URL(req.url).pathname}: ${e instanceof Error ? e.message : String(e)}`);
    res = new Response("Something went wrong", { status: 500, headers: { "Content-Type": "text/plain" } });
  }
  if (queued.length) context.extraOutputs.set(jobsOut, queued);
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers[key] = value;
  });
  // Each Set-Cookie is passed separately, unchanged (the app never sets more than one per response).
  const cookies = res.headers.getSetCookie();
  if (cookies.length) headers["Set-Cookie"] = cookies[0];
  return { status: res.status, headers, body: new Uint8Array(await res.arrayBuffer()) };
}

app.http("app", {
  route: "{*path}",
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  authLevel: "anonymous",
  extraOutputs: [jobsOut],
  handler: http,
});

app.timer("nightly", {
  schedule: "0 0 2 * * *",
  handler: async (_t, context) => {
    const r = await runScheduled("nightly", azureEnv());
    context.log(`Nightly: ${JSON.stringify(r).slice(0, 2000)}`);
  },
});

app.timer("poll", {
  schedule: "0 */15 * * * *",
  handler: async (_t, context) => {
    const r = await runScheduled("poll", azureEnv());
    context.log(`Inbox poll: ${JSON.stringify(r).slice(0, 500)}`);
  },
});

app.storageQueue("background", {
  queueName: "jobs",
  connection: "JobsQueue",
  handler: async (message, context) => {
    const jobId = typeof message === "object" && message ? String((message as any).jobId ?? "") : "";
    if (!/^job_[\w-]{1,64}$/.test(jobId)) {
      context.warn("Ignored a queue message without a valid job id");
      return;
    }
    await runJob({ ...azureEnv() }, jobId);
  },
});

import type { Env } from "./env";
import { tools } from "./tools";

// Minimal stateless MCP server over Streamable HTTP (JSON responses only).
const PROTOCOL_VERSION = "2025-06-18";

type RpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: any };

const result = (id: RpcRequest["id"], r: unknown) => ({ jsonrpc: "2.0", id, result: r });
const error = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function handleRpc(env: Env, req: RpcRequest): Promise<object | null> {
  switch (req.method) {
    case "initialize":
      return result(req.id, {
        protocolVersion: req.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "ebay-autopilot", version: "0.1.0" },
        instructions:
          "K's eBay seller tools. Prices and buyer messages are never changed directly: use propose_* tools, which wait for K's approval.",
      });
    case "ping":
      return result(req.id, {});
    case "tools/list":
      return result(req.id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const tool = tools.find((t) => t.name === req.params?.name);
      if (!tool) return error(req.id, -32602, `Unknown tool ${req.params?.name}`);
      try {
        const out = await tool.run(env, req.params?.arguments ?? {});
        return result(req.id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return result(req.id, { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] });
      }
    }
    default:
      if (req.id === undefined) return null; // notification
      return error(req.id, -32601, `Method not found: ${req.method}`);
  }
}

export async function handleMcp(env: Env, request: Request): Promise<Response> {
  if (request.headers.get("Authorization") !== `Bearer ${env.MCP_TOKEN}`) return new Response("Unauthorized", { status: 401 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });

  const body = await request.json<RpcRequest | RpcRequest[]>();
  const batch = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(batch.map((r) => handleRpc(env, r)))).filter((r) => r !== null);
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}

import type { Env } from "./env";
import { tools } from "./tools";
import { rpc, rpcResponse, type RpcRequest } from "./mcp-core";

// K's own MCP endpoint (/mcp, Sandbox only): the full tool set over the minimal server in src/mcp-core.ts.
const SERVER = {
  name: "ebay-autopilot",
  instructions: "K's eBay seller tools. Nothing on eBay is ever changed directly: use the propose_* tools, which wait for K's approval.",
};

export const handleRpc = (env: Env, req: RpcRequest) => rpc(env, req, tools, SERVER);

export async function handleMcp(env: Env, request: Request): Promise<Response> {
  if (request.headers.get("Authorization") !== `Bearer ${env.MCP_TOKEN}`) return new Response("Unauthorized", { status: 401 });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  return rpcResponse(env, request, tools, SERVER);
}

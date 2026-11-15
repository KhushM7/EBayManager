import type { Env } from "./env";

// A minimal stateless MCP server over Streamable HTTP (JSON responses only), for whichever set of tools the
// caller gives it. It imports no tools itself: /mcp passes K's full set (src/mcp.ts) and the read-only API
// passes read-only ones (src/ro/handler.ts).
const PROTOCOL_VERSION = "2025-06-18";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (env: Env, args: any) => Promise<unknown>;
}

export type RpcRequest = { jsonrpc: "2.0"; id?: string | number; method: string; params?: any };

const result = (id: RpcRequest["id"], r: unknown) => ({ jsonrpc: "2.0", id, result: r });
const error = (id: RpcRequest["id"], code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

export async function rpc(env: Env, req: RpcRequest, tools: McpTool[], server: { name: string; instructions: string }): Promise<object | null> {
  switch (req.method) {
    case "initialize":
      return result(req.id, {
        protocolVersion: req.params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: "0.1.0" },
        instructions: server.instructions,
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

/** One POST body (a request or a batch) answered as MCP's JSON response. */
export async function rpcResponse(env: Env, request: Request, tools: McpTool[], server: { name: string; instructions: string }): Promise<Response> {
  let body: RpcRequest | RpcRequest[];
  try {
    body = (await request.json()) as RpcRequest | RpcRequest[];
  } catch {
    return Response.json(error(undefined, -32700, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(body) ? body : [body];
  const replies = (await Promise.all(batch.map((r) => rpc(env, r, tools, server)))).filter((r) => r !== null);
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? replies : replies[0]);
}

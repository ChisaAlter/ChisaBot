import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export type McpFixtureTool = Tool;
type ToolReply = string | CallToolResult["content"];
type ToolHandler = (args: Record<string, unknown>, signal: AbortSignal) => ToolReply | Promise<ToolReply>;

/** Fixed tool replies over the official MCP transport, bound to loopback by default. */
export class McpTestServer {
  private tools = new Map<string, Tool>();
  private handlers = new Map<string, ToolHandler>();
  private connections = new Set<Server>();
  private requests = new Set<AbortController>();
  private http?: ReturnType<typeof Bun.serve>;

  constructor(private options: { port?: number; hostname?: string } = {}) {}

  addTool(tool: Tool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  onToolCall(name: string, handler: ToolHandler): this {
    this.handlers.set(name, handler);
    return this;
  }

  async start(): Promise<string> {
    this.http = Bun.serve({
      hostname: this.options.hostname ?? "127.0.0.1",
      port: this.options.port ?? 0,
      fetch: async request => {
        if (new URL(request.url).pathname !== "/mcp") return new Response(null, { status: 404 });
        // Stateless transports are per HTTP request; shared state is only the fixture catalogue.
        const server = new Server({ name: "chisabot-test-tools", version: "1" }, { capabilities: { tools: {} } });
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
        const lifetime = new AbortController();
        server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...this.tools.values()] }));
        server.setRequestHandler(CallToolRequestSchema, async ({ params }, context) => {
          const handler = this.handlers.get(params.name);
          if (!this.tools.has(params.name) || !handler) throw new McpError(ErrorCode.InvalidParams, "Unknown tool");
          try {
            const reply = await handler(params.arguments ?? {}, AbortSignal.any([context.signal, request.signal, lifetime.signal]));
            return { content: typeof reply === "string" ? [{ type: "text", text: reply }] : reply };
          } catch (error) {
            return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
          }
        });
        this.connections.add(server);
        this.requests.add(lifetime);
        try {
          await server.connect(transport);
          return await transport.handleRequest(request);
        } finally {
          await server.close();
          this.connections.delete(server);
          this.requests.delete(lifetime);
        }
      },
    });
    return `${this.http.url.origin}/mcp`;
  }

  async stop(): Promise<void> {
    for (const request of this.requests) request.abort();
    await this.http?.stop(true);
    await Promise.all([...this.connections].map(server => server.close()));
    this.connections.clear();
    this.http = undefined;
  }
}

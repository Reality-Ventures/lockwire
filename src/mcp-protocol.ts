/**
 * The Model Context Protocol, as much of it as lockwire's server uses: JSON-RPC 2.0 over stdio, the
 * `initialize` handshake, `ping`, and tools and prompts (list, call, get). lockwire implements this
 * itself rather than depend on the MCP SDK, whose package also carries an HTTP stack, OAuth code and
 * demo servers that a stdio-only server never loads but every install downloads and every scanner
 * flags. The tests drive this server with the official SDK client, so it stays compatible with it.
 */
import { type Output, objectJson, parseObject, type Shape } from "./schema.js";

/** Protocol versions this server speaks, newest first. A client asking for another gets the newest. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
] as const;

type Id = string | number;

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * A message channel, in the shape MCP transports share: the server sets the callbacks, then calls
 * `start`. The SDK's own transports (its in-memory pair, used by the tests) fit it as they are.
 */
export interface Transport {
  start(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
}

export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

interface PromptResult {
  description?: string;
  messages: { role: "user" | "assistant"; content: { type: "text"; text: string } }[];
}

interface Tool {
  title: string;
  description: string;
  input: Shape;
  annotations: ToolAnnotations;
  // biome-ignore lint/suspicious/noExplicitAny: each tool's handler takes its own schema's output
  handler: (args: any) => Promise<ToolResult> | ToolResult;
}

interface Prompt {
  title: string;
  description: string;
  args: Shape;
  // biome-ignore lint/suspicious/noExplicitAny: each prompt's handler takes its own schema's output
  handler: (args: any) => Promise<PromptResult> | PromptResult;
}

export class McpServer {
  private readonly tools = new Map<string, Tool>();
  private readonly prompts = new Map<string, Prompt>();
  private transport: Transport | undefined;
  private clientInfo: { name?: string; version?: string } | undefined;

  constructor(
    private readonly info: { name: string; version: string },
    /** Told to the client at `initialize`, for its model to read; computed then, so it's current. */
    private readonly instructions?: () => string | undefined,
  ) {}

  /** The client's own name and version, from its `initialize` request. */
  getClientVersion(): { name?: string; version?: string } | undefined {
    return this.clientInfo;
  }

  registerTool<S extends Shape>(
    name: string,
    def: { title: string; description: string; inputSchema: S; annotations: ToolAnnotations },
    handler: (args: Output<S>) => Promise<ToolResult> | ToolResult,
  ): void {
    this.tools.set(name, {
      title: def.title,
      description: def.description,
      input: def.inputSchema,
      annotations: def.annotations,
      handler,
    });
  }

  registerPrompt<S extends Shape>(
    name: string,
    def: { title: string; description: string; argsSchema: S },
    handler: (args: Output<S>) => Promise<PromptResult> | PromptResult,
  ): void {
    this.prompts.set(name, {
      title: def.title,
      description: def.description,
      args: def.argsSchema,
      handler,
    });
  }

  async connect(transport: Transport): Promise<void> {
    this.transport = transport;
    transport.onmessage = (message) => {
      void this.receive(message);
    };
    await transport.start();
  }

  async close(): Promise<void> {
    await this.transport?.close();
  }

  private async receive(message: JsonRpcMessage): Promise<void> {
    // A response to a request (this server sends none) or a notification needs no answer.
    if (message.method === undefined || message.id === undefined || message.id === null) return;
    const id = message.id;
    try {
      const result = await this.handle(message.method, message.params ?? {});
      await this.transport?.send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      const code = err instanceof RpcError ? err.code : ErrorCode.InternalError;
      const text = err instanceof Error ? err.message : String(err);
      await this.transport?.send({ jsonrpc: "2.0", id, error: { code, message: text } });
    }
  }

  private async handle(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const asked = params.protocolVersion;
        const info = params.clientInfo;
        if (info && typeof info === "object") this.clientInfo = info as typeof this.clientInfo;
        let instructions: string | undefined;
        try {
          instructions = this.instructions?.();
        } catch {
          // instructions are a courtesy: never fail the handshake over them
        }
        return {
          ...(instructions ? { instructions } : {}),
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.find((v) => v === asked)
            ? asked
            : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
          serverInfo: this.info,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: [...this.tools].map(([name, t]) => ({
            name,
            title: t.title,
            description: t.description,
            inputSchema: objectJson(t.input),
            annotations: t.annotations,
          })),
        };
      case "tools/call":
        return this.callTool(params);
      case "prompts/list":
        return {
          prompts: [...this.prompts].map(([name, p]) => ({
            name,
            title: p.title,
            description: p.description,
            arguments: Object.entries(p.args).map(([arg, field]) => ({
              name: arg,
              required: field.required,
            })),
          })),
        };
      case "prompts/get": {
        const name = String(params.name);
        const prompt = this.prompts.get(name);
        if (!prompt) throw new RpcError(ErrorCode.InvalidParams, `Prompt ${name} not found`);
        const parsed = parseObject(prompt.args, params.arguments ?? {});
        if ("problem" in parsed)
          throw new RpcError(
            ErrorCode.InvalidParams,
            `Invalid arguments for prompt ${name}: ${parsed.problem}`,
          );
        return prompt.handler(parsed.value);
      }
      default:
        throw new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
    }
  }

  /** A tool's failures are results the model can read and act on, not protocol errors. */
  private async callTool(params: Record<string, unknown>): Promise<ToolResult> {
    const failed = (text: string): ToolResult => ({
      content: [{ type: "text", text }],
      isError: true,
    });
    const name = String(params.name);
    const tool = this.tools.get(name);
    if (!tool) return failed(`Tool ${name} not found`);
    const parsed = parseObject(tool.input, params.arguments ?? {});
    if ("problem" in parsed) return failed(`Invalid arguments for tool ${name}: ${parsed.problem}`);
    try {
      return await tool.handler(parsed.value);
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  }
}

/** Newline-delimited JSON-RPC on stdin and stdout, as MCP's stdio transport specifies. */
export class StdioServerTransport implements Transport {
  onmessage?: (message: JsonRpcMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private buffer = "";

  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout,
  ) {}

  async start(): Promise<void> {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
        const line = this.buffer.slice(0, nl).replace(/\r$/, "");
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim()) this.line(line);
      }
    });
    this.input.on("end", () => this.onclose?.());
    this.input.on("error", (err: Error) => this.onerror?.(err));
  }

  private line(line: string) {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      void this.send({
        jsonrpc: "2.0",
        id: null,
        error: { code: ErrorCode.ParseError, message: "Parse error" },
      });
      return;
    }
    // Batches went out of the protocol in 2025-06-18; an older client's batch is still answered.
    for (const m of Array.isArray(message) ? message : [message])
      if (m && typeof m === "object" && (m as JsonRpcMessage).jsonrpc === "2.0")
        this.onmessage?.(m as JsonRpcMessage);
  }

  send(message: JsonRpcMessage): Promise<void> {
    return new Promise((resolve) => {
      if (this.output.write(`${JSON.stringify(message)}\n`)) resolve();
      else this.output.once("drain", () => resolve());
    });
  }

  async close(): Promise<void> {
    this.input.removeAllListeners("data");
    this.onclose?.();
  }
}

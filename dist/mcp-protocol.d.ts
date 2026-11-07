/**
 * The Model Context Protocol, as much of it as lockwire's server uses: JSON-RPC 2.0 over stdio, the
 * `initialize` handshake, `ping`, and tools and prompts (list, call, get). lockwire implements this
 * itself rather than depend on the MCP SDK, whose package also carries an HTTP stack, OAuth code and
 * demo servers that a stdio-only server never loads but every install downloads and every scanner
 * flags. The tests drive this server with the official SDK client, so it stays compatible with it.
 */
import { z } from "zod";
/** Protocol versions this server speaks, newest first. A client asking for another gets the newest. */
export declare const SUPPORTED_PROTOCOL_VERSIONS: readonly ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07"];
type Id = string | number;
export interface JsonRpcMessage {
    jsonrpc: "2.0";
    id?: Id | null;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
    error?: {
        code: number;
        message: string;
        data?: unknown;
    };
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
export declare const ErrorCode: {
    readonly ParseError: -32700;
    readonly InvalidRequest: -32600;
    readonly MethodNotFound: -32601;
    readonly InvalidParams: -32602;
    readonly InternalError: -32603;
};
export interface ToolResult {
    content: {
        type: "text";
        text: string;
    }[];
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
    messages: {
        role: "user" | "assistant";
        content: {
            type: "text";
            text: string;
        };
    }[];
}
export declare class McpServer {
    private readonly info;
    /** Told to the client at `initialize`, for its model to read; computed then, so it's current. */
    private readonly instructions?;
    private readonly tools;
    private readonly prompts;
    private transport;
    private clientInfo;
    constructor(info: {
        name: string;
        version: string;
    }, 
    /** Told to the client at `initialize`, for its model to read; computed then, so it's current. */
    instructions?: (() => string | undefined) | undefined);
    /** The client's own name and version, from its `initialize` request. */
    getClientVersion(): {
        name?: string;
        version?: string;
    } | undefined;
    registerTool<S extends z.ZodRawShape>(name: string, def: {
        title: string;
        description: string;
        inputSchema: S;
        annotations: ToolAnnotations;
    }, handler: (args: z.output<z.ZodObject<S>>) => Promise<ToolResult> | ToolResult): void;
    registerPrompt<S extends z.ZodRawShape>(name: string, def: {
        title: string;
        description: string;
        argsSchema: S;
    }, handler: (args: z.output<z.ZodObject<S>>) => Promise<PromptResult> | PromptResult): void;
    connect(transport: Transport): Promise<void>;
    close(): Promise<void>;
    private receive;
    private handle;
    /** A tool's failures are results the model can read and act on, not protocol errors. */
    private callTool;
}
/** Newline-delimited JSON-RPC on stdin and stdout, as MCP's stdio transport specifies. */
export declare class StdioServerTransport implements Transport {
    private readonly input;
    private readonly output;
    onmessage?: (message: JsonRpcMessage) => void;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    private buffer;
    constructor(input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream);
    start(): Promise<void>;
    private line;
    send(message: JsonRpcMessage): Promise<void>;
    close(): Promise<void>;
}
export {};
//# sourceMappingURL=mcp-protocol.d.ts.map
/**
 * The Model Context Protocol, as much of it as lockwire's server uses: JSON-RPC 2.0 over stdio, the
 * `initialize` handshake, `ping`, and tools and prompts (list, call, get). lockwire implements this
 * itself rather than depend on the MCP SDK, whose package also carries an HTTP stack, OAuth code and
 * demo servers that a stdio-only server never loads but every install downloads and every scanner
 * flags. The tests drive this server with the official SDK client, so it stays compatible with it.
 */
import { objectJson, parseObject } from "./schema.js";
/** Protocol versions this server speaks, newest first. A client asking for another gets the newest. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
];
export const ErrorCode = {
    ParseError: -32700,
    InvalidRequest: -32600,
    MethodNotFound: -32601,
    InvalidParams: -32602,
    InternalError: -32603,
};
class RpcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
    }
}
export class McpServer {
    info;
    instructions;
    tools = new Map();
    prompts = new Map();
    transport;
    clientInfo;
    constructor(info, 
    /** Told to the client at `initialize`, for its model to read; computed then, so it's current. */
    instructions) {
        this.info = info;
        this.instructions = instructions;
    }
    /** The client's own name and version, from its `initialize` request. */
    getClientVersion() {
        return this.clientInfo;
    }
    registerTool(name, def, handler) {
        this.tools.set(name, {
            title: def.title,
            description: def.description,
            input: def.inputSchema,
            annotations: def.annotations,
            handler,
        });
    }
    registerPrompt(name, def, handler) {
        this.prompts.set(name, {
            title: def.title,
            description: def.description,
            args: def.argsSchema,
            handler,
        });
    }
    async connect(transport) {
        this.transport = transport;
        transport.onmessage = (message) => {
            void this.receive(message);
        };
        await transport.start();
    }
    async close() {
        await this.transport?.close();
    }
    async receive(message) {
        // A response to a request (this server sends none) or a notification needs no answer.
        if (message.method === undefined || message.id === undefined || message.id === null)
            return;
        const id = message.id;
        try {
            const result = await this.handle(message.method, message.params ?? {});
            await this.transport?.send({ jsonrpc: "2.0", id, result });
        }
        catch (err) {
            const code = err instanceof RpcError ? err.code : ErrorCode.InternalError;
            const text = err instanceof Error ? err.message : String(err);
            await this.transport?.send({ jsonrpc: "2.0", id, error: { code, message: text } });
        }
    }
    async handle(method, params) {
        switch (method) {
            case "initialize": {
                const asked = params.protocolVersion;
                const info = params.clientInfo;
                if (info && typeof info === "object")
                    this.clientInfo = info;
                let instructions;
                try {
                    instructions = this.instructions?.();
                }
                catch {
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
                if (!prompt)
                    throw new RpcError(ErrorCode.InvalidParams, `Prompt ${name} not found`);
                const parsed = parseObject(prompt.args, params.arguments ?? {});
                if ("problem" in parsed)
                    throw new RpcError(ErrorCode.InvalidParams, `Invalid arguments for prompt ${name}: ${parsed.problem}`);
                return prompt.handler(parsed.value);
            }
            default:
                throw new RpcError(ErrorCode.MethodNotFound, `Method not found: ${method}`);
        }
    }
    /** A tool's failures are results the model can read and act on, not protocol errors. */
    async callTool(params) {
        const failed = (text) => ({
            content: [{ type: "text", text }],
            isError: true,
        });
        const name = String(params.name);
        const tool = this.tools.get(name);
        if (!tool)
            return failed(`Tool ${name} not found`);
        const parsed = parseObject(tool.input, params.arguments ?? {});
        if ("problem" in parsed)
            return failed(`Invalid arguments for tool ${name}: ${parsed.problem}`);
        try {
            return await tool.handler(parsed.value);
        }
        catch (err) {
            return failed(err instanceof Error ? err.message : String(err));
        }
    }
}
/** Newline-delimited JSON-RPC on stdin and stdout, as MCP's stdio transport specifies. */
export class StdioServerTransport {
    input;
    output;
    onmessage;
    onclose;
    onerror;
    buffer = "";
    constructor(input = process.stdin, output = process.stdout) {
        this.input = input;
        this.output = output;
    }
    async start() {
        this.input.setEncoding("utf8");
        this.input.on("data", (chunk) => {
            this.buffer += chunk;
            for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
                const line = this.buffer.slice(0, nl).replace(/\r$/, "");
                this.buffer = this.buffer.slice(nl + 1);
                if (line.trim())
                    this.line(line);
            }
        });
        this.input.on("end", () => this.onclose?.());
        this.input.on("error", (err) => this.onerror?.(err));
    }
    line(line) {
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            void this.send({
                jsonrpc: "2.0",
                id: null,
                error: { code: ErrorCode.ParseError, message: "Parse error" },
            });
            return;
        }
        // Batches went out of the protocol in 2025-06-18; an older client's batch is still answered.
        for (const m of Array.isArray(message) ? message : [message])
            if (m && typeof m === "object" && m.jsonrpc === "2.0")
                this.onmessage?.(m);
    }
    send(message) {
        return new Promise((resolve) => {
            if (this.output.write(`${JSON.stringify(message)}\n`))
                resolve();
            else
                this.output.once("drain", () => resolve());
        });
    }
    async close() {
        this.input.removeAllListeners("data");
        this.onclose?.();
    }
}
//# sourceMappingURL=mcp-protocol.js.map
/**
 * The Model Context Protocol, as much of it as lockwire's server uses: JSON-RPC 2.0 over stdio, the
 * `initialize` handshake, `ping`, and tools and prompts (list, call, get). lockwire implements this
 * itself rather than depend on the MCP SDK, whose package also carries an HTTP stack, OAuth code and
 * demo servers that a stdio-only server never loads but every install downloads and every scanner
 * flags. The tests drive this server with the official SDK client, so it stays compatible with it.
 */
import { z } from "zod";
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
/** A schema's JSON Schema, as a tool listing shows it to the model. */
const jsonSchema = (schema) => z.toJSONSchema(schema, { target: "draft-7", io: "input" });
/** zod's issues as one line: `Invalid input: expected string, received number at path`. */
const issuesText = (error) => error.issues
    .map((i) => `${i.message}${i.path.length ? ` at ${i.path.join(".")}` : ""}`)
    .join("; ");
export class McpServer {
    info;
    tools = new Map();
    prompts = new Map();
    transport;
    clientInfo;
    constructor(info) {
        this.info = info;
    }
    /** The client's own name and version, from its `initialize` request. */
    getClientVersion() {
        return this.clientInfo;
    }
    registerTool(name, def, handler) {
        this.tools.set(name, {
            title: def.title,
            description: def.description,
            input: z.object(def.inputSchema),
            annotations: def.annotations,
            handler,
        });
    }
    registerPrompt(name, def, handler) {
        this.prompts.set(name, {
            title: def.title,
            description: def.description,
            args: z.object(def.argsSchema),
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
                return {
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
                        inputSchema: jsonSchema(t.input),
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
                        arguments: Object.entries(p.args.shape).map(([arg, schema]) => ({
                            name: arg,
                            required: !schema.safeParse(undefined).success,
                        })),
                    })),
                };
            case "prompts/get": {
                const name = String(params.name);
                const prompt = this.prompts.get(name);
                if (!prompt)
                    throw new RpcError(ErrorCode.InvalidParams, `Prompt ${name} not found`);
                const parsed = prompt.args.safeParse(params.arguments ?? {});
                if (!parsed.success)
                    throw new RpcError(ErrorCode.InvalidParams, `Invalid arguments for prompt ${name}: ${issuesText(parsed.error)}`);
                return prompt.handler(parsed.data);
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
        const parsed = tool.input.safeParse(params.arguments ?? {});
        if (!parsed.success)
            return failed(`Invalid arguments for tool ${name}: ${issuesText(parsed.error)}`);
        try {
            return await tool.handler(parsed.data);
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
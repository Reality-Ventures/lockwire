import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
/** Builds the configured server without connecting a transport -- split out from startMcpServer so tests can drive it over an in-memory transport instead of real stdio. */
export declare function createServer(repoRoot: string): McpServer;
export declare function startMcpServer(repoRoot: string): Promise<void>;
//# sourceMappingURL=mcp-server.d.ts.map
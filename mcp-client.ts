// ─────────────────────────────────────────────────────────────────
//  mcp-client.ts — MCP client service for parallax-cli
//
//  Abstracts all Model Context Protocol SDK interactions:
//   • Connect to local MCP servers via stdio transport
//   • Discover tools dynamically via listTools()
//   • Execute MCP tools via callTool()
//   • Map MCP tool schemas → OpenAI-compatible tool definitions
//
//  This module is imported by agent.ts. It never touches the UI
//  directly — it emits status strings via callbacks instead.
// ─────────────────────────────────────────────────────────────────

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ── Types ──────────────────────────────────────────────────────

/** Configuration for a single MCP server to connect to. */
export interface MCPServerConfig {
    /** Human-readable name used for logging and tool prefixing. */
    name: string;
    /** The executable to spawn (e.g. "npx", "node", "python"). */
    command: string;
    /** Arguments passed to the command. */
    args?: string[];
    /** Environment variables for the child process. */
    env?: Record<string, string>;
    /** Working directory for the child process. */
    cwd?: string;
}

/** A tool definition in the OpenAI function-calling format. */
export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
}

/** A live connection to an MCP server. */
export interface MCPConnection {
    /** The server config used to establish this connection. */
    config: MCPServerConfig;
    /** The SDK client instance. */
    client: Client;
    /** The stdio transport. */
    transport: StdioClientTransport;
    /** Tool definitions discovered from this server, already in OpenAI format. */
    tools: ToolDefinition[];
    /** Map from prefixed tool name → original MCP tool name. */
    toolNameMap: Map<string, string>;
}

// ── Connection ─────────────────────────────────────────────────

/**
 * Connect to a local MCP server via stdio, discover its tools,
 * and return a ready-to-use MCPConnection.
 *
 * @param config  - Server configuration (command, args, etc.)
 * @param onStatus - Optional callback for status updates (for UI)
 */
export async function connectToServer(
    config: MCPServerConfig,
    onStatus?: (message: string) => void,
): Promise<MCPConnection> {
    const status = onStatus ?? (() => { });

    // ── 1. Create transport ──────────────────────────────────────
    status(`connecting to ${config.name}`);

    const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        cwd: config.cwd,
        stderr: "pipe", // capture stderr, don't bleed to parent
    });

    // ── 2. Create client and connect ─────────────────────────────
    const client = new Client(
        { name: "parallax-cli", version: "1.0.0" },
        { capabilities: {} },
    );

    await client.connect(transport);

    status(`connected to ${config.name}`);

    // ── 3. Discover tools ────────────────────────────────────────
    status(`discovering tools on ${config.name}`);

    const result = await client.listTools();
    const prefix = `mcp_${sanitizeName(config.name)}_`;
    const toolNameMap = new Map<string, string>();

    const tools: ToolDefinition[] = result.tools.map((mcpTool) => {
        const prefixedName = `${prefix}${mcpTool.name}`;
        toolNameMap.set(prefixedName, mcpTool.name);

        return {
            type: "function" as const,
            function: {
                name: prefixedName,
                description: mcpTool.description ?? "",
                parameters: {
                    type: "object" as const,
                    properties: mcpTool.inputSchema.properties ?? {},
                    required: mcpTool.inputSchema.required,
                },
            },
        };
    });

    status(`discovered ${tools.length} tools on ${config.name}`);

    return { config, client, transport, tools, toolNameMap };
}

// ── Tool Execution ─────────────────────────────────────────────

/**
 * Execute an MCP tool via the connected client.
 *
 * @param connection - The live MCP connection
 * @param prefixedName - The prefixed tool name (as sent to the LLM)
 * @param args - Arguments object to pass to the tool
 * @returns The tool result as a plain string
 */
export async function callMCPTool(
    connection: MCPConnection,
    prefixedName: string,
    args: Record<string, unknown>,
): Promise<string> {
    // Resolve the original MCP tool name from the prefixed version
    const originalName = connection.toolNameMap.get(prefixedName);

    if (!originalName) {
        return `error: unknown mcp tool "${prefixedName}"`;
    }

    try {
        const result = await connection.client.callTool({
            name: originalName,
            arguments: args,
        });

        // Extract text content from the MCP result.
        // MCP returns an array of content blocks — we concatenate
        // all text blocks into a single string.
        if ("content" in result && Array.isArray(result.content)) {
            const textParts = result.content
                .filter((c: any) => c.type === "text")
                .map((c: any) => c.text as string);

            if (textParts.length > 0) {
                return textParts.join("\n");
            }

            return "(tool returned no text content)";
        }

        // Fallback: stringify the whole result
        return JSON.stringify(result);
    } catch (err: any) {
        return `error executing mcp tool: ${err.message}`;
    }
}

// ── Disconnection ──────────────────────────────────────────────

/**
 * Cleanly disconnect from an MCP server.
 */
export async function disconnectServer(
    connection: MCPConnection,
): Promise<void> {
    try {
        await connection.transport.close();
    } catch {
        // Swallow close errors — the process may already be gone
    }
}

// ── Helpers ────────────────────────────────────────────────────

/**
 * Sanitize a server name for use as a tool name prefix.
 * Strips non-alphanumeric chars and lowercases.
 */
function sanitizeName(name: string): string {
    return name.toLowerCase().replace(/[^a-z0-9]/g, "_");
}

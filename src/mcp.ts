import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "fs";
import path from "path";
import os from "os";
import type { ToolSet, ToolDefinition } from "./agent/types.js";

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

const CONFIG_PATH = path.join(os.homedir(), ".parallax", "mcp-config.json");

export async function loadMcpTools(): Promise<ToolSet> {
  if (!fs.existsSync(CONFIG_PATH)) {
    return {};
  }

  try {
    const config: McpConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    const allMcpTools: ToolSet = {};

    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      try {
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args || [],
          env: { ...process.env, ...(serverConfig.env || {}) } as any,
        });

        const client = new Client(
          {
            name: "parallax-client",
            version: "1.0.0",
          },
          {
            capabilities: {},
          }
        );

        await client.connect(transport);

        const { tools } = await client.listTools();

        for (const tool of tools) {
          const toolName = `${serverName}_${tool.name}`;
          allMcpTools[toolName] = {
            description: tool.description || "",
            parameters: tool.inputSchema,
            execute: async (args: any) => {
              const result = await client.callTool({
                name: tool.name,
                arguments: args,
              });
              return result;
            },
          };
        }
      } catch (err) {
        console.error(`Failed to connect to MCP server ${serverName}:`, err);
      }
    }

    return allMcpTools;
  } catch (err) {
    console.error("Failed to load MCP config:", err);
    return {};
  }
}

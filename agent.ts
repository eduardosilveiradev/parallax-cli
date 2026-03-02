// ─────────────────────────────────────────────────────────────────
//  agent.ts — Core orchestration engine for parallax-cli
//
//  Implements a Manager/Router pattern:
//   1. Accept user prompt + system context
//   2. Stream via the active Provider (Ollama, OpenAI, etc.)
//   3. If the LLM emits a tool call → pause, execute, append result, re-trigger
//   4. Yield typed AgentEvents at every state transition so the Ink UI
//      can render progress without blocking
//
//  All public surface area uses strict TypeScript types.
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import fsSync, { writeFileSync } from "node:fs";
import { exec } from "node:child_process";
import { type MCPConnection, type ToolDefinition as MCPToolDef, callMCPTool } from "./mcp-client.js";
import {
    type ChatMessage,
    type ToolCall,
    type ToolDefinition,
    type StreamChunk,
    type TokenUsage,
    getProvider,
    DEFAULT_PROVIDER,
} from "./providers.js";

export type { ChatMessage };
export { DEFAULT_PROVIDER };

// Re-export the default model (from env, used as initial state in UI)
export const DEFAULT_MODEL = process.env["OLLAMA_MODEL"] ?? "cogito:14b";

// ── Event types (consumed by the Ink UI) ───────────────────────
//
// The UI subscribes to an async iterable of AgentEvent.
// Each event describes exactly what the engine is doing so the
// grayscale interface can render status text, tool badges, and
// streamed output without polling.

export type AgentEvent =
    | { type: "status"; message: string }
    | { type: "mcp_status"; message: string }
    | { type: "token"; content: string }
    | { type: "tool_start"; name: string; args: Record<string, unknown> }
    | { type: "tool_result"; name: string; result: string }
    | { type: "usage"; usage: TokenUsage }
    | { type: "error"; message: string }
    | { type: "done"; fullResponse: string; messages: ChatMessage[] };

// ── Tool definitions (OpenAI function-calling format) ───────────
//
// These definitions are sent to the LLM alongside every request
// so it understands which tools are available and their schemas.

const TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        type: "function",
        function: {
            name: "readLocalFile",
            description:
                "Read the full contents of a file on the local filesystem. " +
                "Returns the file content as a UTF-8 string.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute or relative path to the target file.",
                    },
                },
                required: ["path"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "patchLocalFile",
            description:
                "Apply a unified diff or a full replacement to a local file. " +
                "Supports creating new files when the target does not exist.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute or relative path to the target file.",
                    },
                    diff: {
                        type: "string",
                        description:
                            "A unified diff string or the full replacement content " +
                            "for the file.",
                    },
                },
                required: ["path", "diff"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "executeTerminalCommand",
            description:
                "Execute a shell command on the local machine and return " +
                "combined stdout + stderr output.",
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "The shell command to execute.",
                    },
                },
                required: ["command"],
            },
        },
    }
];

// ── Tool implementations (placeholders) ────────────────────────
//
// Each function returns a string result that gets appended to
// the message history as a tool-role message. Swap these out
// with real implementations as the CLI matures.

async function readLocalFile(path: string): Promise<string> {
    try {
        const content = await fs.readFile(path, "utf-8");
        return content;
    } catch (err: any) {
        return `error: could not read file — ${err.message}`;
    }
}

async function patchLocalFile(path: string, diff: string): Promise<string> {
    // Placeholder: writes `diff` as full replacement content.
    // Future: parse unified diffs and apply them structurally.
    try {
        await fs.writeFile(path, diff, "utf-8");
        return `success: wrote ${diff.length} bytes to ${path}`;
    } catch (err: any) {
        return `error: could not write file — ${err.message}`;
    }
}

function executeTerminalCommand(command: string): Promise<string> {
    return new Promise((resolve) => {
        exec(command, { timeout: 30_000 }, (err, stdout, stderr) => {
            if (err) {
                resolve(`exit ${err.code ?? 1}\n${stderr}\n${stdout}`.trim());
            } else {
                resolve(stdout.trim() || stderr.trim() || "(no output)");
            }
        });
    });
}

async function executeRemoteVPS(
    command: string,
    host: string,
): Promise<string> {
    // Delegates to local SSH. Requires the host to exist in
    // ~/.ssh/config or be a valid address with key-based auth.
    return executeTerminalCommand(`ssh ${host} '${command}'`);
}

// ── Tool dispatcher ────────────────────────────────────────────
//
// Maps a tool name from the LLM response to its implementation.
// Returns a result string ready to inject back into the history.

async function dispatchTool(
    name: string,
    args: Record<string, unknown>,
): Promise<string> {
    switch (name) {
        case "readLocalFile":
            return readLocalFile(args["path"] as string);

        case "patchLocalFile":
            return patchLocalFile(args["path"] as string, args["diff"] as string);

        case "executeTerminalCommand":
            return executeTerminalCommand(args["command"] as string);

        case "executeRemoteVPS":
            return executeRemoteVPS(
                args["command"] as string,
                args["host"] as string,
            );

        default:
            return `error: unknown tool "${name}"`;
    }
}

// ── MCP tool dispatcher ────────────────────────────────────────
//
// Routes a prefixed MCP tool name (e.g. "mcp_filesystem_readFile")
// to the correct MCPConnection and executes via callMCPTool().

async function dispatchMCPTool(
    prefixedName: string,
    args: Record<string, unknown>,
    connections: MCPConnection[],
): Promise<string> {
    for (const conn of connections) {
        if (conn.toolNameMap.has(prefixedName)) {
            return callMCPTool(conn, prefixedName, args);
        }
    }
    return `error: no mcp connection owns tool "${prefixedName}"`;
}



// ── System prompt ──────────────────────────────────────────────

/** Try to read PARALLAX.md from the working directory (best-effort). */
function readParallaxMd(): string | null {
    try {
        return fsSync.readFileSync("PARALLAX.md", "utf-8");
    } catch {
        return null;
    }
}

function buildSystemPrompt(): string {
    let prompt = `You are Parallax, a concise and precise AI agentic code assistant running inside a terminal.

Reply directly to the user in plain text. Be conversational for casual messages.

You have tools available, but only use them when the user explicitly asks you to read files, write code, run commands, or interact with a server. Never use tools unprompted. For general questions, chat normally without calling any tools.

Keep responses short and direct. Use code blocks for code.

You are in an agentic loop. You will be given a task, and you will need to use your tools to complete it. You may be given multiple tasks, and you may need to use your tools multiple times to complete them. You should not greet the user, re-introduce yourself, or restart the conversation when you receive a tool result. Instead, continue your original task: interpret the result, and either call another tool or respond to the user with your final answer.

## Tool-calling protocol

You can call tools by emitting a tool_call in your response. After you call a tool, the SYSTEM will execute it and inject the result into the conversation as a message with role "tool". These tool-result messages are NOT from the user — they are automatic system responses containing the output of the tool you invoked. You must NEVER treat tool-result messages as new user requests. Do not greet the user, re-introduce yourself, or restart the conversation when you receive a tool result. Instead, continue your original task: interpret the result, and either call another tool or respond to the user with your final answer.

In summary:
- Messages with role "user" = the human you are talking to.
- Messages with role "tool" = system-injected outputs from tools YOU called. Not from the user.
- After receiving a tool result, continue working — do not treat it as a new conversation turn.

## Information
You are running on ${process.platform} ${process.arch}
The current date is ${new Date().toLocaleString()}
The CWD is ${process.cwd()}

## CRITICAL: Filesystem tool rules
- NEVER use directory_tree or any recursive directory listing tool. It will dump hundreds of thousands of tokens and destroy the context window.
- Use list_directory on specific paths instead. Only list the directories you actually need.
- You can also use list_allowed_directories to see where you are allowed to be/your CWD.
- NEVER list node_modules, .git, dist, build, or other generated directories.
- When exploring a project, start with the root directory only (depth 1), then drill into specific subdirectories as needed.`;

    const parallaxMd = readParallaxMd();
    if (parallaxMd) {
        prompt += `\n\n## Project Context (from PARALLAX.md)\n\n${parallaxMd}`;
    }

    return prompt;
}

// ── Agent orchestration loop ───────────────────────────────────
//
// This is the main entry point. It accepts a user prompt, builds
// the message history, and runs an agentic loop:
//
//   1. Stream LLM response tokens → yield them as AgentEvents
//   2. If the LLM emits tool_calls → pause streaming, execute
//      each tool, append results, and re-trigger the LLM
//   3. When the LLM finishes without tool calls → yield "done"
//
// The loop has a hard cap of MAX_ITERATIONS to prevent runaways.

const MAX_TOOL_ITERATIONS = 10;

export async function* runAgent(
    prompt: string,
    history: ChatMessage[] = [],
    mcpConnections: MCPConnection[] = [],
    model: string = DEFAULT_MODEL,
    providerName: string = DEFAULT_PROVIDER,
): AsyncGenerator<AgentEvent> {

    // ── Resolve the provider ────────────────────────────────────
    const provider = getProvider(providerName);

    // ── Collect all tool definitions ────────────────────────────
    // When MCP connections are available, prefer MCP tools over the
    // built-in readLocalFile/patchLocalFile (which are basic fallbacks).
    // Also filter out directory_tree — it recurses into node_modules
    // and can dump 300k+ tokens, destroying the context window.
    const BLOCKED_MCP_TOOLS = ["directory_tree"];
    const mcpTools: MCPToolDef[] = mcpConnections.flatMap((c) => c.tools)
        .filter((t) => !BLOCKED_MCP_TOOLS.some((b) => t.function.name.includes(b)));
    const builtinTools = mcpConnections.length > 0
        ? TOOL_DEFINITIONS.filter(
            (t) => !["readLocalFile", "patchLocalFile"].includes(t.function.name),
        )
        : TOOL_DEFINITIONS;
    const allTools: ToolDefinition[] = [...builtinTools, ...mcpTools];

    // ── Build the initial message history ──────────────────────
    const messages: ChatMessage[] = [
        { role: "system", content: buildSystemPrompt() },
        ...history,
        { role: "user", content: prompt },
    ];


    // DEBUG: dump history
    // writeFileSync("history.json", JSON.stringify(messages, null, 2));

    yield { type: "status", message: "Working..." };

    // ── Agentic loop ───────────────────────────────────────────
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        let fullContent = "";
        let toolCalls: ToolCall[] = [];

        // Stream via the provider
        for await (const chunk of provider.stream(messages, model, allTools)) {
            // Accumulate text tokens
            if (chunk.content) {
                fullContent += chunk.content;
                yield { type: "token", content: chunk.content };
            }

            // Accumulate tool calls (may arrive across multiple chunks)
            if (chunk.tool_calls) {
                toolCalls.push(...chunk.tool_calls);
            }

            // Forward token usage stats
            if (chunk.usage) {
                yield { type: "usage", usage: chunk.usage };
            }
        }

        // ── No tool calls → we're done ───────────────────────────
        if (toolCalls.length === 0) {
            messages.push({ role: "assistant", content: fullContent });
            // Return messages without the system prompt (index 0)
            yield { type: "done", fullResponse: fullContent, messages: messages.slice(1) };
            return;
        }

        // ── Tool calls detected → execute each one ───────────────
        //
        // Append the assistant message (with tool_calls) to history,
        // then execute each tool and append its result.

        messages.push({
            role: "assistant",
            content: fullContent,
            tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
            // Ollama sends arguments as an object; OpenAI sends as a JSON string
            let args: Record<string, unknown>;
            const rawArgs = call.function.arguments;
            if (typeof rawArgs === "object" && rawArgs !== null) {
                args = rawArgs;
            } else if (typeof rawArgs === "string") {
                try {
                    args = JSON.parse(rawArgs);
                } catch {
                    args = {};
                }
            } else {
                args = {};
            }

            yield {
                type: "tool_start",
                name: call.function.name,
                args,
            };

            // Determine if this is an MCP tool (prefixed with mcp_)
            const isMCP = call.function.name.startsWith("mcp_");

            yield {
                type: isMCP ? "mcp_status" : "status",
                message: `executing ${call.function.name}`,
            };

            const result = isMCP
                ? await dispatchMCPTool(call.function.name, args, mcpConnections)
                : await dispatchTool(call.function.name, args);

            // Format the result for display (pass diffs as-is with marker, truncate others)
            let displayResult: string;
            const isDiff = result.includes("---") && result.includes("+++") && result.includes("@@");
            if (isDiff) {
                // Pass raw diff with a marker so the UI can render it natively
                displayResult = "__DIFF__" + result;
            } else {
                displayResult = result.length > 200
                    ? result.slice(0, 200) + "… (truncated)"
                    : result;
            }

            yield {
                type: "tool_result",
                name: call.function.name,
                result: displayResult,
            };

            // Append tool result to history so the LLM can see it
            messages.push({
                role: "tool",
                content: result,
                tool_call_id: call.id,
            });
        }

        // Re-trigger the LLM with the updated history
        yield { type: "status", message: "Working..." };
    }

    // Safety: we hit the iteration cap
    yield {
        type: "error",
        message: `hit tool iteration limit (${MAX_TOOL_ITERATIONS})`,
    };
    yield { type: "done", fullResponse: "", messages: messages.slice(1) };
}

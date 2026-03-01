// ─────────────────────────────────────────────────────────────────
//  agent.ts — Core orchestration engine for parallax-cli
//
//  Implements a Manager/Router pattern:
//   1. Accept user prompt + system context
//   2. Stream the prompt to the LLM (Ollama, OpenAI-compatible)
//   3. If the LLM emits a tool call → pause, execute, append result, re-trigger
//   4. Yield typed AgentEvents at every state transition so the Ink UI
//      can render progress without blocking
//
//  All public surface area uses strict TypeScript types.
//  Tool implementations are mocked as placeholders for future work.
// ─────────────────────────────────────────────────────────────────

import http from "node:http";
import fs from "node:fs/promises";
import { exec } from "node:child_process";
import { type MCPConnection, type ToolDefinition as MCPToolDef, callMCPTool } from "./mcp-client.js";

// ── Config ─────────────────────────────────────────────────────

const OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "localhost";
const OLLAMA_PORT = parseInt(process.env["OLLAMA_PORT"] ?? "11434", 10);
const MODEL = process.env["OLLAMA_MODEL"] ?? "cogito:14b";

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
    | { type: "error"; message: string }
    | { type: "done"; fullResponse: string };

// ── Message types (OpenAI-compatible chat format) ──────────────

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
}

interface ToolCall {
    id?: string;
    type?: "function";
    function: {
        name: string;
        arguments: Record<string, unknown> | string; // Ollama sends object, OpenAI sends JSON string
    };
}

// ── Tool schema (OpenAI function-calling format) ───────────────
//
// These definitions are sent to the LLM alongside every request
// so it understands which tools are available and their schemas.

interface ToolParameter {
    type: string;
    description: string;
}

interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, ToolParameter>;
            required: string[];
        };
    };
}

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
    },
    {
        type: "function",
        function: {
            name: "executeRemoteVPS",
            description:
                "Execute a command on a remote VPS host via SSH. " +
                "Requires the host to be pre-configured in SSH config.",
            parameters: {
                type: "object",
                properties: {
                    command: {
                        type: "string",
                        description: "The shell command to execute on the remote host.",
                    },
                    host: {
                        type: "string",
                        description:
                            "SSH host alias or address (e.g. 'prod-1', '10.0.0.5').",
                    },
                },
                required: ["command", "host"],
            },
        },
    },
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

// ── LLM streaming transport (node:http) ────────────────────────
//
// Low-level helper that POSTs to Ollama's /api/chat with
// streaming enabled and yields each parsed NDJSON chunk.
// This is separated from the orchestration logic so the
// transport layer can be swapped for OpenAI, Anthropic, etc.

interface OllamaStreamChunk {
    message?: { role?: string; content?: string; tool_calls?: ToolCall[] };
    done: boolean;
}

function streamLLM(
    messages: ChatMessage[],
    extraTools: MCPToolDef[] = [],
): AsyncIterable<OllamaStreamChunk> {
    const allTools = [...TOOL_DEFINITIONS, ...extraTools];
    const payload = JSON.stringify({
        model: MODEL,
        messages,
        tools: allTools.length > 0 ? allTools : undefined,
        stream: true,
    });

    // We return an async iterable backed by a promise-based queue
    // so consumers can `for await` over chunks as they arrive.
    return {
        [Symbol.asyncIterator]() {
            // Buffered queue: resolvers waiting for the next chunk
            const queue: OllamaStreamChunk[] = [];
            let resolve: ((value: IteratorResult<OllamaStreamChunk>) => void) | null =
                null;
            let finished = false;

            function push(chunk: OllamaStreamChunk) {
                if (resolve) {
                    const r = resolve;
                    resolve = null;
                    r({ value: chunk, done: false });
                } else {
                    queue.push(chunk);
                }
            }

            function end() {
                finished = true;
                if (resolve) {
                    const r = resolve;
                    resolve = null;
                    r({ value: undefined as any, done: true });
                }
            }

            // Fire the HTTP request
            const req = http.request(
                {
                    hostname: OLLAMA_HOST,
                    port: OLLAMA_PORT,
                    path: "/api/chat",
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Content-Length": Buffer.byteLength(payload),
                    },
                },
                (res) => {
                    if (res.statusCode !== 200) {
                        let body = "";
                        res.on("data", (c) => (body += c));
                        res.on("end", () => {
                            push({
                                message: {
                                    content: `[ollama error ${res.statusCode}] ${body}`,
                                },
                                done: true,
                            });
                            end();
                        });
                        return;
                    }

                    let buffer = "";

                    res.on("data", (chunk: Buffer) => {
                        buffer += chunk.toString();
                        const lines = buffer.split("\n");
                        buffer = lines.pop() ?? "";

                        for (const line of lines) {
                            if (!line.trim()) continue;
                            try {
                                const json: OllamaStreamChunk = JSON.parse(line);
                                push(json);
                                if (json.done) {
                                    end();
                                    return;
                                }
                            } catch {
                                // skip malformed NDJSON
                            }
                        }
                    });

                    res.on("end", () => end());
                    res.on("error", () => end());
                },
            );

            req.on("error", (err: NodeJS.ErrnoException) => {
                const msg =
                    err.code === "ECONNREFUSED"
                        ? "cannot connect to ollama — is it running?"
                        : `connection error: ${err.message}`;
                push({ message: { content: `[error] ${msg}` }, done: true });
                end();
            });

            req.write(payload);
            req.end();

            // Async iterator protocol
            return {
                next(): Promise<IteratorResult<OllamaStreamChunk>> {
                    if (queue.length > 0) {
                        return Promise.resolve({ value: queue.shift()!, done: false });
                    }
                    if (finished) {
                        return Promise.resolve({
                            value: undefined as any,
                            done: true,
                        });
                    }
                    return new Promise((r) => {
                        resolve = r;
                    });
                },
            };
        },
    };
}

// ── System prompt ──────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Parallax, a concise and precise AI assistant running inside a terminal.

Reply directly to the user in plain text. Be conversational for casual messages.

You have tools available, but only use them when the user explicitly asks you to read files, write code, run commands, or interact with a server. Never use tools unprompted. For general questions, chat normally without calling any tools.

Keep responses short and direct. Use code blocks for code.

The current date is ${new Date().toLocaleString()}`;

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
): AsyncGenerator<AgentEvent> {
    // ── Collect all MCP tool definitions ──────────────────────
    const mcpTools: MCPToolDef[] = mcpConnections.flatMap((c) => c.tools);

    // ── Build the initial message history ──────────────────────
    const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: prompt },
    ];

    yield { type: "status", message: "reasoning" };

    // ── Agentic loop ───────────────────────────────────────────
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        let fullContent = "";
        let toolCalls: ToolCall[] = [];

        // Stream tokens from the LLM (native + MCP tools)
        for await (const chunk of streamLLM(messages, mcpTools)) {
            // Accumulate text tokens
            if (chunk.message?.content) {
                fullContent += chunk.message.content;
                yield { type: "token", content: chunk.message.content };
            }

            // Accumulate tool calls (may arrive across multiple chunks)
            if (chunk.message?.tool_calls) {
                toolCalls.push(...chunk.message.tool_calls);
            }
        }

        // ── No tool calls → we're done ───────────────────────────
        if (toolCalls.length === 0) {
            messages.push({ role: "assistant", content: fullContent });
            yield { type: "done", fullResponse: fullContent };
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

            yield {
                type: "tool_result",
                name: call.function.name,
                result:
                    result.length > 200
                        ? result.slice(0, 200) + "… (truncated in event)"
                        : result,
            };

            // Append tool result to history so the LLM can see it
            messages.push({
                role: "tool",
                content: result,
                tool_call_id: call.id,
            });
        }

        // Re-trigger the LLM with the updated history
        yield { type: "status", message: "reasoning" };
    }

    // Safety: we hit the iteration cap
    yield {
        type: "error",
        message: `hit tool iteration limit (${MAX_TOOL_ITERATIONS})`,
    };
    yield { type: "done", fullResponse: "" };
}

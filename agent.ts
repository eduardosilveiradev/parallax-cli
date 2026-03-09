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
    | { type: "reasoning"; content: string }
    | { type: "tool_start"; name: string; args: Record<string, unknown> }
    | { type: "tool_confirm"; name: string; args: Record<string, unknown>; resolve: (approved: boolean) => void }
    | { type: "tool_result"; name: string; result: string }
    | { type: "subagent_start"; mode: AgentMode; prompt: string }
    | { type: "subagent_end"; mode: AgentMode; result: string }
    | { type: "checkpoint"; messages: ChatMessage[] }
    | { type: "injected_messages"; messages: string[] }
    | { type: "usage"; usage: TokenUsage }
    | { type: "model_info"; model: string }
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
                "Read the contents of a file on the local filesystem. " +
                "Returns up to `limit` lines starting from `offset`. " +
                "Use offset to paginate through large files.",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "Absolute or relative path to the target file.",
                    },
                    offset: {
                        type: "number",
                        description: "Starting line number (0-indexed). Default: 0.",
                    },
                    limit: {
                        type: "number",
                        description: "Maximum number of lines to return. Default: 200.",
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

// ── Subagent tool definitions (only available in default mode) ──

const SUBAGENT_TOOL_DEFINITIONS: ToolDefinition[] = [
    {
        type: "function",
        function: {
            name: "callExploreAgent",
            description:
                "Spawn a read-only Explore subagent that deeply reads files and " +
                "returns findings about the codebase. Use this when you need to " +
                "understand the project structure, trace data flow, or find patterns " +
                "before making changes.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "What to explore or investigate in the codebase.",
                    },
                },
                required: ["prompt"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "callPlanningAgent",
            description:
                "Spawn a read-only Planning subagent that reads the codebase and " +
                "produces a structured implementation plan. Use this when you need " +
                "to plan complex multi-step changes before implementing them.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "What to plan — describe the feature or change.",
                    },
                },
                required: ["prompt"],
            },
        },
    },
];

// ── Tool implementations (placeholders) ────────────────────────
//
// Each function returns a string result that gets appended to
// the message history as a tool-role message. Swap these out
// with real implementations as the CLI matures.

const MAX_FILE_LINES = 200;

async function readLocalFile(path: string, offset: number = 0, limit: number = MAX_FILE_LINES): Promise<string> {
    try {
        const content = await fs.readFile(path, "utf-8");
        const allLines = content.split("\n");
        const totalLines = allLines.length;

        // If the file fits within the limit, return everything
        if (totalLines <= limit && offset === 0) {
            return content;
        }

        // Paginate
        const page = allLines.slice(offset, offset + limit);
        const endLine = Math.min(offset + limit, totalLines);
        let result = page.join("\n");

        // Add pagination metadata
        result += `\n\n--- Showing lines ${offset + 1}-${endLine} of ${totalLines} total ---`;
        if (endLine < totalLines) {
            result += `\n--- Use offset=${endLine} to read the next page ---`;
        }
        return result;
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
            return readLocalFile(
                args["path"] as string,
                (args["offset"] as number) ?? 0,
                (args["limit"] as number) ?? MAX_FILE_LINES,
            );

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

export type AgentMode = "default" | "explore" | "planning";

function buildBaseInfo(): string {
    return `## Information
You are running on ${process.platform} ${process.arch}
The current date is ${new Date().toLocaleString()}
The CWD is ${process.cwd()}

Every message from "tool" is NOT the user. It is the response of a tool YOU called.

## CRITICAL: Filesystem tool rules
- NEVER use directory_tree or any recursive directory listing tool. It will dump hundreds of thousands of tokens and destroy the context window.
- Use list_directory on specific paths instead. Only list the directories you actually need.
- You can also use list_allowed_directories to see where you are allowed to be/your CWD.
- NEVER list node_modules, .git, dist, build, or other generated directories.
- When exploring a project, start with the root directory only (depth 1), then drill into specific subdirectories as needed.`;
}

function buildDefaultPrompt(): string {
    return `You are Parallax, a concise and precise AI agentic code assistant running inside a terminal.

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

${buildBaseInfo()}`;
}

function buildExplorePrompt(): string {
    return `You are Parallax Explore — a deep, thorough codebase exploration agent.

Your job is to help the user fully understand their codebase by actually reading files — not just listing directories. When asked about a project, component, or feature, you MUST:

1. **Start by listing the root directory** to orient yourself.
2. **Then read every relevant file** — open each one with readLocalFile or the MCP read tool. Don't stop at listing filenames. Actually read the source code.
3. **Build a complete picture** — trace imports, understand data flow, map out dependencies, identify patterns.
4. **Report your findings** with real code snippets, not vague summaries.

## Exploration strategy
- Start broad (root listing), then drill into every subdirectory that matters.
- For each file you find, READ IT. Don't just note that it exists.
- Skip node_modules, .git, dist, build, and other generated directories.
- When analyzing a component/module, follow its imports and read those too.
- If a file is large, use offset/limit to paginate through it — don't skip it.
- Aim for completeness: read config files, entry points, utilities, types, tests.

## Response style
- Be structured: group findings by component/module.
- Show actual code snippets from the files you read.
- Highlight key exports, patterns, dependencies, and architecture decisions.
- Call out anything interesting, unusual, or potentially problematic.

You are in an agentic loop. Be aggressive with your tool usage — call readLocalFile on every file you discover. Do NOT ask the user to provide file contents. Do NOT stop after one or two files. Keep reading until you have a thorough understanding.

## Tool-calling protocol

You can call tools by emitting a tool_call in your response. After you call a tool, the SYSTEM will execute it and inject the result as a "tool" role message. These are NOT from the user. Continue your exploration — do not restart the conversation.

## Restrictions
- You have READ-ONLY access. Do NOT attempt to write, patch, create, or delete files.
- Do NOT attempt to execute terminal commands.
- If the user asks you to make changes, politely explain that you are in Explore mode and suggest switching to Chat mode.

${buildBaseInfo()}`;
}

function buildPlanningPrompt(): string {
    return `You are Parallax Plan — a structured implementation planning agent.

Your job is to produce clear, actionable implementation plans. You can read the codebase to understand the current state, then output a structured plan.

Place your finished plan in a code block with the \`plan\` language. The first line must be a \`# Title\`, followed by a description paragraph, then the plan body using simple HTML tags (<h3>, <ul>, <li>, <p>). Do NOT use className or any React/JSX attributes — use plain HTML only.

Example:
\`\`\`plan
# Rewrite AI elements to SolidJS
Rewrite the AI Elements component library from React to SolidJS while
maintaining compatibility with existing React-based shadcn/ui components.

<h3>Overview</h3>
<p>This plan outlines the migration strategy for converting the AI
Elements library from React to SolidJS.</p>

<h3>Key Steps</h3>
<ul>
    <li>Set up SolidJS project structure</li>
    <li>Install solid-js/compat for React compatibility</li>
    <li>Migrate components one by one</li>
    <li>Update test suite for each component</li>
</ul>
\`\`\`

Structure your plan with these sections (as <h3> headings inside the plan block):

- **Goal** — Brief description of what the change accomplishes.
- **Analysis** — Findings from reading the codebase.
- **Proposed Changes** — File changes grouped by component ([NEW], [MODIFY], [DELETE]).
- **Steps** — Numbered, actionable implementation steps.
- **Risks & Considerations** — Edge cases and alternatives.

You are in an agentic loop. Use your read-only tools proactively to understand the codebase before producing a plan. Do not ask the user for file contents — read them yourself.

## Tool-calling protocol

You can call tools by emitting a tool_call in your response. After you call a tool, the SYSTEM will execute it and inject the result as a "tool" role message. These are NOT from the user. Continue your planning work.

## Restrictions
- You have READ-ONLY access. Do NOT attempt to write, patch, create, or delete files.
- Do NOT attempt to execute terminal commands.
- If the user wants you to implement the plan, suggest switching to Chat mode.

${buildBaseInfo()}`;
}

function buildSystemPrompt(mode: AgentMode = "default"): string {
    let prompt: string;
    switch (mode) {
        case "explore":
            prompt = buildExplorePrompt();
            break;
        case "planning":
            prompt = buildPlanningPrompt();
            break;
        default:
            prompt = buildDefaultPrompt();
            break;
    }

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
const MAX_TOOL_ITERATIONS_EXPLORE = 25;

// Tools that are read-only and safe to execute without confirmation.
// Any tool NOT in this list will require user confirmation (unless YOLO mode).
const SAFE_TOOLS = new Set([
    "readLocalFile",
    "callExploreAgent",
    "callPlanningAgent",
    // MCP filesystem read-only tools
    "mcp_filesystem_read_file",
    "mcp_filesystem_read_multiple_files",
    "mcp_filesystem_list_directory",
    "mcp_filesystem_directory_tree",
    "mcp_filesystem_search_files",
    "mcp_filesystem_get_file_info",
    "mcp_filesystem_list_allowed_directories",
]);

/** Check if a tool name is safe (read-only) and doesn't need confirmation. */
function isToolSafe(name: string): boolean {
    if (SAFE_TOOLS.has(name)) return true;
    // MCP tools: consider list/read/get/search as safe
    if (name.startsWith("mcp_")) {
        const stripped = name.replace(/^mcp_[^_]+_/, "");
        if (/^(read|list|get|search|find|show|describe|info)/.test(stripped)) return true;
    }
    return false;
}

export async function* runAgent(
    prompt: string,
    history: ChatMessage[] = [],
    mcpConnections: MCPConnection[] = [],
    model: string = DEFAULT_MODEL,
    providerName: string = DEFAULT_PROVIDER,
    isYolo: () => boolean = () => false,
    getQueuedMessages: () => string[] = () => [],
    mode: AgentMode = "default",
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

    // Filter tools based on mode — explore/planning get read-only only
    const READ_ONLY_BUILTINS = new Set(["readLocalFile"]);
    const filterReadOnly = (tools: ToolDefinition[]) =>
        tools.filter((t) => {
            const name = t.function.name;
            if (READ_ONLY_BUILTINS.has(name)) return true;
            if (name.startsWith("mcp_")) return isToolSafe(name);
            return false;
        });

    const combinedTools = [...builtinTools, ...mcpTools];
    const allTools: ToolDefinition[] = (mode === "explore" || mode === "planning")
        ? filterReadOnly(combinedTools)
        : [...combinedTools, ...SUBAGENT_TOOL_DEFINITIONS];

    // ── Build the initial message history ──────────────────────
    const messages: ChatMessage[] = [
        { role: "system", content: buildSystemPrompt(mode) },
        ...history,
        { role: "user", content: prompt },
    ];


    // DEBUG: dump history
    // writeFileSync("history.json", JSON.stringify(messages, null, 2));

    yield { type: "status", message: "Working..." };

    // ── Agentic loop ───────────────────────────────────────────
    const maxIterations = (mode === "explore" || mode === "planning") ? MAX_TOOL_ITERATIONS_EXPLORE : MAX_TOOL_ITERATIONS;
    for (let iteration = 0; iteration < maxIterations; iteration++) {
        let fullContent = "";
        let fullReasoning = "";
        let toolCalls: ToolCall[] = [];

        // Stream via the provider
        for await (const chunk of provider.stream(messages, model, allTools)) {
            // Accumulate text tokens
            if (chunk.content) {
                fullContent += chunk.content;
                yield { type: "token", content: chunk.content };
            }

            // Stream reasoning/thinking tokens
            if (chunk.reasoning) {
                fullReasoning += chunk.reasoning;
                yield { type: "reasoning", content: chunk.reasoning };
            }

            // Accumulate tool calls (may arrive incrementally across chunks
            // in OpenAI-compatible streaming — same index, partial args)
            if (chunk.tool_calls) {
                for (const tc of chunk.tool_calls) {
                    // If this chunk has an id, it starts a new tool call
                    if (tc.id) {
                        toolCalls.push({
                            id: tc.id,
                            type: tc.type ?? "function",
                            function: {
                                name: tc.function.name ?? "",
                                arguments: tc.function.arguments ?? "",
                            },
                        });
                    } else if (toolCalls.length > 0) {
                        // No id → continuation of the last tool call (append name/args fragments)
                        const last = toolCalls[toolCalls.length - 1]!;
                        if (tc.function.name) {
                            last.function.name += tc.function.name;
                        }
                        if (tc.function.arguments) {
                            // Arguments may be a string fragment or an object
                            if (typeof last.function.arguments === "string" && typeof tc.function.arguments === "string") {
                                last.function.arguments += tc.function.arguments;
                            } else {
                                last.function.arguments = tc.function.arguments;
                            }
                        }
                    } else {
                        // Edge case: no id and no existing calls — push as-is
                        toolCalls.push(tc);
                    }
                }
            }

            // Forward token usage stats
            if (chunk.usage) {
                yield { type: "usage", usage: chunk.usage };
            }

            // Forward resolved model name (for dynamic routing like openrouter/free)
            if (chunk.model) {
                yield { type: "model_info", model: chunk.model };
            }
        }

        // ── No tool calls → we're done ───────────────────────────
        if (toolCalls.length === 0) {
            messages.push({ role: "assistant", content: fullContent, ...(fullReasoning ? { reasoning: fullReasoning } : {}) });
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

        let pendingResolve: ((v: boolean) => void) | null = null;
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

            // ── Confirmation gate for destructive tools ──────────
            const needsConfirm = !isYolo() && !isToolSafe(call.function.name);
            if (needsConfirm) {
                let approved = false;
                const confirmPromise = new Promise<boolean>((resolve) => {
                    // We yield the event synchronously (below), then await
                    // the promise. The UI calls resolve(true/false).
                    (pendingResolve as any) = resolve;
                });
                // Yield confirm event with the resolve callback
                yield {
                    type: "tool_confirm",
                    name: call.function.name,
                    args,
                    resolve: (pendingResolve as any),
                };
                approved = await confirmPromise;
                if (!approved) {
                    const result = "⚠ tool denied by user";
                    yield { type: "tool_result", name: call.function.name, result };
                    messages.push({
                        role: "tool",
                        content: result,
                        tool_call_id: call.id,
                    });
                    continue;
                }
            }

            let result: string;
            try {
                // ── Subagent dispatch ─────────────────────────────
                if (call.function.name === "callExploreAgent" || call.function.name === "callPlanningAgent") {
                    const subMode: AgentMode = call.function.name === "callExploreAgent" ? "explore" : "planning";
                    const subPrompt = args["prompt"] as string;
                    yield { type: "subagent_start", mode: subMode, prompt: subPrompt };
                    yield { type: "status", message: `running ${subMode} subagent…` };
                    let subResponse = "";
                    const subTools: { name: string; args: Record<string, unknown>; result?: string }[] = [];
                    let subReasoning = "";
                    const subGen = runAgent(
                        subPrompt,
                        [],  // fresh context
                        mcpConnections,
                        model,
                        providerName,
                        isYolo,
                        () => [],
                        subMode,
                    );
                    for await (const subEvent of subGen) {
                        // Forward observable events to parent stream
                        switch (subEvent.type) {
                            case "tool_start":
                                subTools.push({ name: subEvent.name, args: subEvent.args });
                                yield subEvent;
                                break;
                            case "tool_result": {
                                const st = subTools.find(t => t.name === subEvent.name && !t.result);
                                if (st) st.result = subEvent.result;
                                yield subEvent;
                                break;
                            }
                            case "reasoning":
                                subReasoning += subEvent.content;
                                yield subEvent;
                                break;
                            case "status":
                            case "mcp_status":
                            case "error":
                            case "usage":
                                yield subEvent;
                                break;
                            case "token":
                                subResponse += subEvent.content;
                                break;
                            case "done":
                                subResponse = subEvent.fullResponse || subResponse;
                                break;
                        }
                    }
                    // Encode tool activities in result so they persist in the conversation
                    const subResult = JSON.stringify({
                        response: subResponse || "(subagent returned no output)",
                        tools: subTools,
                        reasoning: subReasoning || undefined,
                    });
                    result = subResult;
                    yield { type: "subagent_end", mode: subMode, result: subResponse };
                } else {
                    // Regular tool dispatch
                    const isMCP = call.function.name.startsWith("mcp_");
                    yield {
                        type: isMCP ? "mcp_status" : "status",
                        message: `executing ${call.function.name}`,
                    };
                    result = isMCP
                        ? await dispatchMCPTool(call.function.name, args, mcpConnections)
                        : await dispatchTool(call.function.name, args);
                }
            } catch (toolErr: any) {
                result = `⚠ error: ${toolErr.message ?? String(toolErr)}`;
                yield { type: "error", message: `${call.function.name}: ${toolErr.message ?? toolErr}` };
            }

            // Format the result for display (pass diffs as-is with marker, truncate others)
            let displayResult: string;
            const isSubagentCall = call.function.name === "callExploreAgent" || call.function.name === "callPlanningAgent";
            const isDiff = result.includes("---") && result.includes("+++") && result.includes("@@");
            if (isSubagentCall) {
                // Subagent results are handled by the subagent_end event; skip display
                displayResult = "(see subagent output above)";
            } else if (isDiff) {
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

            // Append tool result to history (capped to prevent context blowout)
            // Skip capping for subagent calls — the JSON must stay intact for persistence
            const MAX_TOOL_RESULT_CHARS = 10_000;
            const cappedResult = isSubagentCall ? result
                : result.length > MAX_TOOL_RESULT_CHARS
                    ? result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n\n--- Output truncated (${result.length} chars total, showing first ${MAX_TOOL_RESULT_CHARS}) ---`
                    : result;
            messages.push({
                role: "tool",
                content: cappedResult,
                tool_call_id: call.id,
            });
        }

        // Drain any queued user messages before re-triggering the LLM
        const queued = getQueuedMessages();
        if (queued.length > 0) {
            for (const qMsg of queued) {
                messages.push({ role: "user", content: qMsg });
            }
            yield { type: "injected_messages", messages: queued };
        }

        // Checkpoint: save session state after each tool loop
        yield { type: "checkpoint", messages: messages.slice(1) };

        // Re-trigger the LLM with the updated history
        yield { type: "status", message: "Working..." };
    }

    // Safety: we hit the iteration cap
    yield {
        type: "error",
        message: `hit tool iteration limit (${maxIterations})`,
    };
    yield { type: "done", fullResponse: "", messages: messages.slice(1) };
}

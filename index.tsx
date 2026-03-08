#!/usr/bin/env node
import React, { useState, useEffect, useRef, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import { runAgent, DEFAULT_MODEL, DEFAULT_PROVIDER, type AgentEvent, type ChatMessage } from "./agent.js";
import { Shimmer } from "./Shimmer.js";
import { getProvider, listProviders } from "./providers.js";
import {
    connectToServer,
    disconnectServer,
    type MCPServerConfig,
    type MCPConnection,
} from "./mcp-client.js";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { commands, type AppContext } from "./commands.js";
import {
    generateId,
    deriveTitle,
    generateTitle,
    saveConversation,
    loadConversation as loadConv,
    listConversations as listConvs,
    deleteConversation as deleteConv,
    getLastModel,
    type ConversationSummary,
} from "./store.js";

// ── Markdown renderer (grayscale theme) ────────────────────────

marked.use(
    markedTerminal({
        // Grayscale: no colors, just weight and dimness
        code: chalk.white,
        blockquote: chalk.gray.italic,
        html: chalk.gray,
        heading: chalk.white.bold,
        firstHeading: chalk.white.bold.underline,
        hr: chalk.gray,
        listitem: chalk.reset,
        table: chalk.reset,
        paragraph: chalk.reset,
        strong: chalk.bold,
        em: chalk.italic,
        codespan: chalk.white,
        del: chalk.dim.strikethrough,
        link: chalk.underline,
        href: chalk.underline,
        reflowText: true,
        showSectionPrefix: false,
        width: Math.min(process.stdout.columns ?? 100, 120) - 20,
    }),
);

function renderMarkdown(text: string): string {
    // marked returns string with trailing newlines — trim them
    return (marked.parse(text) as string).trimEnd();
}


/** Format a token count compactly. */
function formatTokens(n: number): string {
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}




// MCP server configs: override with PARALLAX_MCP_SERVERS env var (JSON array),
// or fall back to the built-in filesystem + shell servers.
const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [
    {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
    },
];

const MCP_SERVER_CONFIGS: MCPServerConfig[] = (() => {
    const raw = process.env["PARALLAX_MCP_SERVERS"];
    if (!raw) return DEFAULT_MCP_SERVERS;
    try {
        return JSON.parse(raw) as MCPServerConfig[];
    } catch {
        return DEFAULT_MCP_SERVERS;
    }
})();

// ── Types ──────────────────────────────────────────────────────

interface ToolActivity {
    name: string;
    args?: Record<string, unknown>;
    result?: string;
}

/** Info about a pending tool-confirmation prompt. */
interface PendingConfirm {
    name: string;
    args: Record<string, unknown>;
    resolve: (approved: boolean) => void;
}

type DisplayMessage =
    | { type: "chat"; role: "user" | "assistant" | "system"; content: string; tokens?: number; reasoning?: string }
    | { type: "tools"; activities: ToolActivity[] };

// ── Components ─────────────────────────────────────────────────



function MessageRow({ msg, showReasoning }: { msg: DisplayMessage; showReasoning: boolean }) {
    if (msg.type === "tools") {
        return (
            <Box flexDirection="column" marginY={0}>
                {msg.activities.map((t, i) => (
                    <ToolBadge key={i} name={t.name} result={t.result} />
                ))}
            </Box>
        );
    }

    const isAI = msg.role === "assistant";
    const isSystem = msg.role === "system";
    const rendered = useMemo(
        () => ((isAI || isSystem) ? renderMarkdown(msg.content) : msg.content),
        [msg.content, isAI, isSystem],
    );

    return (
        <Box flexDirection="column" paddingX={2} marginY={0} borderStyle="single" borderLeft={true} borderRight={false} borderTop={false} borderBottom={false} borderColor={isAI ? "white" : isSystem ? "grey" : "blue"}>
            {msg.type === "chat" && msg.reasoning && (
                <ReasoningBlock content={msg.reasoning} expanded={showReasoning} />
            )}
            <Box flexDirection="row">
                <Text wrap="wrap" dimColor={!isAI && !isSystem} italic={isSystem}>{rendered}</Text>
            </Box>
            {msg.type === "chat" && msg.tokens != null && msg.tokens > 0 && (
                <Box flexDirection="row">
                    <Text dimColor color="grey">   </Text>
                    <Text dimColor>{formatTokens(msg.tokens)} tokens</Text>
                </Box>
            )}
        </Box>
    );
}

function ReasoningBlock({ content, streaming, expanded }: { content: string; streaming?: boolean; expanded?: boolean }) {
    const lines = content.split("\n");
    const preview = lines[0]?.slice(0, 80) ?? "";
    const isOpen = streaming || expanded;

    if (!content.trim()) return null;

    return (
        <Box flexDirection="column" marginBottom={0}>
            <Text dimColor italic>
                {"💭 "}
                <Text bold dimColor>{streaming ? "Thinking..." : "Reasoning"}</Text>
                {!streaming && <Text dimColor>{isOpen ? " ▾" : " ▸ "}{!isOpen && preview}{!isOpen && (content.length > 80 ? "…" : "")}</Text>}
            </Text>
            {isOpen && (
                <Box paddingLeft={3} flexDirection="column">
                    <Text dimColor italic wrap="wrap">{content}</Text>
                </Box>
            )}
        </Box>
    );
}

function StreamingRow({ content }: { content: string }) {
    const [cursor, setCursor] = useState(true);

    useEffect(() => {
        const t = setInterval(() => setCursor((c) => !c), 500);
        return () => clearInterval(t);
    }, []);

    return (
        <Box flexDirection="row" paddingX={2} marginY={0}>
            <Text dimColor> │ </Text>
            <Text wrap="wrap">
                {content}
                <Text dimColor>{cursor ? "▎" : " "}</Text>
            </Text>
        </Box>
    );
}

function StatusLine({ status }: { status: string | null }) {
    if (!status) return null;
    return (
        <Box paddingX={4} marginY={0}>
            <Shimmer animate={status !== "Done"} text={status} />
        </Box>
    );
}

function CommandPalette({
    items,
    selectedIndex,
}: {
    items: [string, (typeof commands)[string]][];
    selectedIndex: number;
}) {
    return (
        <Box paddingX={4} marginY={0} flexDirection="column">
            {items.map(([key, value], i) => {
                const selected = i === selectedIndex;
                return (
                    <Box key={key} flexDirection="row">
                        <Text color={selected ? "white" : "grey"} bold={selected} inverse={selected}>
                            {" "}{key}{" "}
                        </Text>
                        <Text color={"grey"}>{" "}{value.description}</Text>
                    </Box>
                );
            })}
        </Box>
    );
}

interface ProviderModel {
    provider: string;
    providerLabel: string;
    model: string;
}

const MODEL_PALETTE_MAX_VISIBLE = 16;

function ModelPalette({
    items,
    selectedIndex,
}: {
    items: ProviderModel[];
    selectedIndex: number;
}) {
    // Compute a scrolling window around the selected index
    const total = items.length;
    const maxVis = MODEL_PALETTE_MAX_VISIBLE;
    let start = 0;
    let end = Math.min(total, maxVis);

    if (total > maxVis) {
        // Centre the selection in the window
        start = Math.max(0, selectedIndex - Math.floor(maxVis / 2));
        if (start + maxVis > total) start = total - maxVis;
        end = start + maxVis;
    }

    const visible = items.slice(start, end);
    return (
        <Box paddingX={4} marginY={0} flexDirection="column">
            <Text dimColor>models from <Text bold>all providers</Text>:</Text>
            {start > 0 && (
                <Text dimColor>  ↑ {start} more above</Text>
            )}
            {visible.map((entry, i) => {
                const actualIndex = start + i;
                const selected = actualIndex === selectedIndex;
                // Show provider header when provider changes (also for the very first visible item)
                const prevEntry = actualIndex > 0 ? items[actualIndex - 1] : undefined;
                const showHeader = !prevEntry || entry.provider !== prevEntry.provider;
                return (
                    <Box key={`${entry.provider}/${entry.model}`} flexDirection="column">
                        {showHeader && (
                            <Text dimColor bold>{"  "}{entry.providerLabel}</Text>
                        )}
                        <Box flexDirection="row">
                            <Text color={selected ? "white" : "grey"} bold={selected} inverse={selected}>
                                {"   "}{entry.model}{" "}
                            </Text>
                        </Box>
                    </Box>
                );
            })}
            {end < total && (
                <Text dimColor>  ↓ {total - end} more below</Text>
            )}
        </Box>
    );
}

function ConversationPalette({
    items,
    selectedIndex,
}: {
    items: ConversationSummary[];
    selectedIndex: number;
}) {
    return (
        <Box paddingX={4} marginY={0} flexDirection="column">
            <Text dimColor>saved conversations:</Text>
            {items.slice(0, 12).map((c, i) => {
                const selected = i === selectedIndex;
                const date = new Date(c.updatedAt).toLocaleDateString();
                const label = `${c.title.slice(0, 50)}${c.title.length > 50 ? "…" : ""}`;
                return (
                    <Box key={c.id} flexDirection="column">
                        <Box flexDirection="row">
                            <Text color={selected ? "white" : "grey"} bold={selected} inverse={selected}>
                                {" "}{c.id}{" "}
                            </Text>
                            <Text color={selected ? "white" : "grey"}>{" "}{label}</Text>
                            <Text dimColor>{"  "}{date}{"  "}{c.messageCount} msgs</Text>
                        </Box>
                        {c.lastMessage && (
                            <Text dimColor>{"          "}{c.lastMessage}{c.lastMessage.length >= 120 ? "…" : ""}</Text>
                        )}
                    </Box>
                );
            })}
            {items.length > 12 && (
                <Text dimColor>  …and {items.length - 12} more</Text>
            )}
            {items.length === 0 && (
                <Text dimColor>  no saved conversations</Text>
            )}
        </Box>
    );
}

/** Map raw tool IDs to friendly display names (OpenMoA style). */
function toolDisplayName(raw: string): string {
    const NAMES: Record<string, string> = {
        // Built-in tools
        readLocalFile: "Read File",
        patchLocalFile: "Patch File",
        executeTerminalCommand: "Terminal",
        executeRemoteVPS: "Remote Exec",
        // MCP filesystem tools
        mcp_filesystem_read_file: "Read File",
        mcp_filesystem_read_multiple_files: "Read Files",
        mcp_filesystem_write_file: "Write File",
        mcp_filesystem_edit_file: "Edit File",
        mcp_filesystem_create_directory: "Create Dir",
        mcp_filesystem_list_directory: "List Dir",
        mcp_filesystem_directory_tree: "Dir Tree",
        mcp_filesystem_move_file: "Move File",
        mcp_filesystem_search_files: "Search Files",
        mcp_filesystem_get_file_info: "File Info",
        mcp_filesystem_list_allowed_directories: "Allowed Dirs",
    };
    if (NAMES[raw]) return NAMES[raw]!;

    // MCP tools: strip prefix, capitalize
    const stripped = raw.replace(/^mcp_[^_]+_/, "");
    return stripped.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function DiffView({ raw }: { raw: string }) {
    let diff = raw.trim();
    if (diff.startsWith("```")) {
        diff = diff.replace(/^```\w*\n?/, "").replace(/\n?```$/, "");
    }
    const lines = diff.split("\n");

    // Extract filename
    let fileName = "";
    for (const line of lines) {
        if (line.startsWith("+++")) {
            const name = line.replace(/^\+\+\+\s+/, "").replace(/\t.*$/, "");
            if (name && name !== "/dev/null") fileName = name.replace(/^[ab]\//, "");
        }
    }

    // Track line numbers
    let oldLine = 0, newLine = 0;

    const rendered: React.ReactNode[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.startsWith("Index:") || line.startsWith("===") || line.startsWith("diff ")) continue;
        if (line.startsWith("---") || line.startsWith("+++")) continue;
        if (line.startsWith("@@")) {
            const match = line.match(/@@ -(\d+).*\+(\d+)/);
            if (match) { oldLine = Number(match[1]); newLine = Number(match[2]); }
            rendered.push(
                <Text key={i} dimColor>{" ...  ... "}@ Hunk: {oldLine}, {newLine}</Text>
            );
            continue;
        }
        if (line.startsWith("-")) {
            const oln = String(oldLine++).padStart(4);
            rendered.push(
                <Text key={i} backgroundColor="red" color="white">{oln}      - {line.slice(1)}</Text>
            );
        } else if (line.startsWith("+")) {
            const nln = String(newLine++).padStart(4);
            rendered.push(
                <Text key={i} backgroundColor="green" color="black">{"     "}{nln} + {line.slice(1)}</Text>
            );
        } else {
            // context
            const oln = String(oldLine++).padStart(4);
            const nln = String(newLine++).padStart(4);
            rendered.push(
                <Text key={i}><Text dimColor>{oln} {nln}</Text>   {line.startsWith(" ") ? line.slice(1) : line}</Text>
            );
        }
    }

    return (
        <Box flexDirection="column" paddingLeft={0} marginTop={0}>
            <Text> <Text color="yellow" bold>●</Text> <Text bold>Edit File:</Text>  <Text dimColor>{fileName}</Text></Text>
            {rendered}
        </Box>
    );
}

/** Format tool args into a compact one-liner for display. */
function formatToolArgs(name: string, args?: Record<string, unknown>): string {
    if (!args || Object.keys(args).length === 0) return "";
    // Terminal commands: show command string prominently
    if (name === "executeTerminalCommand" || name.includes("terminal")) {
        return String(args["command"] ?? "");
    }
    // File operations: show path
    if (args["path"]) return String(args["path"]);
    if (args["filename"]) return String(args["filename"]);
    // Generic: compact JSON
    const json = JSON.stringify(args);
    return json.length > 120 ? json.slice(0, 117) + "…" : json;
}

function ToolBadge({ name, args, result }: { name: string; args?: Record<string, unknown>; result?: string }) {
    const display = toolDisplayName(name);
    const isDiff = result?.startsWith("__DIFF__");
    const diffContent = isDiff ? result!.slice(8) : undefined;
    const cleanResult = isDiff ? undefined : result;
    const argsStr = formatToolArgs(name, args);

    // For diffs, the DiffView already has its own header
    if (diffContent) {
        return (
            <Box paddingX={4} marginY={0} flexDirection="column">
                <DiffView raw={diffContent} />
            </Box>
        );
    }

    return (
        <Box paddingX={4} marginY={0} flexDirection="column">
            <Text>
                <Text color="yellow" bold>● </Text>
                <Text bold>{display}:</Text>
                {argsStr ? <Text>{"  "}{argsStr}</Text> : null}
            </Text>
            {cleanResult ? (() => {
                const lines = cleanResult.split("\n");
                const maxLines = 20;
                const truncated = lines.length > maxLines;
                const shown = truncated ? lines.slice(0, maxLines).join("\n") : cleanResult;
                return (
                    <>
                        <Text dimColor>{"      "}{shown}</Text>
                        {truncated && <Text dimColor italic>{"      "}(+{lines.length - maxLines} more lines)</Text>}
                    </>
                );
            })() : null}
        </Box>
    );
}

function ConfirmationPrompt({ name, args }: { name: string; args: Record<string, unknown> }) {
    const display = toolDisplayName(name);
    const argsStr = formatToolArgs(name, args);
    return (
        <Box paddingX={4} marginY={0} flexDirection="column">
            <Text>
                <Text color="yellow" bold>▲ </Text>
                <Text bold>{display}</Text>
                {argsStr ? <Text>{"  "}{argsStr}</Text> : null}
            </Text>
            <Text dimColor>
                {"  ⟩ allow? "}
                <Text bold>(y)</Text>{"es / "}
                <Text bold>(n)</Text>{"o / "}
                <Text bold>(a)</Text>{"lways"}
            </Text>
        </Box>
    );
}


function ErrorBanner({ message }: { message: string }) {
    return (
        <Box paddingX={4} marginY={1}>
            <Text inverse bold>{" ERROR "}</Text>
            <Text>{"  "}{message}</Text>
        </Box>
    );
}

function InputLine({ value, cursorPos, disabled, queueMode }: { value: string; cursorPos: number; disabled: boolean; queueMode?: boolean }) {
    const [showCursor, setShowCursor] = useState(true);
    useEffect(() => {
        const interval = setInterval(() => {
            setShowCursor((prev) => !prev);
        }, 500);
        return () => clearInterval(interval);
    }, []);

    // For multi-line, figure out which line the cursor is on
    const lines = value.split("\n");
    let charCount = 0;
    let cursorLine = lines.length - 1;
    let cursorCol = 0;
    for (let i = 0; i < lines.length; i++) {
        const lineLen = lines[i]!.length;
        if (cursorPos <= charCount + lineLen) {
            cursorLine = i;
            cursorCol = cursorPos - charCount;
            break;
        }
        charCount += lineLen + 1; // +1 for newline
    }

    return (
        <Box
            borderStyle="single"
            borderLeft={false}
            borderRight={false}
            borderDimColor={disabled}
            paddingX={1}
            paddingY={0}
            flexDirection="column"
        >
            {lines.map((line, i) => {
                const isCursorLine = !disabled && i === cursorLine;
                const before = isCursorLine ? line.slice(0, cursorCol) : line;
                const after = isCursorLine ? line.slice(cursorCol) : "";
                const cursorChar = after.length > 0 ? after[0] : " ";
                const rest = after.length > 0 ? after.slice(1) : "";
                return (
                    <Box key={i} flexDirection="row">
                        <Text bold={!disabled} dimColor={disabled}>
                            {i === 0 ? (queueMode ? "+ " : "> ") : "  "}
                        </Text>
                        <Text dimColor={disabled}>{before}</Text>
                        {isCursorLine && (
                            <Text inverse={showCursor}>{cursorChar}</Text>
                        )}
                        {isCursorLine && rest && (
                            <Text dimColor={disabled}>{rest}</Text>
                        )}
                        {!isCursorLine && null}
                    </Box>
                );
            })}
        </Box>
    );
}

interface AppProps {
    mcpConnections: MCPConnection[];
    initialModel?: string;
    initialProvider?: string;
    initialYolo?: boolean;
    initialSessionId?: string;
}

function App({ mcpConnections, initialModel, initialProvider, initialYolo, initialSessionId }: AppProps) {
    const { exit } = useApp();
    const [messages, setMessages] = useState<DisplayMessage[]>([]);
    const [input, setInput] = useState("");
    const [cursorPos, setCursorPos] = useState(0);
    const [busy, setBusy] = useState(false);
    const [streamContent, setStreamContent] = useState("");
    const [reasoningContent, setReasoningContent] = useState("");
    const [status, setStatus] = useState<string | null>(null);
    const [mcpStatus, setMcpStatus] = useState<string | null>(null);
    const [tools, setTools] = useState<ToolActivity[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [model, setModel] = useState(initialModel ?? DEFAULT_MODEL);
    const [provider, setProvider] = useState(initialProvider ?? DEFAULT_PROVIDER);
    const [yolo, setYolo] = useState(initialYolo ?? false);
    const [showReasoning, setShowReasoning] = useState(false);
    const yoloRef = useRef(false);
    useEffect(() => { yoloRef.current = yolo; }, [yolo]);
    const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);

    // Abort mechanism: Esc sets this to true and calls gen.return()
    const abortRef = useRef(false);
    const activeGenRef = useRef<AsyncGenerator<any> | null>(null);

    // Double Ctrl+C to quit
    const [ctrlCPending, setCtrlCPending] = useState(false);
    const ctrlCTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [showCommandPalette, setShowCommandPalette] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);

    // Load last-used model from most recent conversation on startup
    // (only if no CLI override was given)
    useEffect(() => {
        if (!initialModel) {
            getLastModel().then((saved) => {
                if (saved) {
                    setModel(saved.model);
                    if (!initialProvider) setProvider(saved.provider);
                }
            });
        }
    }, []);

    // Load initial session if specified via --load
    useEffect(() => {
        if (initialSessionId) {
            loadConv(initialSessionId).then((conv) => {
                if (conv) {
                    agentHistory.current = conv.messages;
                    conversationId.current = conv.id;
                    createdAt.current = conv.createdAt;
                    setModel(conv.model);
                    setProvider(conv.provider);
                    setTotalTokens(0);
                    const display: DisplayMessage[] = [];
                    for (let i = 0; i < conv.messages.length; i++) {
                        const m = conv.messages[i]!;
                        if (m.role === "tool") {
                            let toolName = "tool";
                            const prev = conv.messages[i - 1];
                            if (prev?.role === "assistant" && prev.tool_calls) {
                                const tc = prev.tool_calls.find((tc) => tc.id === m.tool_call_id);
                                if (tc) toolName = tc.function.name;
                            }
                            const isDiff = m.content.includes("---") && m.content.includes("+++") && m.content.includes("@@");
                            const toolResult = isDiff
                                ? "__DIFF__" + m.content
                                : (m.content.length > 200 ? m.content.slice(0, 200) + "…" : m.content);
                            const lastDisplay = display[display.length - 1];
                            if (lastDisplay?.type === "tools") {
                                lastDisplay.activities.push({ name: toolName, result: toolResult });
                            } else {
                                display.push({ type: "tools", activities: [{ name: toolName, result: toolResult }] });
                            }
                        } else if (m.role === "assistant" && m.tool_calls && !m.content.trim()) {
                            continue;
                        } else if (m.role === "assistant" || m.role === "user") {
                            display.push({ type: "chat", role: m.role, content: m.content, tokens: m.tokens, reasoning: m.reasoning });
                        }
                    }
                    setMessages(display);
                    addSystemMessage(`Loaded session \`${initialSessionId}\``);
                } else {
                    setError(`Session "${initialSessionId}" not found`);
                }
            });
        }
    }, []);

    // Model palette state
    const [availableModels, setAvailableModels] = useState<ProviderModel[]>([]);
    const [showModelPalette, setShowModelPalette] = useState(false);
    const [modelPaletteIndex, setModelPaletteIndex] = useState(0);

    // Conversation palette state
    const [convoPaletteItems, setConvoPaletteItems] = useState<ConversationSummary[]>([]);
    const [showConvoPalette, setShowConvoPalette] = useState(false);
    const [convoPaletteIndex, setConvoPaletteIndex] = useState(0);

    const openConvoPalette = () => {
        listConvs().then((items) => {
            setConvoPaletteItems(items);
            setShowConvoPalette(true);
            setConvoPaletteIndex(0);
        });
    };

    // Compute filtered commands for the palette (shared between UI and dispatch)
    const filteredCommands = useMemo(() => {
        if (!input.startsWith("/")) return [];
        const query = input.slice(1);
        return Object.entries(commands).filter(([key]) =>
            key.startsWith(query),
        );
    }, [input]);

    useEffect(() => {
        setShowCommandPalette(input.startsWith("/") && !showModelPalette);
        setSelectedIndex(0);
    }, [input, showModelPalette]);

    // Fetch models from ALL providers
    useEffect(() => {
        let cancelled = false;
        const providers = listProviders();
        Promise.all(
            providers.map(async (p) => {
                try {
                    const models = await p.listModels();
                    return models.map((m) => ({
                        provider: p.name,
                        providerLabel: p.label,
                        model: m,
                    }));
                } catch {
                    return [];
                }
            }),
        ).then((results) => {
            if (!cancelled) setAvailableModels(results.flat());
        });
        return () => { cancelled = true; };
    }, []);

    // Filtered models for the palette (filter by search term after /model )
    const filteredModels = useMemo(() => {
        if (!showModelPalette) return [] as ProviderModel[];
        const match = input.match(/^\/model\s*(.*)/i);
        const query = (match?.[1] ?? "").toLowerCase();
        return availableModels.filter((m) =>
            m.model.toLowerCase().includes(query) ||
            m.provider.toLowerCase().includes(query) ||
            m.providerLabel.toLowerCase().includes(query),
        );
    }, [showModelPalette, input, availableModels]);

    // Reset model palette index when filter changes
    useEffect(() => {
        setModelPaletteIndex(0);
    }, [filteredModels.length]);

    // Maintain ChatMessage history for the agent (includes system/tool msgs)
    const agentHistory = useRef<ChatMessage[]>([]);
    const [totalTokens, setTotalTokens] = useState(0);

    // Message queue: users can type while agent is busy; messages get injected
    const messageQueue = useRef<string[]>([]);
    const drainQueue = (): string[] => {
        const msgs = [...messageQueue.current];
        messageQueue.current = [];
        return msgs;
    };

    // Conversation persistence
    const conversationId = useRef(generateId());
    const createdAt = useRef(new Date().toISOString());

    const sendMessage = async (text: string) => {
        // Show user message immediately
        setMessages((prev) => [...prev, { type: "chat", role: "user", content: text }]);
        setBusy(true);
        setStreamContent("");
        setReasoningContent("");
        setStatus("Initializing...");
        setMcpStatus(null);
        setTools([]);
        setError(null);

        // Track tools locally (avoids stale React state in async closure)
        let toolsAccum: ToolActivity[] = [];
        let turnTokens = 0;

        abortRef.current = false;
        let fullResponse = "";
        let reasoningAccum = "";

        try {
            const gen = runAgent(text, agentHistory.current, mcpConnections, model, provider, () => yoloRef.current, drainQueue);
            activeGenRef.current = gen;

            for await (const event of gen) {
                // Check abort flag at each iteration
                if (abortRef.current) break;
                switch (event.type) {
                    case "status":
                        setStatus(event.message);
                        break;

                    case "token":
                        fullResponse += event.content;
                        setStreamContent(fullResponse);
                        setStatus(null);
                        break;

                    case "reasoning":
                        reasoningAccum += event.content;
                        setReasoningContent(reasoningAccum);
                        break;

                    case "tool_start":
                        toolsAccum.push({ name: event.name, args: event.args });
                        setTools([...toolsAccum]);
                        break;

                    case "tool_confirm": {
                        // Show confirmation prompt and wait for user response
                        const confirmResult = await new Promise<boolean>((userResolve) => {
                            setPendingConfirm({
                                name: event.name,
                                args: event.args,
                                resolve: (approved: boolean) => {
                                    event.resolve(approved);
                                    userResolve(approved);
                                },
                            });
                        });
                        setPendingConfirm(null);
                        if (!confirmResult) {
                            // Tool was denied — update the tool badge
                            toolsAccum = toolsAccum.map((t) =>
                                t.name === event.name && !t.result
                                    ? { ...t, result: "⚠ denied" }
                                    : t,
                            );
                            setTools([...toolsAccum]);
                        }
                        break;
                    }

                    case "injected_messages":
                        // Show queued messages in the chat as user messages
                        setMessages((prev) => [
                            ...prev,
                            ...(toolsAccum.length > 0 ? [{ type: "tools" as const, activities: toolsAccum }] : []),
                            ...event.messages.map((m) => ({
                                type: "chat" as const,
                                role: "user" as const,
                                content: `➤ ${m}`,
                            })),
                        ]);
                        toolsAccum = [];
                        setTools([]);
                        break;

                    case "tool_result":
                        toolsAccum = toolsAccum.map((t) =>
                            t.name === event.name && !t.result
                                ? { ...t, result: event.result }
                                : t,
                        );
                        setTools([...toolsAccum]);
                        fullResponse = "";
                        setStreamContent("");
                        break;

                    case "error":
                        setError(event.message);
                        break;

                    case "mcp_status":
                        setMcpStatus(event.message);
                        break;

                    case "usage":
                        setTotalTokens((prev) => prev + event.usage.totalTokens);
                        turnTokens += event.usage.completionTokens;
                        break;

                    case "done":
                        // Update agent history (the full message list including tool calls)
                        const fullHistory = event.messages;
                        const lastMsg = fullHistory[fullHistory.length - 1];
                        if (lastMsg && lastMsg.role === "assistant") {
                            lastMsg.tokens = turnTokens;
                            if (reasoningAccum) {
                                lastMsg.reasoning = reasoningAccum;
                            }
                        }
                        agentHistory.current = fullHistory;
                        break;

                    case "checkpoint":
                        // Save session state after each tool loop
                        agentHistory.current = event.messages;
                        saveConversation({
                            id: conversationId.current,
                            title: deriveTitle(event.messages),
                            model,
                            provider,
                            createdAt: createdAt.current,
                            updatedAt: new Date().toISOString(),
                            messages: event.messages,
                        }).catch(() => { /* best-effort */ });
                        break;
                }
            }
        } catch (err: any) {
            setError(err.message ?? "unexpected error");
        } finally {
            // Flush any accumulated tools + response into messages so they persist
            const pendingMessages: DisplayMessage[] = [];
            if (toolsAccum.length > 0) {
                pendingMessages.push({ type: "tools", activities: toolsAccum });
            }
            if (fullResponse.trim()) {
                pendingMessages.push({
                    type: "chat",
                    role: "assistant",
                    content: fullResponse,
                    tokens: turnTokens,
                    reasoning: reasoningAccum || undefined,
                });
            }
            if (pendingMessages.length > 0) {
                setMessages((prev) => [...prev, ...pendingMessages]);
            }
            setTools([]);
            setStreamContent("");
            setReasoningContent("");
            setStatus("Done");
            setBusy(false);
            activeGenRef.current = null;
            abortRef.current = false;

            // Always save conversation to disk (best-effort)
            const history = agentHistory.current;
            if (history.length > 0) {
                const isFirstExchange = history.filter((m) => m.role === "user").length === 1;
                const titlePromise = isFirstExchange
                    ? generateTitle(history)
                    : Promise.resolve(deriveTitle(history));
                titlePromise.then((title) =>
                    saveConversation({
                        id: conversationId.current,
                        title,
                        model,
                        provider,
                        createdAt: createdAt.current,
                        updatedAt: new Date().toISOString(),
                        messages: history,
                    }),
                ).catch(() => { /* best-effort */ });
            }
        }
    };

    // ── Helpers for commands ───────────────────────────────────

    const addSystemMessage = (content: string) => {
        setMessages((prev) => [
            ...prev,
            { type: "chat", role: "system", content },
        ]);
    };

    const deleteAllOtp = useRef<string | null>(null);

    const appContext: AppContext = {
        exit: () => {
            mcpConnections.forEach((c) => disconnectServer(c));
            exit();
        },
        clearMessages: () => setMessages([]),
        resetHistory: () => {
            agentHistory.current = [];
            setTotalTokens(0);
            conversationId.current = generateId();
            createdAt.current = new Date().toISOString();
        },
        addSystemMessage,
        sendMessage,
        mcpConnections,
        model,
        setModel,
        provider,
        setProvider,
        conversationHistory: agentHistory.current,
        conversationId: conversationId.current,
        loadConversation: async (id: string) => {
            const conv = await loadConv(id);
            if (!conv) throw new Error(`conversation "${id}" not found`);
            // Restore state
            agentHistory.current = conv.messages;
            conversationId.current = conv.id;
            createdAt.current = conv.createdAt;
            setModel(conv.model);
            setProvider(conv.provider);
            setTotalTokens(0);
            // Rebuild display messages from history
            const display: DisplayMessage[] = [];
            for (let i = 0; i < conv.messages.length; i++) {
                const m = conv.messages[i]!;

                if (m.role === "tool") {
                    // Tool result → render as a tool badge
                    // Try to get the tool name from the preceding assistant message's tool_calls
                    let toolName = "tool";
                    const prev = conv.messages[i - 1];
                    if (prev?.role === "assistant" && prev.tool_calls) {
                        const tc = prev.tool_calls.find((tc) => tc.id === m.tool_call_id);
                        if (tc) toolName = tc.function.name;
                    }
                    // Group consecutive tool results into one tools entry
                    const isDiff = m.content.includes("---") && m.content.includes("+++") && m.content.includes("@@");
                    const toolResult = isDiff
                        ? "__DIFF__" + m.content
                        : (m.content.length > 200 ? m.content.slice(0, 200) + "…" : m.content);
                    const lastDisplay = display[display.length - 1];
                    if (lastDisplay?.type === "tools") {
                        lastDisplay.activities.push({ name: toolName, result: toolResult });
                    } else {
                        display.push({ type: "tools", activities: [{ name: toolName, result: toolResult }] });
                    }
                } else if (m.role === "assistant" && m.tool_calls && !m.content.trim()) {
                    // Assistant message with only tool_calls and no text → skip display
                    continue;
                } else if (m.role === "assistant" || m.role === "user") {
                    display.push({
                        type: "chat",
                        role: m.role,
                        content: m.content,
                        tokens: m.tokens,
                        reasoning: m.reasoning,
                    });
                }
                // Skip system messages (they're the system prompt)
            }
            setMessages(display);
            addSystemMessage(`Loaded conversation \`${id}\` (${conv.messages.length} messages)`);
        },
        listConversations: listConvs,
        deleteConversation: deleteConv,
        deleteAllOtp,
        yolo,
        setYolo,
    };

    // ── Input handling ────────────────────────────────────────

    useInput((ch, key) => {
        // ── Escape: dismiss palettes / deny confirm / abort agent ──
        if (key.escape) {
            if (showModelPalette) {
                setShowModelPalette(false);
                setInput("");
                setCursorPos(0);
                return;
            }
            if (showConvoPalette) {
                setShowConvoPalette(false);
                setInput("");
                setCursorPos(0);
                return;
            }
            if (pendingConfirm) {
                pendingConfirm.resolve(false);
                return;
            }
            // Abort the running agent
            if (busy && activeGenRef.current) {
                abortRef.current = true;
                activeGenRef.current.return(undefined);
                return;
            }
            return;
        }

        // ── Ctrl+C: double-press to quit ──────────────────────────
        if (key.ctrl && ch === "c") {
            if (ctrlCPending) {
                if (ctrlCTimer.current) clearTimeout(ctrlCTimer.current);
                appContext.exit();
                return;
            }
            // First press: abort agent if running, show hint
            if (busy && activeGenRef.current) {
                abortRef.current = true;
                activeGenRef.current.return(undefined);
            }
            setCtrlCPending(true);
            ctrlCTimer.current = setTimeout(() => setCtrlCPending(false), 1500);
            return;
        }

        // ── Ctrl+O: toggle reasoning visibility ────────────────
        if (key.ctrl && ch === "o") {
            setShowReasoning((prev) => !prev);
            return;
        }

        // ── Confirmation prompt input (y/n/a) ─────────────────
        if (pendingConfirm) {
            if (ch === "y" || ch === "Y") {
                pendingConfirm.resolve(true);
                return;
            }
            if (ch === "n" || ch === "N") {
                pendingConfirm.resolve(false);
                return;
            }
            if (ch === "a" || ch === "A") {
                setYolo(true);
                pendingConfirm.resolve(true);
                return;
            }
            // Ignore all other keys during confirmation
            return;
        }

        if (busy) {
            // While busy, allow typing + submitting to queue messages
            if (key.return && !key.meta) {
                const text = input.trim();
                if (text.length > 0) {
                    messageQueue.current.push(text);
                    setInput("");
                    setCursorPos(0);
                    // Show queued message immediately in chat
                    setMessages((prev) => [
                        ...prev,
                        { type: "chat", role: "user", content: `➤ ${text}` },
                    ]);
                }
                return;
            }
            if (key.backspace || key.delete) {
                setInput((prev) => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
                setCursorPos((p) => Math.max(0, p - 1));
                return;
            }
            if (key.leftArrow) { setCursorPos((p) => Math.max(0, p - 1)); return; }
            if (key.rightArrow) { setCursorPos((p) => Math.min(input.length, p + 1)); return; }
            if (ch && !key.ctrl && !key.meta) {
                setInput((prev) => prev.slice(0, cursorPos) + ch + prev.slice(cursorPos));
                setCursorPos((p) => p + ch.length);
            }
            return;
        }

        // Ctrl+L → open conversation palette
        if (key.ctrl && ch === "l") {
            openConvoPalette();
            return;
        }

        // ── Arrow key navigation in palettes ───────
        if (showConvoPalette && convoPaletteItems.length > 0) {
            if (key.upArrow) {
                setConvoPaletteIndex((i) =>
                    i <= 0 ? Math.min(convoPaletteItems.length, 12) - 1 : i - 1,
                );
                return;
            }
            if (key.downArrow) {
                setConvoPaletteIndex((i) =>
                    i >= Math.min(convoPaletteItems.length, 12) - 1 ? 0 : i + 1,
                );
                return;
            }
            if (key.tab || key.return) {
                const selected = convoPaletteItems[convoPaletteIndex];
                if (selected) {
                    appContext.loadConversation(selected.id).catch((err) => {
                        setError(err.message);
                    });
                }
                setShowConvoPalette(false);
                setInput("");
                return;
            }
            // 'd' to delete the selected conversation
            if (ch === "d") {
                const selected = convoPaletteItems[convoPaletteIndex];
                if (selected) {
                    deleteConv(selected.id).then(() => {
                        // Refresh the list
                        listConvs().then((items) => {
                            setConvoPaletteItems(items);
                            setConvoPaletteIndex((i) => Math.min(i, Math.max(items.length - 1, 0)));
                            if (items.length === 0) setShowConvoPalette(false);
                        });
                    });
                }
                return;
            }
        }

        if (showModelPalette && filteredModels.length > 0) {
            if (key.upArrow) {
                setModelPaletteIndex((i) =>
                    i <= 0 ? filteredModels.length - 1 : i - 1,
                );
                return;
            }
            if (key.downArrow) {
                setModelPaletteIndex((i) =>
                    i >= filteredModels.length - 1 ? 0 : i + 1,
                );
                return;
            }
            if (key.tab || key.return) {
                const selected = filteredModels[modelPaletteIndex];
                if (selected) {
                    setModel(selected.model);
                    setProvider(selected.provider);
                    addSystemMessage(`Switched to **${selected.model}** (${selected.providerLabel})`);
                }
                setShowModelPalette(false);
                setInput("");
                setCursorPos(0);
                return;
            }
        }

        if (showCommandPalette && filteredCommands.length > 0) {
            if (key.upArrow) {
                setSelectedIndex((i) =>
                    i <= 0 ? filteredCommands.length - 1 : i - 1,
                );
                return;
            }
            if (key.downArrow) {
                setSelectedIndex((i) =>
                    i >= filteredCommands.length - 1 ? 0 : i + 1,
                );
                return;
            }

            // Tab to autocomplete the selected command
            if (key.tab) {
                const [cmdKey] = filteredCommands[selectedIndex] ?? [];
                if (cmdKey) {
                    setInput(`/${cmdKey}`);
                    setCursorPos(`/${cmdKey}`.length);
                }
                return;
            }
        }

        if (key.return) {
            // Alt+Enter fallback for non-Kitty terminals
            if (key.meta) {
                setInput((prev) => prev.slice(0, cursorPos) + "\n" + prev.slice(cursorPos));
                setCursorPos((p) => p + 1);
                return;
            }

            if (input.trim().length === 0) return;
            const text = input.trim();
            setInput("");
            setCursorPos(0);

            // ── Slash-command dispatch ────────────────────────
            if (text.startsWith("/")) {
                // If palette is open with a selection, use that
                const selected = showCommandPalette && filteredCommands.length > 0
                    ? filteredCommands[selectedIndex]
                    : null;

                if (selected) {
                    const [cmdKey, cmd] = selected;
                    // Special handling for /model — open model palette
                    if (cmdKey === "model") {
                        setShowModelPalette(true);
                        setInput("/model ");
                        setCursorPos("/model ".length);
                        return;
                    }
                    // Special handling for /load — open conversation palette
                    if (cmdKey === "load") {
                        openConvoPalette();
                        setInput("");
                        setCursorPos(0);
                        return;
                    }
                    cmd.action(appContext, []);
                } else {
                    // Exact match fallback (e.g. fully typed command)
                    const parts = text.slice(1).split(/\s+/);
                    const cmdKey = parts[0] ?? "";
                    const cmdArgs = parts.slice(1);
                    const cmd = commands[cmdKey];

                    if (cmd) {
                        // /model with no args → open palette
                        if (cmdKey === "model" && cmdArgs.length === 0) {
                            setShowModelPalette(true);
                            setInput("/model ");
                            setCursorPos("/model ".length);
                            return;
                        }
                        // /load with no args → open conversation palette
                        if (cmdKey === "load" && cmdArgs.length === 0) {
                            openConvoPalette();
                            setInput("");
                            setCursorPos(0);
                            return;
                        }
                        cmd.action(appContext, cmdArgs);
                    } else {
                        setError(`Unknown command: /${cmdKey}`);
                    }
                }
                return;
            }

            sendMessage(text);
            return;
        }

        if (key.backspace || key.delete) {
            if (cursorPos > 0) {
                setInput((prev) => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
                setCursorPos((p) => p - 1);
            }
            return;
        }

        // Arrow keys for cursor movement
        if (key.leftArrow) {
            setCursorPos((p) => Math.max(0, p - 1));
            return;
        }
        if (key.rightArrow) {
            setCursorPos((p) => Math.min(input.length, p + 1));
            return;
        }

        // Home / End (Ctrl+A / Ctrl+E or Home/End keys)
        if ((key.ctrl && ch === "a") || ch === "\x1b[H" || ch === "\x1b[1~") {
            setCursorPos(0);
            return;
        }
        if ((key.ctrl && ch === "e") || ch === "\x1b[F" || ch === "\x1b[4~") {
            setCursorPos(input.length);
            return;
        }

        if (ch && !key.ctrl && !key.meta) {
            setInput((prev) => prev.slice(0, cursorPos) + ch + prev.slice(cursorPos));
            setCursorPos((p) => p + ch.length);
        }
    });
    // Only render the last N messages to avoid terminal flashing on long threads
    // Limit visible messages to fit terminal height (rough estimate: ~3 lines per message)
    const termRows = process.stdout.rows ?? 40;
    const maxMessages = Math.max(5, Math.floor((termRows - 10) / 3));
    const visibleMessages = messages.slice(-maxMessages);

    return (
        <Box flexDirection="column" paddingX={2} paddingY={1}>
            {/* Chat history */}
            <Box flexDirection="column" marginY={1} paddingY={1}>
                {messages.length === 0 && !busy && (
                    <Box paddingX={4}>
                        <Text dimColor>Send a message to begin</Text>
                    </Box>
                )}
                {visibleMessages.map((msg, i) => (
                    <MessageRow key={messages.length - visibleMessages.length + i} msg={msg} showReasoning={showReasoning} />
                ))}

                {/* Tool activity badges (above streaming response) */}
                {tools.length > 0 && (
                    <Box flexDirection="column" marginY={1}>
                        {tools.map((t, i) => (
                            <ToolBadge key={i} name={t.name} args={t.args} result={t.result} />
                        ))}
                    </Box>
                )}

                {/* Confirmation prompt */}
                {pendingConfirm && (
                    <ConfirmationPrompt name={pendingConfirm.name} args={pendingConfirm.args} />
                )}

                {/* Agent status */}
                <StatusLine status={status} />
                <StatusLine status={mcpStatus} />

                {/* Streaming response (below tools) */}
                {busy && reasoningContent && (
                    <ReasoningBlock content={reasoningContent} streaming={!streamContent} />
                )}
                {busy && streamContent && (
                    <StreamingRow content={streamContent} />
                )}

                {error && <ErrorBanner message={error} />}
            </Box>

            {/* Input */}
            <InputLine value={input} cursorPos={cursorPos} disabled={busy && !input} queueMode={busy} />
            {showCommandPalette && filteredCommands.length > 0 && !showModelPalette && (
                <CommandPalette items={filteredCommands} selectedIndex={selectedIndex} />
            )}
            {showModelPalette && filteredModels.length > 0 && (
                <ModelPalette items={filteredModels} selectedIndex={modelPaletteIndex} />
            )}
            {showConvoPalette && (
                <ConversationPalette items={convoPaletteItems} selectedIndex={convoPaletteIndex} />
            )}

            {/* Status bar */}
            <Box marginTop={1} paddingX={2} justifyContent="space-between">
                <Text>
                    <Text bold color="gray">enter</Text> send{"  "}
                    <Text bold color="gray">esc</Text> stop{"  "}
                    <Text bold color="gray">alt+enter</Text> newline{"  "}
                    {ctrlCPending ? (
                        <Text bold color="red">press ctrl+c again to quit</Text>
                    ) : (
                        <><Text bold color="gray">ctrl+c</Text> quit</>
                    )}
                    {"  "}
                    <Text bold color="gray">ctrl+o</Text> verbose mode
                </Text>
                <Text dimColor>
                    {yolo ? <Text bold color="yellow">YOLO mode{" · "}</Text> : ""}
                    {model}{" · "}
                    {formatTokens(totalTokens)}{" tokens"}{" · "}
                    {mcpConnections.length > 0
                        ? `${mcpConnections.length} mcp · `
                        : ""}
                </Text>
            </Box>
        </Box>
    );
}

// ── CLI argument parsing (yargs) ───────────────────────────

async function runShow() {
    const convos = await listConvs();
    if (convos.length === 0) {
        console.log("No saved sessions.");
        return;
    }
    console.log(`\n  ${"ID".padEnd(10)} ${"Updated".padEnd(22)} ${"Model".padEnd(20)} Title`);
    console.log(`  ${"─".repeat(10)} ${"─".repeat(22)} ${"─".repeat(20)} ${"─".repeat(40)}`);
    for (const c of convos) {
        const date = new Date(c.updatedAt).toLocaleString();
        console.log(`  ${c.id.padEnd(10)} ${date.padEnd(22)} ${c.model.padEnd(20)} ${c.title.slice(0, 50)}`);
    }
    console.log();
}

async function runDelete(id: string) {
    const ok = await deleteConv(id);
    if (ok) {
        console.log(`Deleted session "${id}".`);
    } else {
        console.error(`Session "${id}" not found.`);
        process.exit(1);
    }
}

async function runTui(argv: { model?: string; provider?: string; load?: string; yolo: boolean }) {
    const connections: MCPConnection[] = [];

    for (const config of MCP_SERVER_CONFIGS) {
        try {
            process.stderr.write(`│ connecting to ${config.name}\u2026\r`);
            const conn = await connectToServer(config, (msg) => {
                process.stderr.write(`│ ${msg}\r`);
            });
            connections.push(conn);
            process.stderr.write(`│ \u2713 ${config.name} (${conn.tools.length} tools)${" ".repeat(15)}\n`);
        } catch (err: any) {
            process.stderr.write(`│ \u2717 ${config.name}: ${err.message}\n`);
        }
    }

    // Enter alternate screen buffer to prevent scroll flicker
    process.stdout.write("\x1b[?1049h");
    process.stdout.write("\x1b[H"); // Move cursor to top-left

    const inkInstance = render(
        <App
            mcpConnections={connections}
            initialModel={argv.model}
            initialProvider={argv.provider}
            initialYolo={argv.yolo}
            initialSessionId={argv.load}
        />,
        { exitOnCtrlC: false },
    );

    // Exit alternate screen buffer on cleanup
    inkInstance.waitUntilExit().then(() => {
        process.stdout.write("\x1b[?1049l");
    });
}

// ── CLI ──────────────────────────────────────────────────────

yargs(hideBin(process.argv))
    .scriptName("parallax")
    .usage("$0 [command] [options] — Agentic AI coding assistant")
    .command(
        "show",
        "List all saved sessions",
        () => { },
        () => { runShow(); },
    )
    .command(
        "delete <id>",
        "Delete a saved session",
        (y) => y.positional("id", { type: "string", demandOption: true, describe: "Session ID to delete" }),
        (argv) => { runDelete(argv.id as string); },
    )
    .command(
        "$0",
        "Start the interactive TUI",
        (y) => y
            .option("model", {
                alias: "m",
                type: "string",
                describe: "Set the model (default: from last session)",
            })
            .option("provider", {
                alias: "p",
                type: "string",
                describe: "Set the provider (default: from last session)",
            })
            .option("load", {
                alias: "l",
                type: "string",
                describe: "Load a saved session by ID",
            })
            .option("yolo", {
                alias: "y",
                type: "boolean",
                default: false,
                describe: "Start in YOLO mode (auto-confirm all tools)",
            }),
        (argv) => { runTui(argv); },
    )
    .example("$0", "Launch the TUI")
    .example("$0 show", "List saved sessions")
    .example("$0 delete a1b2c3d4", "Delete a session")
    .example("$0 --model gpt-4o -y", "Launch with GPT-4o in YOLO mode")
    .help()
    .alias("h", "help")
    .version(false)
    .strict()
    .parse();

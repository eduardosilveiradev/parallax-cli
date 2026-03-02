#!/usr/bin/env node
import React, { useState, useEffect, useRef, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import { runAgent, DEFAULT_MODEL, DEFAULT_PROVIDER, type AgentEvent, type ChatMessage } from "./agent.js";
import { getProvider } from "./providers.js";
import {
    connectToServer,
    disconnectServer,
    type MCPServerConfig,
    type MCPConnection,
} from "./mcp-client.js";
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
    result?: string;
}

type DisplayMessage =
    | { type: "chat"; role: "user" | "assistant" | "system"; content: string; tokens?: number }
    | { type: "tools"; activities: ToolActivity[] };

// ── Components ─────────────────────────────────────────────────

function Header({ model }: { model: string }) {
    return (
        <Box
            borderStyle="round"
            paddingX={0}
            paddingY={0}
            justifyContent="center"
        >
            <Text bold>Parallax</Text>
            <Text dimColor>{"  ·  "}{model}</Text>
        </Box>
    );
}

function MessageRow({ msg }: { msg: DisplayMessage }) {
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
        <Box flexDirection="column" paddingX={2} marginY={0}>
            <Box flexDirection="row">
                <Text dimColor color={isAI ? "white" : "grey"}> │ </Text>
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
            <Text dimColor>{"· "}{status}</Text>
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

function ModelPalette({
    items,
    selectedIndex,
    provider,
}: {
    items: string[];
    selectedIndex: number;
    provider: string;
}) {
    return (
        <Box paddingX={4} marginY={0} flexDirection="column">
            <Text dimColor>models from <Text bold>{provider}</Text>:</Text>
            {items.slice(0, 12).map((name, i) => {
                const selected = i === selectedIndex;
                return (
                    <Box key={name} flexDirection="row">
                        <Text color={selected ? "white" : "grey"} bold={selected} inverse={selected}>
                            {" "}{name}{" "}
                        </Text>
                    </Box>
                );
            })}
            {items.length > 12 && (
                <Text dimColor>  …and {items.length - 12} more (type to filter)</Text>
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

function ToolBadge({ name, result }: { name: string; result?: string }) {
    const display = toolDisplayName(name);
    const isDiff = result?.startsWith("__DIFF__");
    const diffContent = isDiff ? result!.slice(8) : undefined;
    const cleanResult = isDiff ? undefined : result;

    // For diffs, the DiffView already has its own header
    if (diffContent) {
        return (
            <Box paddingX={4} marginY={0} flexDirection="column">
                <DiffView raw={diffContent} />
            </Box>
        );
    }

    return (
        <Box paddingX={4} marginY={0}>
            <Text><Text color="yellow" bold>● </Text><Text bold>{display}:</Text>  <Text dimColor>{cleanResult ?? ""}</Text></Text>
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

function InputLine({ value, disabled }: { value: string; disabled: boolean }) {
    const lines = value.split("\n");
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
            {lines.map((line, i) => (
                <Box key={i} flexDirection="row">
                    <Text bold={!disabled} dimColor={disabled}>
                        {i === 0 ? "> " : "  "}
                    </Text>
                    <Text dimColor={disabled}>{line}</Text>
                    {!disabled && i === lines.length - 1 && <Text>▎</Text>}
                </Box>
            ))}
        </Box>
    );
}

// ── App ────────────────────────────────────────────────────────

function App({ mcpConnections }: { mcpConnections: MCPConnection[] }) {
    const { exit } = useApp();
    const [messages, setMessages] = useState<DisplayMessage[]>([]);
    const [input, setInput] = useState("");
    const [busy, setBusy] = useState(false);
    const [streamContent, setStreamContent] = useState("");
    const [status, setStatus] = useState<string | null>(null);
    const [mcpStatus, setMcpStatus] = useState<string | null>(null);
    const [tools, setTools] = useState<ToolActivity[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [model, setModel] = useState(DEFAULT_MODEL);
    const [provider, setProvider] = useState(DEFAULT_PROVIDER);
    const [showCommandPalette, setShowCommandPalette] = useState(false);
    const [selectedIndex, setSelectedIndex] = useState(0);

    // Load last-used model from most recent conversation on startup
    useEffect(() => {
        getLastModel().then((saved) => {
            if (saved) {
                setModel(saved.model);
                setProvider(saved.provider);
            }
        });
    }, []);

    // Model palette state
    const [availableModels, setAvailableModels] = useState<string[]>([]);
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

    // Fetch models when provider changes or model palette opens
    useEffect(() => {
        let cancelled = false;
        getProvider(provider).listModels().then((models) => {
            if (!cancelled) setAvailableModels(models);
        });
        return () => { cancelled = true; };
    }, [provider]);

    // Filtered models for the palette (filter by search term after /model )
    const filteredModels = useMemo(() => {
        if (!showModelPalette) return [];
        const match = input.match(/^\/model\s*(.*)/i);
        const query = (match?.[1] ?? "").toLowerCase();
        return availableModels.filter((m) => m.toLowerCase().includes(query));
    }, [showModelPalette, input, availableModels]);

    // Reset model palette index when filter changes
    useEffect(() => {
        setModelPaletteIndex(0);
    }, [filteredModels.length]);

    // Maintain ChatMessage history for the agent (includes system/tool msgs)
    const agentHistory = useRef<ChatMessage[]>([]);
    const [totalTokens, setTotalTokens] = useState(0);

    // Conversation persistence
    const conversationId = useRef(generateId());
    const createdAt = useRef(new Date().toISOString());

    const sendMessage = async (text: string) => {
        // Show user message immediately
        setMessages((prev) => [...prev, { type: "chat", role: "user", content: text }]);
        setBusy(true);
        setStreamContent("");
        setStatus(null);
        setMcpStatus(null);
        setTools([]);
        setError(null);

        // Track tools locally (avoids stale React state in async closure)
        let toolsAccum: ToolActivity[] = [];
        let turnTokens = 0;

        try {
            const gen = runAgent(text, agentHistory.current, mcpConnections, model, provider);
            let fullResponse = "";

            for await (const event of gen) {
                switch (event.type) {
                    case "status":
                        setStatus(event.message);
                        break;

                    case "token":
                        fullResponse += event.content;
                        setStreamContent(fullResponse);
                        setStatus(null);
                        break;

                    case "tool_start":
                        toolsAccum.push({ name: event.name });
                        setTools([...toolsAccum]);
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
                        // Persist tool badges + assistant message in correct order
                        setMessages((prev) => {
                            const next = [...prev];
                            if (toolsAccum.length > 0) {
                                next.push({ type: "tools", activities: toolsAccum });
                            }
                            if (event.fullResponse) {
                                next.push({ type: "chat", role: "assistant", content: event.fullResponse, tokens: turnTokens });
                            }
                            return next;
                        });
                        setTools([]);
                        // Use the full message history from the agent (includes tool calls/results)
                        const fullHistory = event.messages;
                        // Attach token count to the last assistant message
                        const lastMsg = fullHistory[fullHistory.length - 1];
                        if (lastMsg && lastMsg.role === "assistant") {
                            lastMsg.tokens = turnTokens;
                        }
                        agentHistory.current = fullHistory;
                        // Auto-save to disk (generate title on first exchange)
                        const isFirstExchange = fullHistory.filter((m) => m.role === "user").length === 1;
                        const titlePromise = isFirstExchange
                            ? generateTitle(fullHistory)
                            : Promise.resolve(deriveTitle(fullHistory));
                        titlePromise.then((title) =>
                            saveConversation({
                                id: conversationId.current,
                                title,
                                model,
                                provider,
                                createdAt: createdAt.current,
                                updatedAt: new Date().toISOString(),
                                messages: fullHistory,
                            }),
                        ).catch(() => { /* best-effort */ });
                        break;
                }
            }
        } catch (err: any) {
            setError(err.message ?? "unexpected error");
        } finally {
            setStreamContent("");
            setStatus(null);
            setBusy(false);
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
    };

    // ── Input handling ────────────────────────────────────────

    useInput((ch, key) => {
        if (key.escape || (key.ctrl && ch === "c")) {
            // Dismiss palettes instead of quitting
            if (showModelPalette) {
                setShowModelPalette(false);
                setInput("");
                return;
            }
            if (showConvoPalette) {
                setShowConvoPalette(false);
                setInput("");
                return;
            }
            appContext.exit();
            return;
        }

        if (busy) return;

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
                    i <= 0 ? Math.min(filteredModels.length, 12) - 1 : i - 1,
                );
                return;
            }
            if (key.downArrow) {
                setModelPaletteIndex((i) =>
                    i >= Math.min(filteredModels.length, 12) - 1 ? 0 : i + 1,
                );
                return;
            }
            if (key.tab || key.return) {
                const selected = filteredModels[modelPaletteIndex];
                if (selected) {
                    setModel(selected);
                    addSystemMessage(`Switched model to **${selected}**`);
                }
                setShowModelPalette(false);
                setInput("");
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
                if (cmdKey) setInput(`/${cmdKey}`);
                return;
            }
        }

        if (key.return) {
            // Alt+Enter fallback for non-Kitty terminals
            if (key.meta) {
                setInput((prev) => prev + "\n");
                return;
            }

            if (input.trim().length === 0) return;
            const text = input.trim();
            setInput("");

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
                        return;
                    }
                    // Special handling for /load — open conversation palette
                    if (cmdKey === "load") {
                        openConvoPalette();
                        setInput("");
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
                            return;
                        }
                        // /load with no args → open conversation palette
                        if (cmdKey === "load" && cmdArgs.length === 0) {
                            openConvoPalette();
                            setInput("");
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
            setInput((prev) => prev.slice(0, -1));
            return;
        }

        if (ch && !key.ctrl && !key.meta) {
            setInput((prev) => prev + ch);
        }
    });

    return (
        <Box flexDirection="column" paddingX={2} paddingY={1}>
            <Header model={model} />

            {/* Chat history */}
            <Box flexDirection="column" marginY={1} paddingY={1}>
                {messages.length === 0 && !busy && (
                    <Box paddingX={4}>
                        <Text dimColor>waiting for input</Text>
                    </Box>
                )}
                {messages.map((msg, i) => (
                    <MessageRow key={i} msg={msg} />
                ))}

                {/* Tool activity badges (above streaming response) */}
                {tools.length > 0 && (
                    <Box flexDirection="column" marginY={1}>
                        {tools.map((t, i) => (
                            <ToolBadge key={i} name={t.name} result={t.result} />
                        ))}
                    </Box>
                )}

                {/* Agent status */}
                <StatusLine status={status} />
                <StatusLine status={mcpStatus} />

                {/* Streaming response (below tools) */}
                {busy && streamContent && (
                    <StreamingRow content={streamContent} />
                )}

                {error && <ErrorBanner message={error} />}
            </Box>

            {/* Input */}
            <InputLine value={input} disabled={busy} />
            {showCommandPalette && filteredCommands.length > 0 && !showModelPalette && (
                <CommandPalette items={filteredCommands} selectedIndex={selectedIndex} />
            )}
            {showModelPalette && filteredModels.length > 0 && (
                <ModelPalette items={filteredModels} selectedIndex={modelPaletteIndex} provider={provider} />
            )}
            {showConvoPalette && (
                <ConversationPalette items={convoPaletteItems} selectedIndex={convoPaletteIndex} />
            )}

            {/* Status bar */}
            <Box marginTop={1} paddingX={2} justifyContent="space-between">
                <Text dimColor>
                    <Text bold dimColor>enter</Text> send{"  "}
                    <Text bold dimColor>alt+enter</Text> newline
                </Text>
                <Text dimColor>
                    {model}{" · "}
                    {"ctx: "}{formatTokens(totalTokens)}{" · "}
                    {mcpConnections.length > 0
                        ? `${mcpConnections.length} mcp · `
                        : ""}
                    <Text bold dimColor>esc</Text> quit
                </Text>
            </Box>
        </Box>
    );
}

// ── Bootstrap ────────────────────────────────────────────
// Connect to MCP servers BEFORE mounting the TUI.

async function main() {
    const connections: MCPConnection[] = [];

    for (const config of MCP_SERVER_CONFIGS) {
        try {
            process.stderr.write(`│ connecting to ${config.name}\u2026\r`);
            const conn = await connectToServer(config, (msg) => {
                process.stderr.write(`│ ${msg}\r`);
            });
            connections.push(conn);
            process.stderr.write(`│ ✓ ${config.name} (${conn.tools.length} tools)${" ".repeat(15)}\n`);
        } catch (err: any) {
            process.stderr.write(`│ ✗ ${config.name}: ${err.message}\n`);
        }
    }

    process.stderr.write(`\n`);
    render(<App mcpConnections={connections} />);
}

main();

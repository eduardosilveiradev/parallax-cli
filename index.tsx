#!/usr/bin/env node
import React, { useState, useEffect, useRef, useMemo } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import chalk from "chalk";
import { runAgent, type AgentEvent, type ChatMessage } from "./agent.js";
import {
    connectToServer,
    disconnectServer,
    type MCPServerConfig,
    type MCPConnection,
} from "./mcp-client.js";

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

// ── Config ─────────────────────────────────────────────────────

const MODEL = process.env["OLLAMA_MODEL"] ?? "cogito:14b";

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
    | { type: "chat"; role: "user" | "assistant"; content: string }
    | { type: "tools"; activities: ToolActivity[] };

// ── Components ─────────────────────────────────────────────────

function Header() {
    return (
        <Box
            borderStyle="round"
            paddingX={0}
            paddingY={0}
            justifyContent="center"
        >
            <Text bold>Parallax</Text>
            <Text dimColor>{"  ·  "}{MODEL}</Text>
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
    const rendered = useMemo(
        () => (isAI ? renderMarkdown(msg.content) : msg.content),
        [msg.content, isAI],
    );

    return (
        <Box flexDirection="row" paddingX={2} marginY={0}>
            <Text bold={isAI} dimColor={!isAI}>
                {isAI ? "  assistant " : "        you "}
            </Text>
            <Text dimColor> │ </Text>
            <Text wrap="wrap" dimColor={!isAI}>{rendered}</Text>
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
            <Text bold>{"  assistant "}</Text>
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

function ToolBadge({ name, result }: { name: string; result?: string }) {
    return (
        <Box paddingX={4} marginY={0} flexDirection="column">
            <Box>
                <Text inverse bold>{` ${name} `}</Text>
                {result && <Text dimColor>{"  "}{result}</Text>}
            </Box>
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
    return (
        <Box
            borderStyle="round"
            borderDimColor={disabled}
            paddingX={2}
            paddingY={0}
        >
            <Text bold={!disabled} dimColor={disabled}>
                {"› "}
            </Text>
            <Text dimColor={disabled}>{value}</Text>
            {!disabled && <Text>▎</Text>}
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

    // Maintain ChatMessage history for the agent (includes system/tool msgs)
    const agentHistory = useRef<ChatMessage[]>([]);

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

        try {
            const gen = runAgent(text, agentHistory.current, mcpConnections);
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

                    case "done":
                        // Persist tool badges + assistant message in correct order
                        setMessages((prev) => {
                            const next = [...prev];
                            if (toolsAccum.length > 0) {
                                next.push({ type: "tools", activities: toolsAccum });
                            }
                            if (event.fullResponse) {
                                next.push({ type: "chat", role: "assistant", content: event.fullResponse });
                            }
                            return next;
                        });
                        setTools([]);
                        agentHistory.current = [
                            ...agentHistory.current,
                            { role: "user", content: text },
                            { role: "assistant", content: event.fullResponse },
                        ];
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

    useInput((ch, key) => {
        if (key.escape || (key.ctrl && ch === "c")) {
            // Kill MCP child processes so Node can exit cleanly
            mcpConnections.forEach((c) => disconnectServer(c));
            exit();
            return;
        }

        if (busy) return;

        if (key.return) {
            if (input.trim().length === 0) return;
            const text = input.trim();
            setInput("");
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
            <Header />

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

            {/* Status bar */}
            <Box marginTop={1} paddingX={2} justifyContent="space-between">
                <Text dimColor>
                    <Text bold dimColor>enter</Text> send
                </Text>
                <Text dimColor>
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

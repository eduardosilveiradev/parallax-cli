#!/usr/bin/env node
import React, { useState, useEffect, useRef } from "react";
import { render, Box, Text, useInput, useApp } from "ink";
import { runAgent, type AgentEvent, type ChatMessage } from "./agent.js";
import {
    connectToServer,
    disconnectServer,
    type MCPServerConfig,
    type MCPConnection,
} from "./mcp-client.js";

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

interface DisplayMessage {
    role: "user" | "assistant";
    content: string;
}

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
    const isAI = msg.role === "assistant";
    return (
        <Box flexDirection="row" paddingX={2} marginY={0}>
            <Text bold={isAI} dimColor={!isAI}>
                {isAI ? "  assistant " : "        you "}
            </Text>
            <Text dimColor> │ </Text>
            <Text wrap="wrap" dimColor={!isAI}>{msg.content}</Text>
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

interface ToolActivity {
    name: string;
    result?: string;
}

function App() {
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

    // MCP connections, initialized on mount
    const mcpConns = useRef<MCPConnection[]>([]);
    const [mcpReady, setMcpReady] = useState(MCP_SERVER_CONFIGS.length === 0);

    // Connect to MCP servers on mount
    useEffect(() => {
        if (MCP_SERVER_CONFIGS.length === 0) return;

        let cancelled = false;

        (async () => {
            const connections: MCPConnection[] = [];

            for (const config of MCP_SERVER_CONFIGS) {
                if (cancelled) break;
                try {
                    const conn = await connectToServer(config, (msg) => {
                        if (!cancelled) setMcpStatus(msg);
                    });
                    connections.push(conn);
                } catch (err: any) {
                    if (!cancelled) {
                        setError(`mcp: ${config.name} — ${err.message}`);
                    }
                }
            }

            if (!cancelled) {
                mcpConns.current = connections;
                setMcpStatus(null);
                setMcpReady(true);
            }
        })();

        return () => {
            cancelled = true;
            mcpConns.current.forEach((c) => disconnectServer(c));
        };
    }, []);

    const sendMessage = async (text: string) => {
        // Show user message immediately
        setMessages((prev) => [...prev, { role: "user", content: text }]);
        setBusy(true);
        setStreamContent("");
        setStatus(null);
        setMcpStatus(null);
        setTools([]);
        setError(null);

        try {
            const gen = runAgent(text, agentHistory.current, mcpConns.current);
            let fullResponse = "";

            for await (const event of gen) {
                switch (event.type) {
                    case "status":
                        setStatus(event.message);
                        break;

                    case "token":
                        fullResponse += event.content;
                        setStreamContent(fullResponse);
                        // Clear status once tokens start flowing
                        setStatus(null);
                        break;

                    case "tool_start":
                        setTools((prev) => [...prev, { name: event.name }]);
                        break;

                    case "tool_result":
                        setTools((prev) =>
                            prev.map((t) =>
                                t.name === event.name && !t.result
                                    ? { ...t, result: event.result }
                                    : t,
                            ),
                        );
                        // Reset stream content between tool iterations
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
                        // Append final assistant message to display history
                        if (event.fullResponse) {
                            setMessages((prev) => [
                                ...prev,
                                { role: "assistant", content: event.fullResponse },
                            ]);
                        }
                        // Update agent history for multi-turn context
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
                        <Text dimColor>
                            {mcpReady
                                ? "waiting for input"
                                : "connecting to mcp servers…"}
                        </Text>
                    </Box>
                )}
                {messages.map((msg, i) => (
                    <MessageRow key={i} msg={msg} />
                ))}

                {/* Tool activity badges */}
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

                {/* Streaming response */}
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
                    {mcpConns.current.length > 0
                        ? `${mcpConns.current.length} mcp · `
                        : ""}
                    <Text bold dimColor>esc</Text> quit
                </Text>
            </Box>
        </Box>
    );
}

render(<App />);

import express from "express";
import cors from "cors";
import { runAgent, type AgentMode } from "./agent.js";
import {
    type MCPConnection,
    type MCPServerConfig,
    connectToServer,
} from "./mcp-client.js";
import {
    saveConversation,
    generateId,
    deriveTitle,
    listConversations,
    loadConversation,
    deleteConversation,
} from "./store.js";
import { getProvider, listProviders } from "./providers.js";

const app = express();
const PORT = Number(process.env.PORT) || 7001;

// ─── MCP ────────────────────────────────────────────────────
const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [
    {
        name: "filesystem",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
    },
];

let mcpConnections: MCPConnection[] = [];

// Per-session message queues (user can type while agent is processing)
const sessionQueues = new Map<string, string[]>();

app.use(cors());
app.use(express.json());

// Logging
app.use((req, _res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// Model availability
app.get("/api/check", async (req, res) => {
    const { model } = req.query;
    const provider = getProvider(req.query.provider as string || "ollama");
    console.log(provider)
    const modelInfo = await fetch(`http://localhost:11434/api/show`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: model }),
    });
    const modelInfoJson = await modelInfo.json();
    const result = { available: modelInfoJson.capabilities?.includes("thinking") ?? false, provider: provider.name };
    res.json(result);
});

// ─── Chat (SSE) ─────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
    const {
        prompt,
        history = [],
        model = "cogito:14b",
        provider = "ollama",
        think = true,
        sessionId: existingSessionId,
        mode = "default" as AgentMode,
    } = req.body;

    const convId = existingSessionId || generateId();
    const createdAt = new Date().toISOString();

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Set up the message queue for this session
    if (!sessionQueues.has(convId)) sessionQueues.set(convId, []);
    const queue = sessionQueues.get(convId)!;

    try {
        const gen = runAgent(
            prompt,
            history,
            mcpConnections,
            model,
            provider,
            () => think,
            () => {
                // Drain and return queued messages
                const msgs = [...queue];
                queue.length = 0;
                return msgs;
            },
            mode,
        );

        for await (const event of gen) {
            switch (event.type) {
                case "token":
                    send("token", { content: event.content });
                    break;
                case "reasoning":
                    send("reasoning", { content: event.content });
                    break;
                case "status":
                case "mcp_status":
                    send("status", { message: event.message });
                    break;
                case "tool_start":
                    send("tool_start", { name: event.name, args: event.args });
                    break;
                case "tool_result":
                    send("tool_result", { name: event.name, result: event.result });
                    break;
                case "subagent_start":
                    send("subagent_start", { mode: event.mode, prompt: event.prompt });
                    break;
                case "subagent_end":
                    send("subagent_end", { mode: event.mode, result: event.result });
                    break;
                case "injected_messages":
                    send("injected_messages", { messages: event.messages });
                    break;
                case "tool_confirm":
                    event.resolve(true);
                    break;
                case "usage":
                    send("usage", event.usage);
                    break;
                case "error":
                    send("error", { message: event.message });
                    break;
                case "model_info":
                    send("model_info", { model: event.model });
                    break;
                case "checkpoint": {
                    const existingC = await loadConversation(convId);
                    saveConversation({
                        id: convId,
                        title: deriveTitle(event.messages),
                        model,
                        provider,
                        createdAt,
                        updatedAt: new Date().toISOString(),
                        messages: event.messages,
                        displayData: existingC?.displayData,
                    }).catch(() => { });
                    send("checkpoint", { sessionId: convId });
                    break;
                }
                case "done": {
                    const existingD = await loadConversation(convId);
                    saveConversation({
                        id: convId,
                        title: deriveTitle(event.messages),
                        model,
                        provider,
                        createdAt,
                        updatedAt: new Date().toISOString(),
                        messages: event.messages,
                        displayData: existingD?.displayData,
                    }).catch(() => { });
                    send("done", {
                        sessionId: convId,
                        fullResponse: event.fullResponse,
                        messages: event.messages,
                    });
                    break;
                }
            }
        }
    } catch (err: unknown) {
        console.error("Chat error:", err);
        send("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
        sessionQueues.delete(convId);
        res.end();
    }
});

// Queue a message to inject into a running agent session
app.post("/api/chat/:id/queue", (req, res) => {
    const { message } = req.body;
    const queue = sessionQueues.get(req.params.id);
    if (!queue) return res.status(404).json({ error: "no active session" });
    queue.push(message);
    res.json({ ok: true, queued: queue.length });
});

// ─── Sessions ───────────────────────────────────────────────
app.get("/api/sessions", async (_req, res) => {
    res.json(await listConversations());
});

app.get("/api/sessions/:id", async (req, res) => {
    const conv = await loadConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "not found" });
    res.json(conv);
});

app.patch("/api/sessions/:id", async (req, res) => {
    const conv = await loadConversation(req.params.id);
    if (!conv) return res.status(404).json({ error: "not found" });
    if (req.body.displayData) conv.displayData = req.body.displayData;
    conv.updatedAt = new Date().toISOString();
    await saveConversation(conv);
    res.json({ ok: true });
});

app.delete("/api/sessions/:id", async (req, res) => {
    await deleteConversation(req.params.id);
    res.json({ ok: true });
});

// ─── Models ─────────────────────────────────────────────────
app.get("/api/models", async (_req, res) => {
    try {
        const providers = listProviders();
        const results = await Promise.all(
            providers.map(async (p) => {
                try {
                    const models = await p.listModels();
                    return { provider: p.name, label: p.label, models };
                } catch {
                    return { provider: p.name, label: p.label, models: [] };
                }
            })
        );
        res.json(results);
    } catch (err: unknown) {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
});


// ─── 404 ────────────────────────────────────────────────────
app.use((_req, res) => {
    res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>404 – Parallax</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #0a0a0b;
            color: #e4e4e7;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        }
        .container {
            text-align: center;
            padding: 2rem;
        }
        .code {
            font-size: 8rem;
            font-weight: 800;
            letter-spacing: -0.04em;
            background: linear-gradient(135deg, #a78bfa, #818cf8, #6366f1);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            line-height: 1;
        }
        .message {
            margin-top: 0.75rem;
            font-size: 1.25rem;
            color: #71717a;
        }
        .home {
            display: inline-block;
            margin-top: 2rem;
            padding: 0.625rem 1.5rem;
            border-radius: 0.5rem;
            background: #18181b;
            color: #a1a1aa;
            text-decoration: none;
            font-size: 0.875rem;
            border: 1px solid #27272a;
            transition: background 0.2s, color 0.2s;
        }
        .home:hover { background: #27272a; color: #e4e4e7; }
    </style>
</head>
<body>
    <div class="container">
        <div class="code">404</div>
        <p class="message">This route doesn't exist.</p>
        <a href="/" class="home">← Back to Parallax</a>
    </div>
</body>
</html>`);
});

// ─── Start ──────────────────────────────────────────────────
async function start() {
    // Connect to MCP servers
    for (const config of DEFAULT_MCP_SERVERS) {
        try {
            console.log(`⏳ Connecting to MCP server: ${config.name}...`);
            const conn = await connectToServer(config, (msg) => {
                console.log(`  MCP: ${msg}`);
            });
            mcpConnections.push(conn);
            console.log(`✓ ${config.name} (${conn.tools.length} tools)`);
        } catch (err: any) {
            console.error(`✗ ${config.name}: ${err.message}`);
        }
    }

    app.listen(PORT, () => {
        console.log(`⚡ Parallax API server running at http://localhost:${PORT}`);
        if (mcpConnections.length > 0) {
            console.log(`  MCP: ${mcpConnections.length} server(s) connected`);
        }
    });
}

start().catch((err) => {
    console.error("Failed to start:", err);
    process.exit(1);
});

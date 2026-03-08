import express from "express";
import cors from "cors";
import { runAgent } from "./agent.js";
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

    try {
        const gen = runAgent(
            prompt,
            history,
            [],
            model,
            provider,
            () => think,
            () => [],
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
                case "tool_confirm":
                    event.resolve(true);
                    break;
                case "usage":
                    send("usage", event.usage);
                    break;
                case "error":
                    send("error", { message: event.message });
                    break;
                case "checkpoint":
                    saveConversation({
                        id: convId,
                        title: deriveTitle(event.messages),
                        model,
                        provider,
                        createdAt,
                        updatedAt: new Date().toISOString(),
                        messages: event.messages,
                    }).catch(() => { });
                    send("checkpoint", { sessionId: convId });
                    break;
                case "done":
                    saveConversation({
                        id: convId,
                        title: deriveTitle(event.messages),
                        model,
                        provider,
                        createdAt,
                        updatedAt: new Date().toISOString(),
                        messages: event.messages,
                    }).catch(() => { });
                    send("done", {
                        sessionId: convId,
                        fullResponse: event.fullResponse,
                        messages: event.messages,
                    });
                    break;
            }
        }
    } catch (err: unknown) {
        console.error("Chat error:", err);
        send("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
        res.end();
    }
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


// ─── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`⚡ Parallax API server running at http://localhost:${PORT}`);
});

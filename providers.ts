// ─────────────────────────────────────────────────────────────────
//  providers.ts — Centralized LLM provider router for parallax-cli
//
//  Defines the Provider interface that every LLM backend must
//  implement, plus the built-in Ollama provider. New providers
//  (OpenAI, Anthropic, etc.) are added by implementing Provider
//  and registering in the providerRegistry.
// ─────────────────────────────────────────────────────────────────

import http from "node:http";

// ── Shared types ───────────────────────────────────────────────
//
// These types are provider-agnostic and used across the codebase.

export interface ChatMessage {
    role: "system" | "user" | "assistant" | "tool";
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    /** Completion tokens for this message (persisted, not sent to API). */
    tokens?: number;
    /** Reasoning/thinking content (persisted, not sent to API). */
    reasoning?: string;
}

export interface ToolCall {
    id?: string;
    type?: "function";
    function: {
        name: string;
        arguments: Record<string, unknown> | string;
    };
}

export interface ToolDefinition {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: {
            type: "object";
            properties: Record<string, unknown>;
            required?: string[];
        };
    };
}

// ── Provider interface ─────────────────────────────────────────

/** A single chunk emitted during streaming. */
export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
}

export interface StreamChunk {
    /** Text content token (may be empty). */
    content?: string;
    /** Reasoning/thinking content token (may be empty). */
    reasoning?: string;
    /** Tool calls emitted by the model (accumulated per chunk). */
    tool_calls?: ToolCall[];
    /** True when the model has finished generating. */
    done: boolean;
    /** Token usage stats (typically sent with the final chunk). */
    usage?: TokenUsage;
}

/** The contract every LLM provider must implement. */
export interface Provider {
    /** Human-readable provider name (e.g. "ollama", "openai"). */
    readonly name: string;
    /** Display label shown in the UI. */
    readonly label: string;

    /**
     * Stream a chat completion.
     *
     * @param messages - The conversation history
     * @param model    - Model identifier to use
     * @param tools    - Tool definitions available to the model
     */
    stream(
        messages: ChatMessage[],
        model: string,
        tools: ToolDefinition[],
    ): AsyncIterable<StreamChunk>;

    /**
     * List available models from this provider.
     * Returns an array of model name strings.
     */
    listModels(): Promise<string[]>;
}

// ── Ollama provider ────────────────────────────────────────────

const OLLAMA_HOST = process.env["OLLAMA_HOST"] ?? "localhost";
const OLLAMA_PORT = parseInt(process.env["OLLAMA_PORT"] ?? "11434", 10);

class OllamaProvider implements Provider {
    readonly name = "ollama";
    readonly label = "Ollama (local)";

    stream(
        messages: ChatMessage[],
        model: string,
        tools: ToolDefinition[],
        think: boolean = true,
    ): AsyncIterable<StreamChunk> {
        console.log("OllamaProvider.stream", model, tools);
        const payload = JSON.stringify({
            model,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            stream: true,
            think: think,
        });

        return {
            [Symbol.asyncIterator]() {
                const queue: StreamChunk[] = [];
                let resolve: ((value: IteratorResult<StreamChunk>) => void) | null =
                    null;
                let finished = false;

                function push(chunk: StreamChunk) {
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
                                    content: `[ollama error ${res.statusCode}] ${body}`,
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
                                    const json = JSON.parse(line);
                                    // Normalize Ollama's shape → StreamChunk
                                    const sc: StreamChunk = {
                                        content: json.message?.content || undefined,
                                        reasoning: json.message?.thinking || undefined,
                                        tool_calls: json.message?.tool_calls,
                                        done: json.done,
                                    };
                                    // Ollama sends token counts in the final chunk
                                    if (json.done && (json.prompt_eval_count || json.eval_count)) {
                                        sc.usage = {
                                            promptTokens: json.prompt_eval_count ?? 0,
                                            completionTokens: json.eval_count ?? 0,
                                            totalTokens: (json.prompt_eval_count ?? 0) + (json.eval_count ?? 0),
                                        };
                                    }
                                    push(sc);
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
                    push({ content: `[error] ${msg}`, done: true });
                    end();
                });

                req.write(payload);
                req.end();

                return {
                    next(): Promise<IteratorResult<StreamChunk>> {
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

    async listModels(): Promise<string[]> {
        return new Promise((resolve) => {
            const req = http.request(
                {
                    hostname: OLLAMA_HOST,
                    port: OLLAMA_PORT,
                    path: "/api/tags",
                    method: "GET",
                },
                (res) => {
                    let body = "";
                    res.on("data", (c) => (body += c));
                    res.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            const models = (data.models ?? []).map(
                                (m: any) => m.name as string,
                            );
                            resolve(models);
                        } catch {
                            resolve([]);
                        }
                    });
                },
            );
            req.on("error", () => resolve([]));
            req.end();
        });
    }
}

// ── Provider registry ──────────────────────────────────────────

export const DEFAULT_PROVIDER = "ollama";

const providerRegistry = new Map<string, Provider>();
providerRegistry.set("ollama", new OllamaProvider());

// ── HTTPS streaming helper ─────────────────────────────────────
//
// Shared infrastructure for SSE-based providers (OpenAI, Anthropic, etc.)

import https from "node:https";

/** Promise-queue backed async iterable for streaming responses. */
function createStreamQueue() {
    const queue: StreamChunk[] = [];
    let resolve: ((value: IteratorResult<StreamChunk>) => void) | null = null;
    let finished = false;

    function push(chunk: StreamChunk) {
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

    const iterator: AsyncIterableIterator<StreamChunk> = {
        [Symbol.asyncIterator]() { return iterator; },
        next(): Promise<IteratorResult<StreamChunk>> {
            if (queue.length > 0) {
                return Promise.resolve({ value: queue.shift()!, done: false });
            }
            if (finished) {
                return Promise.resolve({ value: undefined as any, done: true });
            }
            return new Promise((r) => { resolve = r; });
        },
    };

    return { push, end, iterator };
}

/** Fire an HTTPS request and call onData for each SSE `data:` line. */
function httpsSSE(
    options: https.RequestOptions,
    body: string,
    onData: (line: string) => void,
    onError: (msg: string) => void,
    onEnd: () => void,
) {
    const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
            let errBody = "";
            res.on("data", (c) => (errBody += c));
            res.on("end", () => {
                onError(`[${res.statusCode}] ${errBody}`);
                onEnd();
            });
            return;
        }

        let buffer = "";
        res.on("data", (chunk: Buffer) => {
            buffer += chunk.toString();
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const data = line.slice(6).trim();
                    if (data && data !== "[DONE]") {
                        onData(data);
                    }
                }
            }
        });
        res.on("end", onEnd);
        res.on("error", () => onEnd());
    });

    req.on("error", (err) => {
        onError(`connection error: ${err.message}`);
        onEnd();
    });
    req.write(body);
    req.end();
}

// ── OpenAI provider ────────────────────────────────────────────

class OpenAIProvider implements Provider {
    readonly name = "openai";
    readonly label = "OpenAI";

    private get apiKey() { return process.env["OPENAI_API_KEY"] ?? ""; }

    stream(
        messages: ChatMessage[],
        model: string,
        tools: ToolDefinition[],
    ): AsyncIterable<StreamChunk> {
        if (!this.apiKey) {
            const { push, end, iterator } = createStreamQueue();
            push({ content: "[error] OPENAI_API_KEY not set", done: true });
            end();
            return iterator;
        }

        const payload = JSON.stringify({
            model,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            stream: true,
        });

        const { push, end, iterator } = createStreamQueue();

        httpsSSE(
            {
                hostname: "api.openai.com",
                path: "/v1/chat/completions",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.apiKey}`,
                },
            },
            payload,
            (data) => {
                try {
                    const json = JSON.parse(data);
                    const delta = json.choices?.[0]?.delta;
                    if (!delta && !json.usage) return;
                    const tc = delta?.tool_calls?.map((t: any) => ({
                        id: t.id,
                        type: "function" as const,
                        function: { name: t.function?.name ?? "", arguments: t.function?.arguments ?? "" },
                    }));
                    const chunk: StreamChunk = {
                        content: delta?.content ?? undefined,
                        reasoning: delta?.reasoning_content ?? undefined,
                        tool_calls: tc,
                        done: json.choices?.[0]?.finish_reason != null,
                    };
                    if (json.usage) {
                        chunk.usage = {
                            promptTokens: json.usage.prompt_tokens ?? 0,
                            completionTokens: json.usage.completion_tokens ?? 0,
                            totalTokens: json.usage.total_tokens ?? 0,
                            reasoningTokens: json.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
                        };
                    }
                    push(chunk);
                } catch { /* skip */ }
            },
            (msg) => push({ content: `[openai error] ${msg}`, done: true }),
            () => end(),
        );

        return iterator;
    }

    async listModels(): Promise<string[]> {
        if (!this.apiKey) return [];
        return new Promise((resolve) => {
            const req = https.request(
                {
                    hostname: "api.openai.com",
                    path: "/v1/models",
                    method: "GET",
                    headers: { "Authorization": `Bearer ${this.apiKey}` },
                },
                (res) => {
                    let body = "";
                    res.on("data", (c) => (body += c));
                    res.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            resolve((data.data ?? [])
                                .filter((m: any) => m.id.startsWith("gpt"))
                                .map((m: any) => m.id as string)
                                .sort());
                        } catch { resolve([]); }
                    });
                },
            );
            req.on("error", () => resolve([]));
            req.end();
        });
    }
}

// ── OpenRouter provider ────────────────────────────────────────

class OpenRouterProvider implements Provider {
    readonly name = "openrouter";
    readonly label = "OpenRouter";

    private get apiKey() { return process.env["OPENROUTER_API_KEY"] ?? ""; }

    stream(
        messages: ChatMessage[],
        model: string,
        tools: ToolDefinition[],
    ): AsyncIterable<StreamChunk> {
        if (!this.apiKey) {
            const { push, end, iterator } = createStreamQueue();
            push({ content: "[error] OPENROUTER_API_KEY not set", done: true });
            end();
            return iterator;
        }

        const payload = JSON.stringify({
            model,
            messages,
            tools: tools.length > 0 ? tools : undefined,
            stream: true,
        });

        const { push, end, iterator } = createStreamQueue();

        httpsSSE(
            {
                hostname: "openrouter.ai",
                path: "/api/v1/chat/completions",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${this.apiKey}`,
                    "HTTP-Referer": "https://github.com/parallax-cli",
                    "X-Title": "Parallax CLI",
                },
            },
            payload,
            (data) => {
                try {
                    const json = JSON.parse(data);
                    const delta = json.choices?.[0]?.delta;
                    if (!delta && !json.usage) return;
                    const tc = delta?.tool_calls?.map((t: any) => ({
                        id: t.id,
                        type: "function" as const,
                        function: { name: t.function?.name ?? "", arguments: t.function?.arguments ?? "" },
                    }));
                    const chunk: StreamChunk = {
                        content: delta?.content ?? undefined,
                        reasoning: delta?.reasoning_content ?? delta?.reasoning ?? undefined,
                        tool_calls: tc,
                        done: json.choices?.[0]?.finish_reason != null,
                    };
                    if (json.usage) {
                        chunk.usage = {
                            promptTokens: json.usage.prompt_tokens ?? 0,
                            completionTokens: json.usage.completion_tokens ?? 0,
                            totalTokens: json.usage.total_tokens ?? 0,
                            reasoningTokens: json.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
                        };
                    }
                    push(chunk);
                } catch { /* skip */ }
            },
            (msg) => push({ content: `[openrouter error] ${msg}`, done: true }),
            () => end(),
        );

        return iterator;
    }

    async listModels(): Promise<string[]> {
        if (!this.apiKey) return [];
        return new Promise((resolve) => {
            const req = https.request(
                {
                    hostname: "openrouter.ai",
                    path: "/api/v1/models",
                    method: "GET",
                },
                (res) => {
                    let body = "";
                    res.on("data", (c) => (body += c));
                    res.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            resolve((data.data ?? []).map((m: any) => m.id as string).sort());
                        } catch { resolve([]); }
                    });
                },
            );
            req.on("error", () => resolve([]));
            req.end();
        });
    }
}

// ── Anthropic provider ─────────────────────────────────────────

class AnthropicProvider implements Provider {
    readonly name = "anthropic";
    readonly label = "Anthropic";

    private get apiKey() { return process.env["ANTHROPIC_API_KEY"] ?? ""; }

    stream(
        messages: ChatMessage[],
        model: string,
        tools: ToolDefinition[],
    ): AsyncIterable<StreamChunk> {
        if (!this.apiKey) {
            const { push, end, iterator } = createStreamQueue();
            push({ content: "[error] ANTHROPIC_API_KEY not set", done: true });
            end();
            return iterator;
        }

        // Anthropic separates system from messages
        const systemMsg = messages.find((m) => m.role === "system");

        // Map tool results back into user messages (Anthropic format)
        const anthropicMessages: any[] = [];
        for (const m of messages) {
            if (m.role === "system") continue;
            if (m.role === "tool") {
                anthropicMessages.push({
                    role: "user",
                    content: [{
                        type: "tool_result",
                        tool_use_id: m.tool_call_id,
                        content: m.content,
                    }],
                });
            } else if (m.role === "assistant" && m.tool_calls?.length) {
                const content: any[] = [];
                if (m.content) content.push({ type: "text", text: m.content });
                for (const tc of m.tool_calls) {
                    let input: any;
                    if (typeof tc.function.arguments === "string") {
                        try { input = JSON.parse(tc.function.arguments); } catch { input = {}; }
                    } else {
                        input = tc.function.arguments;
                    }
                    content.push({
                        type: "tool_use",
                        id: tc.id ?? `toolu_${Date.now()}`,
                        name: tc.function.name,
                        input,
                    });
                }
                anthropicMessages.push({ role: "assistant", content });
            } else {
                anthropicMessages.push({
                    role: m.role,
                    content: m.content,
                });
            }
        }

        // Map tools to Anthropic format
        const anthropicTools = tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            input_schema: t.function.parameters,
        }));

        // Enable extended thinking for models that support it (Claude 3.7+)
        const supportsThinking = /claude-(3-[7-9]|[4-9]|sonnet-4|opus-4|haiku-4)/.test(model);
        const payload = JSON.stringify({
            model,
            max_tokens: supportsThinking ? 16000 : 8192,
            system: systemMsg?.content,
            messages: anthropicMessages,
            tools: anthropicTools.length > 0 ? anthropicTools : undefined,
            stream: true,
            ...(supportsThinking ? { thinking: { type: "enabled", budget_tokens: 10000 } } : {}),
        });

        const { push, end, iterator } = createStreamQueue();

        httpsSSE(
            {
                hostname: "api.anthropic.com",
                path: "/v1/messages",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": this.apiKey,
                    "anthropic-version": "2023-06-01",
                },
            },
            payload,
            (data) => {
                try {
                    const event = JSON.parse(data);
                    switch (event.type) {
                        case "message_start":
                            if (event.message?.usage) {
                                push({
                                    done: false,
                                    usage: {
                                        promptTokens: event.message.usage.input_tokens ?? 0,
                                        completionTokens: event.message.usage.output_tokens ?? 0,
                                        totalTokens: (event.message.usage.input_tokens ?? 0) + (event.message.usage.output_tokens ?? 0),
                                    },
                                });
                            }
                            break;
                        case "content_block_delta":
                            if (event.delta?.type === "text_delta") {
                                push({ content: event.delta.text, done: false });
                            } else if (event.delta?.type === "thinking_delta") {
                                push({ reasoning: event.delta.thinking, done: false });
                            } else if (event.delta?.type === "input_json_delta") {
                                // Tool input streaming — accumulate
                            }
                            break;
                        case "content_block_start":
                            if (event.content_block?.type === "tool_use") {
                                push({
                                    tool_calls: [{
                                        id: event.content_block.id,
                                        type: "function",
                                        function: {
                                            name: event.content_block.name,
                                            arguments: "",
                                        },
                                    }],
                                    done: false,
                                });
                            }
                            break;
                        case "message_delta":
                            if (event.delta?.stop_reason) {
                                const chunk: StreamChunk = { done: true };
                                if (event.usage) {
                                    chunk.usage = {
                                        promptTokens: 0,
                                        completionTokens: event.usage.output_tokens ?? 0,
                                        totalTokens: event.usage.output_tokens ?? 0,
                                    };
                                }
                                push(chunk);
                            }
                            break;
                    }
                } catch { /* skip */ }
            },
            (msg) => push({ content: `[anthropic error] ${msg}`, done: true }),
            () => end(),
        );

        return iterator;
    }

    async listModels(): Promise<string[]> {
        // Anthropic doesn't have a public models endpoint, return known models
        return [
            "claude-opus-4-6",
            "claude-sonnet-4-6",
            "claude-haiku-4-5",
            "claude-opus-4-5-20251101",
            "claude-sonnet-4-5-20250929"
        ];
    }
}

// ── Google Gemini provider ─────────────────────────────────────

class GoogleProvider implements Provider {
    readonly name = "google";
    readonly label = "Google Gemini";

    private get apiKey() { return process.env["GOOGLE_API_KEY"] ?? ""; }

    stream(
        messages: ChatMessage[],
        model: string,
        tools: ToolDefinition[],
    ): AsyncIterable<StreamChunk> {
        if (!this.apiKey) {
            const { push, end, iterator } = createStreamQueue();
            push({ content: "[error] GOOGLE_API_KEY not set", done: true });
            end();
            return iterator;
        }

        // Convert ChatMessage[] → Gemini contents[]
        const systemInstruction = messages.find((m) => m.role === "system");
        const contents = messages
            .filter((m) => m.role !== "system")
            .map((m) => {
                if (m.role === "tool") {
                    return {
                        role: "function" as const,
                        parts: [{
                            functionResponse: {
                                name: m.tool_call_id ?? "unknown",
                                response: { result: m.content },
                            },
                        }],
                    };
                }
                return {
                    role: m.role === "assistant" ? "model" as const : "user" as const,
                    parts: [{ text: m.content }],
                };
            });

        // Convert tools to Gemini format
        const geminiTools = tools.length > 0 ? [{
            functionDeclarations: tools.map((t) => ({
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters,
            })),
        }] : undefined;

        const payload = JSON.stringify({
            contents,
            systemInstruction: systemInstruction ? { parts: [{ text: systemInstruction.content }] } : undefined,
            tools: geminiTools,
        });

        const { push, end, iterator } = createStreamQueue();

        const req = https.request(
            {
                hostname: "generativelanguage.googleapis.com",
                path: `/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`,
                method: "POST",
                headers: { "Content-Type": "application/json" },
            },
            (res) => {
                if (res.statusCode !== 200) {
                    let errBody = "";
                    res.on("data", (c) => (errBody += c));
                    res.on("end", () => {
                        push({ content: `[google error ${res.statusCode}] ${errBody}`, done: true });
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
                        if (!line.startsWith("data: ")) continue;
                        const data = line.slice(6).trim();
                        if (!data || data === "[DONE]") continue;
                        try {
                            const json = JSON.parse(data);
                            const candidate = json.candidates?.[0];
                            if (!candidate) continue;
                            const parts = candidate.content?.parts ?? [];
                            for (const part of parts) {
                                if (part.text && part.thought) {
                                    // Gemini 2.5 thinking part
                                    push({ reasoning: part.text, done: false });
                                } else if (part.text) {
                                    push({ content: part.text, done: false });
                                }
                                if (part.functionCall) {
                                    push({
                                        tool_calls: [{
                                            id: `call_${Date.now()}`,
                                            type: "function",
                                            function: {
                                                name: part.functionCall.name,
                                                arguments: part.functionCall.args ?? {},
                                            },
                                        }],
                                        done: false,
                                    });
                                }
                            }
                            if (candidate.finishReason) {
                                const chunk: StreamChunk = { done: true };
                                const um = json.usageMetadata;
                                if (um) {
                                    chunk.usage = {
                                        promptTokens: um.promptTokenCount ?? 0,
                                        completionTokens: um.candidatesTokenCount ?? 0,
                                        totalTokens: um.totalTokenCount ?? 0,
                                    };
                                }
                                push(chunk);
                            }
                        } catch { /* skip */ }
                    }
                });
                res.on("end", () => end());
                res.on("error", () => end());
            },
        );

        req.on("error", (err) => {
            push({ content: `[google error] ${err.message}`, done: true });
            end();
        });
        req.write(payload);
        req.end();

        return iterator;
    }

    async listModels(): Promise<string[]> {
        if (!this.apiKey) return [];
        return new Promise((resolve) => {
            const req = https.request(
                {
                    hostname: "generativelanguage.googleapis.com",
                    path: `/v1beta/models?key=${this.apiKey}`,
                    method: "GET",
                },
                (res) => {
                    let body = "";
                    res.on("data", (c) => (body += c));
                    res.on("end", () => {
                        try {
                            const data = JSON.parse(body);
                            resolve((data.models ?? [])
                                .map((m: any) => (m.name as string).replace("models/", ""))
                                .filter((n: string) => n.startsWith("gemini"))
                                .sort());
                        } catch { resolve([]); }
                    });
                },
            );
            req.on("error", () => resolve([]));
            req.end();
        });
    }
}

// ── Register all providers ─────────────────────────────────────

providerRegistry.set("openai", new OpenAIProvider());
providerRegistry.set("openrouter", new OpenRouterProvider());
providerRegistry.set("anthropic", new AnthropicProvider());
providerRegistry.set("google", new GoogleProvider());

/** Get a provider by name. Throws if not found. */
export function getProvider(name: string): Provider {
    const p = providerRegistry.get(name);
    if (!p) throw new Error(`unknown provider: "${name}"`);
    return p;
}

/** Get the default provider. */
export function getDefaultProvider(): Provider {
    return getProvider(DEFAULT_PROVIDER);
}

/** List all registered provider names. */
export function listProviders(): Provider[] {
    return [...providerRegistry.values()];
}

/** Register a new provider at runtime. */
export function registerProvider(provider: Provider): void {
    providerRegistry.set(provider.name, provider);
}

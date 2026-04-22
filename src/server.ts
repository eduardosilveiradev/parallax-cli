import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { ToolLoopAgent } from './agent/agent.js';
import { ProviderFactory } from './agent/provider-factory.js';
import { allTools } from './tools.js';
import { loadMcpTools } from './mcp.js';
import { loadWorkspaceSkills } from './skills.js';
import { getSystemPrompt } from './system-prompt.js';
import { fetchAvailableModels } from './agent/model-loader.js';
import { resolveToolResponse } from './tool-io.js';
import { getHistoryPath, sessionModes } from './session-state.js';

export function saveMessage(sessionId: string, blocks: any[], messages: any[], extra: Record<string, any> = {}) {
    const historyPath = getHistoryPath(sessionId);
    const existing = getHistory(sessionId);
    
    // Merge existing data to preserve threadName and other fields
    const data = {
        ...existing,
        blocks,
        messages,
        mode: extra.mode || sessionModes.get(sessionId) || existing.mode || 'agent',
        cwd: extra.cwd || existing.cwd || process.cwd(),
        ...extra
    };
    
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify(data, null, 2));
}

export function getHistory(sessionId: string) {
    const historyPath = getHistoryPath(sessionId);
    if (fs.existsSync(historyPath)) {
        const hist = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        return {
            blocks: hist.blocks || [],
            messages: hist.messages || [],
            todos: hist.todos || [],
            mode: hist.mode || 'agent',
            cwd: hist.cwd || process.cwd(),
            threadName: hist.threadName
        };
    }
    return { blocks: [], messages: [], todos: [], mode: 'agent', cwd: process.cwd(), threadName: undefined };
}

export const activeConfirmations = new Map<string, (approved: boolean) => void>();
const activeThreadNameGenerations = new Set<string>();
const THREAD_NAME_MODEL = 'ollama:qwen3:8b';
const THREAD_NAME_MAX_LENGTH = 80;
const THREAD_NAME_TIMEOUT_MS = 30000;

function getFirstUserAndAssistantTexts(blocks: any[]) {
    const firstUser = blocks.find((b: any) => b?.type === 'user' && typeof b?.text === 'string' && b.text.trim().length > 0)?.text?.trim();
    const firstAssistant = blocks.find((b: any) => b?.type === 'assistant' && typeof b?.text === 'string' && b.text.trim().length > 0)?.text?.trim();
    if (!firstUser || !firstAssistant) return null;
    return { firstUser, firstAssistant };
}

async function generateThreadName(firstUser: string, firstAssistant: string) {
    console.log(`[Title Gen] Generating title for user message: "${firstUser.substring(0, 50)}..."`);
    const provider = ProviderFactory.create(THREAD_NAME_MODEL);
    const prompt = [
        'Generate a concise conversation thread title from these two messages.',
        'Return ONLY the title text.',
        'Rules: 3-8 words, no quotes, no markdown, no trailing punctuation.',
        '',
        `First user message: ${firstUser}`,
        '',
        `First assistant message: ${firstAssistant}`
    ].join('\n');
    const messages = [provider.createUserMessage(prompt)];
    const stream = provider.stream({ messages });

    let out = '';
    try {
        for await (const part of stream) {
            if (part.type === 'text-delta') {
                out += part.text || '';
            }
        }
    } catch (e) {
        console.error('[Title Gen] Stream error:', e);
        return null;
    }

    const cleaned = out
        .split('\n')[0]
        .replace(/^["'`]+|["'`]+$/g, '')
        .replace(/[.?!,:;]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, THREAD_NAME_MAX_LENGTH);
    
    console.log(`[Title Gen] Result: "${cleaned}"`);
    return cleaned || null;
}

async function maybeGenerateAndPersistThreadName(sessionId: string, blocks: any[], messages: any[], todos: any[], cwd: string) {
    if (activeThreadNameGenerations.has(sessionId)) return;
    activeThreadNameGenerations.add(sessionId);
    try {
        const latest = getHistory(sessionId);
        if (latest.threadName) return;

        // Only generate title on the first prompt
        const userMessages = blocks.filter(b => b.type === 'user');
        if (userMessages.length !== 1) return;

        let timeoutId: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<null>((resolve) => {
            timeoutId = setTimeout(() => resolve(null), THREAD_NAME_TIMEOUT_MS);
        });

        const firstUser = blocks.find(b => b.type === 'user')?.text || "";
        const firstAssistant = blocks.find(b => b.type === 'assistant')?.text || "";
        if (!firstUser || !firstAssistant) return;

        const title = await Promise.race<string | null>([
            generateThreadName(firstUser, firstAssistant),
            timeoutPromise
        ]);
        if (timeoutId) clearTimeout(timeoutId);
        if (!title) {
            console.log(`[Title Gen] Failed or timed out.`);
            return;
        }

        saveMessage(sessionId, blocks, messages, { todos, cwd, threadName: title });
        console.log(`[Title Gen] Persisted title: "${title}" for session ${sessionId}`);
    } catch (err) {
        console.error('Thread name generation failed:', err);
    } finally {
        activeThreadNameGenerations.delete(sessionId);
    }
}

function killPortProcess(port: string | number) {
    try {
        if (process.platform === 'win32') {
            console.log(`[Startup] Checking port ${port}. My PID: ${process.pid}`);
            let output = '';
            try {
                output = execSync(`netstat -ano | findstr :${port}`).toString();
            } catch (e) {
                // This usually means findstr didn't find anything
                return;
            }

            const lines = output.split('\n');
            const pids = new Set<string>();

            for (const line of lines) {
                if (line.includes('LISTENING') && line.includes(`:${port}`)) {
                    const parts = line.trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && pid !== '0' && pid !== process.pid.toString()) {
                        pids.add(pid);
                    }
                }
            }
            
            if (pids.size === 0) {
                console.log(`[Startup] No stale processes found on port ${port}`);
            }

            for (const pid of pids) {
                console.log(`[Startup] Attempting to kill process tree for PID ${pid} on port ${port}...`);
                try {
                    // /T kills child processes as well, /F is force
                    execSync(`taskkill /F /T /PID ${pid}`);
                    console.log(`[Startup] Successfully signaled termination for ${pid}`);
                } catch (e) {
                    const msg = e instanceof Error ? e.message : String(e);
                    if (msg.includes('not found')) {
                        console.log(`[Startup] Process ${pid} already terminated.`);
                    } else {
                        console.error(`[Startup] Failed to kill process ${pid}:`, msg);
                    }
                }
            }
        } else {
            try {
                const pids = execSync(`lsof -t -i:${port}`).toString().trim().split('\n').filter(p => p.length > 0 && p !== process.pid.toString());
                for (const pid of pids) {
                    console.log(`[Startup] Killing stale daemon process ${pid} on port ${port}`);
                    execSync(`kill -9 ${pid}`);
                }
            } catch (e) {
                // Ignore if no process found
            }
        }
    } catch (e) {
        console.error('[Startup] Error in killPortProcess:', e);
    }
}

export const startServer = async (cliSessionId: string, model: string = 'gemini:gemini-3-flash-preview') => {
    const PORT = process.env.PORT || 3555;
    killPortProcess(PORT);
    
    const app = express();
    app.use(cors());
    app.use(express.json());

    app.get('/ping', (req, res) => res.json({ status: 'ok', sessionId: cliSessionId }));

    app.post('/confirm', (req, res) => {
        const { toolCallId, approve } = req.body;
        const resolve = activeConfirmations.get(toolCallId);
        if (resolve) {
            resolve(!!approve);
            activeConfirmations.delete(toolCallId);
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Confirmation for this tool call not found or already processed.' });
        }
    });

    app.post('/tool-response', (req, res) => {
        const { toolCallId, payload } = req.body || {};
        if (!toolCallId) return res.status(400).json({ error: 'Missing toolCallId' });
        const ok = resolveToolResponse(String(toolCallId), payload || {});
        if (ok) return res.json({ success: true });
        return res.status(404).json({ error: 'Tool call not found or already resolved.' });
    });

    app.get('/history/:sessionId', (req, res) => {
        const hist = getHistory(req.params.sessionId);
        const mode = hist.mode || sessionModes.get(req.params.sessionId) || 'agent';
        sessionModes.set(req.params.sessionId, mode);
        res.json({ ...hist, mode });
    });

    app.post('/mode', (req, res) => {
        const { sessionId, mode } = req.body;
        if (!sessionId || !mode) return res.status(400).json({ error: 'Missing sessionId or mode' });
        sessionModes.set(sessionId, mode);

        // Persist immediately
        const hist = getHistory(sessionId);
        saveMessage(sessionId, hist.blocks, hist.messages, { ...hist, mode });

        res.json({ success: true, mode });
    });

    app.get('/sessions', (req, res) => {
        const dir = path.join(os.homedir(), '.parallax');
        if (!fs.existsSync(dir)) {
            return res.json([{ id: cliSessionId, mtime: Date.now(), messageCount: 0 }]);
        }
        try {
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
            const sessions = files.map(f => {
                const id = f.replace('.json', '');
                const stat = fs.statSync(path.join(dir, f));
                const history = getHistory(id);
                const threadName = history.threadName;
                let lastMessage = 'Empty session';
                if (history.blocks && history.blocks.length > 0) {
                    const textBlocks = history.blocks.filter((b: any) => b.type === 'user' || (b.type === 'assistant' && b.text));
                    if (textBlocks.length > 0) {
                        lastMessage = textBlocks[textBlocks.length - 1].text || '';
                        if (lastMessage.length > 100) lastMessage = lastMessage.substring(0, 100) + '...';
                    }
                }
                return {
                    id,
                    mtime: stat.mtimeMs,
                    messageCount: history.messages?.length || 0,
                    lastMessage,
                    displayName: threadName || lastMessage,
                    threadName: threadName || null,
                    cwd: history.cwd
                };
            });
            sessions.sort((a, b) => b.mtime - a.mtime);

            res.json(sessions);
        } catch (e) {
            res.status(500).json({ error: 'Failed to list sessions' });
        }
    });

    app.post('/sessions/:sessionId/todos', (req, res) => {
        const { sessionId } = req.params;
        const { todos } = req.body;
        if (!sessionId || !todos) return res.status(400).json({ error: 'Missing sessionId or todos' });
        
        const hist = getHistory(sessionId);
        saveMessage(sessionId, hist.blocks, hist.messages, { ...hist, todos });
        res.json({ success: true, todos });
    });

    app.delete('/sessions/:id', (req, res) => {
        const id = req.params.id;
        const historyPath = getHistoryPath(id);
        if (fs.existsSync(historyPath)) {
            try {
                fs.unlinkSync(historyPath);
                res.json({ success: true });
            } catch (e) {
                res.status(500).json({ error: 'Failed to delete session' });
            }
        } else {
            res.json({ success: true });
        }
    });

    app.get('/models', async (req, res) => {
        try {
            let models = await fetchAvailableModels();
            models = models.map(m => {
                return {
                    id: m.id,
                    label: m.label.split("-")[0].charAt(0).toUpperCase() + m.label.split("-")[0].slice(1) + " " + m.label.split("-").slice(1).join(" "),
                    group: m.group,
                    provider: m.provider,
                }
            })
            res.json(models);
        } catch (e) {
            res.status(500).json({ error: 'Failed to fetch models' });
        }
    });

    app.post('/prompt', async (req, res) => {
        const { prompt, sessionId = cliSessionId || '', yolo = false, mode: reqMode, cwd: reqCwd } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

        if (reqMode && ['agent', 'plan', 'debug'].includes(reqMode)) {
            sessionModes.set(sessionId, reqMode);
        }

        console.log(`\n--- NEW PROMPT ---`);
        console.log(`[Session] ${sessionId}`);
        console.log(`[Prompt] ${prompt}`);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const sendEvent = (data: any) => {
            if (res.writableEnded) return;
            try {
                res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (err) {
                console.error("Failed to write SSE event:", err);
            }
        };


        const targetModel = req.body.model || model;
        const provider = ProviderFactory.create(targetModel);

        let { blocks, messages, todos, mode: histMode, cwd: histCwd } = getHistory(sessionId);
        const effectiveCwd = reqCwd || histCwd || process.cwd();

        const mcpTools = await loadMcpTools(effectiveCwd);
        const combinedTools = { ...allTools, ...mcpTools };

        if (!sessionModes.has(sessionId)) {
            sessionModes.set(sessionId, histMode as any);
        }

        messages.push(provider.createUserMessage(prompt));
        blocks.push({ type: 'user', id: crypto.randomUUID(), text: prompt });
        saveMessage(sessionId, blocks, messages, { todos, cwd: effectiveCwd });

        const currentMode = sessionModes.get(sessionId) || 'agent';
        let sysInstruct = getSystemPrompt();

        if (currentMode === 'plan') {
            sysInstruct = `
<planning_mode>
You are in Planning Mode. Exercise judgement on whether a user's request warrants a plan before taking action.

If you decide that a request warrants a plan, then follow this workflow:

## Phase 1: Research
- Thoroughly research the task using research tools.
- DO NOT make any source code changes or run modifying commands during this phase.

## Phase 2: Create Implementation Plan
- Create an implementation plan based on your findings.

## Phase 3: Execute
- Once approved, execute the plan cleanly and incrementally.
</planning_mode>
\n${sysInstruct}`;
        } else if (currentMode === 'debug') {
            sysInstruct = `You are a debugging assistant. Focus on finding bugs, reasoning about the state, and adding logs.\n${sysInstruct}`;
        }
        const parallaxMdPath = path.join(effectiveCwd, 'PARALLAX.md');
        if (fs.existsSync(parallaxMdPath)) {
            sysInstruct += `\n\n# Project Architecture (PARALLAX.md)\n${fs.readFileSync(parallaxMdPath, 'utf8')}`;
        }

        const wsSkills = loadWorkspaceSkills(effectiveCwd);
        if (wsSkills.length > 0) {
            sysInstruct += `\n\n# Available Skills\nYou have access to the following specialized skills.\n`;
            for (const skill of wsSkills) {
                sysInstruct += `\n${skill.frontmatter}\n`;
            }
        }

        const agent = new ToolLoopAgent({
            provider,
            tools: combinedTools,
            systemInstruction: sysInstruct,
            toolContextBase: { sessionId, cwd: effectiveCwd, todos },
            onConfirm: async (tc) => {
                if (yolo) return true;
                return new Promise<boolean>((resolve) => {
                    activeConfirmations.set(tc.id, resolve);
                });
            }
        });


        let fullAssistantText = '';
        let assistantBlockIndex = -1;
        let thinkingBlockIndex = -1;
        let currentAssistantBlockId = '';
        let currentThinkingBlockId = '';
        let thinkingStartTime: number | null = null;

        const closeThinkingBlock = () => {
            if (thinkingBlockIndex !== -1 && thinkingStartTime) {
                blocks[thinkingBlockIndex].duration = Math.ceil((Date.now() - thinkingStartTime) / 1000);
                thinkingBlockIndex = -1;
                thinkingStartTime = null;
            }
        };

        let isAborted = false;
        req.on('close', () => {
            isAborted = true;
        });

        let lastSaveTime = Date.now();
        const maybeSave = (force = false) => {
            if (force || Date.now() - lastSaveTime > 2000) {
                saveMessage(sessionId, blocks, messages, { todos, cwd: effectiveCwd });
                lastSaveTime = Date.now();
            }
        };

        try {
            const stream = agent.stream(messages);
            for await (const part of stream) {
                if (isAborted) {
                    console.log(`\n[Client Disconnected] Aborting stream early.`);
                    break;
                }
                if (part.type === 'text-delta') {
                    closeThinkingBlock();

                    // Convert Gemini provider's rate-limit warning text into a dedicated SSE event
                    // so the desktop can show a proper UI instead of plain assistant text.
                    const raw = String(part.text || '');
                    const rateLimitMatch = raw.match(/\[Rate limit exceeded \(429\)\. Auto-retrying in (\d+)\s+seconds\.\.\.\s+\(Attempt\s+(\d+)\/(\d+)\)\]/i);
                    if (rateLimitMatch) {
                        const retryAfterSeconds = Number(rateLimitMatch[1] || 10);
                        const attempt = Number(rateLimitMatch[2] || 1);
                        const maxAttempts = Number(rateLimitMatch[3] || 5);
                        sendEvent({
                            type: 'rate-limit',
                            provider: 'gemini',
                            retryAfterSeconds,
                            attempt,
                            maxAttempts,
                            message: raw.trim()
                        });
                        continue;
                    }

                    if (assistantBlockIndex === -1) {
                        currentAssistantBlockId = crypto.randomUUID();
                        assistantBlockIndex = blocks.length;
                        blocks.push({ type: 'assistant', id: currentAssistantBlockId, text: '' });
                    }

                    const textChunk = raw;
                    fullAssistantText += textChunk;
                    sendEvent({ type: 'text-delta', id: currentAssistantBlockId, text: textChunk });
                    blocks[assistantBlockIndex].text = fullAssistantText;
                    maybeSave();
                } else if (part.type === 'thinking-delta') {
                    if (thinkingBlockIndex === -1) {
                        currentThinkingBlockId = crypto.randomUUID();
                        thinkingBlockIndex = blocks.length;
                        thinkingStartTime = Date.now();
                        blocks.push({ type: 'thinking', id: currentThinkingBlockId, text: '', startTime: thinkingStartTime });
                    }

                    const thinkChunk = part.text || '';
                    sendEvent({ type: 'thinking-delta', id: currentThinkingBlockId, text: thinkChunk });
                    blocks[thinkingBlockIndex].text += thinkChunk;
                    maybeSave();
                } else if (part.type === 'tool-call') {
                    closeThinkingBlock();
                    const tcId = part.toolCallId || crypto.randomUUID();
                    console.log(`\n[Tool Call] -> ${part.toolName}`);
                    console.log(JSON.stringify(part.input, null, 2));
                    const toolName = String(part.toolName || '');
                    const requiresApproval = !!(combinedTools as any)?.[toolName]?.requiresConfirmation;
                    const awaitConfirm = !yolo && requiresApproval;
                    const awaitUserInput = toolName === 'AskQuestion';
                    const uiHint = awaitUserInput ? 'askQuestion' : undefined;
                    sendEvent({ type: 'tool-call', name: toolName, input: part.input, id: tcId, awaitConfirm, awaitUserInput, uiHint });
                    blocks.push({ type: 'tool-call', id: tcId, awaitConfirm, awaitUserInput, uiHint, call: { id: tcId, name: toolName, args: part.input, status: 'calling' } });
                    maybeSave(true);
                } else if (part.type === 'tool-result') {
                    console.log(`\n[Tool Result] <- ${part.toolCallId}`);
                    let outStr = typeof part.output === 'string' ? part.output : JSON.stringify(part.output);
                    if (outStr && outStr.length > 300) {
                        console.log(outStr.substring(0, 300) + '... (truncated)');
                    } else if (outStr) {
                        console.log(outStr);
                    }
                    sendEvent({ type: 'tool-result', id: part.toolCallId, output: part.output });
                    for (let i = blocks.length - 1; i >= 0; i--) {
                        const b = blocks[i];
                        if (b.type === 'tool-call' && (b as any).call.id === part.toolCallId) {
                            blocks[i] = { type: 'tool-call', id: b.id, call: { ...(b as any).call, status: 'done', result: part.output } };
                            
                            const toolName = (b as any).call.name;
                            const result = part.output as any;
                            if (toolName === 'SwitchMode' && result?.success) {
                                sendEvent({ type: 'mode-change', mode: result.mode });
                            }
                            if (toolName === 'TodoWrite' && result?.success && result.todos) {
                                todos = result.todos;
                                (agent as any).toolContextBase.todos = todos;
                            }
                            if (toolName === 'CreatePlan' && result?.success && result.todos) {
                                if (todos.length === 0) {
                                    todos = result.todos.map((t: any) => ({ ...t, status: 'pending' }));
                                    (agent as any).toolContextBase.todos = todos;
                                }
                            }
                            break;
                        }
                    }
                    maybeSave(true);
                } else if (part.type === 'finish-step') {
                    console.log(`\n[Finish Step]`);
                    closeThinkingBlock();
                    assistantBlockIndex = -1;
                    fullAssistantText = '';
                    sendEvent({ type: 'finish-step' });
                    maybeSave(true);
                }
            }
            saveMessage(sessionId, blocks, messages, { todos, cwd: effectiveCwd });
            console.log(`\n--- FINISHED ---`);
            sendEvent({ type: 'done', todos });
            void maybeGenerateAndPersistThreadName(sessionId, blocks, messages, todos, effectiveCwd);
            res.end();
        } catch (e: any) {
            console.error('SSE Error:', e);
            sendEvent({ type: 'error', message: e.message });
            res.end();
        }
    });

    app.listen(PORT, () => {
        if (process.argv[1] === fileURLToPath(import.meta.url)) {
            console.log(`Parallax headless daemon active on port ${PORT} (Session: ${cliSessionId})`);
        }
    });
};

import { fileURLToPath } from 'url';

const defaultSessionId = crypto.randomBytes(4).toString('hex');
console.log(`[Startup] Initializing session ${defaultSessionId}...`);
startServer(defaultSessionId).catch(err => {
    console.error("[Fatal Startup Error]:", err);
    process.exit(1);
});

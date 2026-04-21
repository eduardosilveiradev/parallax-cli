import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'node:os';
import crypto from 'node:crypto';
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
    const mode = sessionModes.get(sessionId) || 'agent';
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify({ blocks, messages, mode, ...extra }, null, 2));
}

export function getHistory(sessionId: string) {
    const historyPath = getHistoryPath(sessionId);
    if (fs.existsSync(historyPath)) {
        const hist = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        return {
            blocks: hist.blocks || [],
            messages: hist.messages || [],
            todos: hist.todos || [],
            mode: hist.mode || 'agent'
        };
    }
    return { blocks: [], messages: [], todos: [], mode: 'agent' };
}

export const activeConfirmations = new Map<string, (approved: boolean) => void>();

export const startServer = async (cliSessionId: string, model: string = 'gemini:gemini-3-flash-preview') => {
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
                let lastMessage = 'Empty session';
                if (history.blocks && history.blocks.length > 0) {
                    const textBlocks = history.blocks.filter((b: any) => b.type === 'user' || (b.type === 'assistant' && b.text));
                    if (textBlocks.length > 0) {
                        lastMessage = textBlocks[textBlocks.length - 1].text || '';
                        if (lastMessage.length > 100) lastMessage = lastMessage.substring(0, 100) + '...';
                    }
                }
                return { id, mtime: stat.mtimeMs, messageCount: history.messages?.length || 0, lastMessage };
            });
            sessions.sort((a, b) => b.mtime - a.mtime);

            // make sure the current CLI session is always returned even if it doesn't have a file yet
            if (!sessions.find(s => s.id === cliSessionId)) {
                sessions.unshift({ id: cliSessionId, mtime: Date.now(), messageCount: 0, lastMessage: 'Current UI Session' });
            }

            res.json(sessions);
        } catch (e) {
            res.status(500).json({ error: 'Failed to list sessions' });
        }
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
        const { prompt, sessionId = cliSessionId || '', yolo = false, mode: reqMode } = req.body;
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

        const mcpTools = await loadMcpTools();
        const combinedTools = { ...allTools, ...mcpTools };

        const targetModel = req.body.model || model;
        const provider = ProviderFactory.create(targetModel);

        let { blocks, messages, todos, mode: histMode } = getHistory(sessionId);
        
        if (!sessionModes.has(sessionId)) {
            sessionModes.set(sessionId, histMode as any);
        }

        messages.push(provider.createUserMessage(prompt));
        blocks.push({ type: 'user', id: crypto.randomUUID(), text: prompt });
        saveMessage(sessionId, blocks, messages, { todos });

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
        const parallaxMdPath = path.join(process.cwd(), 'PARALLAX.md');
        if (fs.existsSync(parallaxMdPath)) {
            sysInstruct += `\n\n# Project Architecture (PARALLAX.md)\n${fs.readFileSync(parallaxMdPath, 'utf8')}`;
        }

        const wsSkills = loadWorkspaceSkills(process.cwd());
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
            toolContextBase: { sessionId },
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
                        if (b.type === 'tool-call' && b.call.id === part.toolCallId) {
                            blocks[i] = { type: 'tool-call', id: b.id, call: { ...b.call, status: 'done', result: part.output } };
                            if (b.call.name === 'SwitchMode' && part.output?.success) {
                                sendEvent({ type: 'mode-change', mode: part.output.mode });
                            }
                            break;
                        }
                    }
                } else if (part.type === 'finish-step') {
                    console.log(`\n[Finish Step]`);
                    closeThinkingBlock();
                    assistantBlockIndex = -1;
                    fullAssistantText = '';
                    sendEvent({ type: 'finish-step' });
                }
            }
            saveMessage(sessionId, blocks, messages, { todos });
            console.log(`\n--- FINISHED ---`);
            sendEvent({ type: 'done', todos });
            res.end();
        } catch (e: any) {
            console.error('SSE Error:', e);
            sendEvent({ type: 'error', message: e.message });
            res.end();
        }
    });

    const PORT = process.env.PORT || 3555;
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

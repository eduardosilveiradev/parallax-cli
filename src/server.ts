import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ToolLoopAgent } from './agent/agent.js';
import { ProviderFactory } from './agent/provider-factory.js';
import { allTools } from './tools.js';
import { loadMcpTools } from './mcp.js';
import { loadWorkspaceSkills } from './skills.js';
import { getSystemPrompt } from './system-prompt.js';
import { fetchAvailableModels } from './agent/model-loader.js';

export function getHistoryPath(sessionId: string) {
    return path.join(os.homedir(), '.parallax', `${sessionId}.json`);
}

export function saveMessage(sessionId: string, blocks: any[], messages: any[]) {
    const historyPath = getHistoryPath(sessionId);
    fs.mkdirSync(path.dirname(historyPath), { recursive: true });
    fs.writeFileSync(historyPath, JSON.stringify({ blocks, messages }, null, 2));
}

export function getHistory(sessionId: string) {
    const historyPath = getHistoryPath(sessionId);
    if (!fs.existsSync(historyPath)) return { blocks: [], messages: [] };
    try {
        return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch {
        return { blocks: [], messages: [] };
    }
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

    app.get('/history/:sessionId', (req, res) => {
        res.json(getHistory(req.params.sessionId));
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
        const { prompt, sessionId = cliSessionId = '', yolo = false } = req.body;
        if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

        console.log(`\n--- NEW PROMPT ---`);
        console.log(`[Session] ${sessionId}`);
        console.log(`[Prompt] ${prompt}`);

        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const mcpTools = await loadMcpTools();
        const combinedTools = { ...allTools, ...mcpTools };

        const provider = ProviderFactory.create(model);

        let { blocks, messages } = getHistory(sessionId);

        // Add latest user input
        messages.push(provider.createUserMessage(prompt));
        blocks.push({ type: 'user', id: crypto.randomUUID(), text: prompt });
        saveMessage(sessionId, blocks, messages);

        let sysInstruct = getSystemPrompt();
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
            onConfirm: async (tc) => {
                if (yolo) return true;
                return new Promise<boolean>((resolve) => {
                    activeConfirmations.set(tc.id, resolve);
                });
            }
        });

        const sendEvent = (data: any) => {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
        };

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
                    if (assistantBlockIndex === -1) {
                        currentAssistantBlockId = crypto.randomUUID();
                        assistantBlockIndex = blocks.length;
                        blocks.push({ type: 'assistant', id: currentAssistantBlockId, text: '' });
                    }

                    const textChunk = part.text || '';
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
                    const awaitConfirm = !yolo;
                    sendEvent({ type: 'tool-call', name: part.toolName, input: part.input, id: tcId, awaitConfirm });
                    blocks.push({ type: 'tool-call', id: tcId, awaitConfirm, call: { id: tcId, name: part.toolName || '', args: part.input, status: 'calling' } });
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
            saveMessage(sessionId, blocks, messages);
            console.log(`\n--- FINISHED ---`);
            sendEvent({ type: 'done' });
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const defaultSessionId = crypto.randomBytes(4).toString('hex');
    startServer(defaultSessionId).catch(console.error);
}

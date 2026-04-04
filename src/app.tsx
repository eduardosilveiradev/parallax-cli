import React, { useState, useCallback, useEffect, useRef } from 'react';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import * as marked from 'marked';
import TerminalRenderer from 'marked-terminal';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { ToolLoopAgent } from './agent/agent.js';
import { GeminiProvider } from './agent/gemini-provider.js';
import { allTools } from './tools.js';
import type { MessageBlock, ToolCallInfo } from './agent/types.js';
import { VALID_GEMINI_MODELS } from '@google/gemini-cli-core';



marked.setOptions({ renderer: new TerminalRenderer() as any });

const MODEL = 'gemini-3-flash-preview';

const AVAILABLE_COMMANDS = [
  { cmd: '/model', desc: 'Change the current model (e.g. /model gemini-1.5-pro)' },
  { cmd: '/new', desc: 'Starts a brand new session and clears the screen' },
  { cmd: '/init', desc: 'Analyze codebase and create PARALLAX.md' },
  { cmd: '/compact', desc: 'Summarize and compress conversation history to save tokens' },
  { cmd: '/load', desc: 'Loads or switches to a historical session memory' },
  { cmd: '/commit', desc: 'Creates a commit with the current changes (model generated message)' }
];

function ListPicker({ items, label, onSelect, onCancel }: { items: { id: string; label: string; detail?: string }[], label: string, onSelect: (m: string) => void, onCancel: () => void }) {
  const [index, setIndex] = useState(0);

  useInput((_input, key) => {
    if (key.upArrow) {
      setIndex((i: number) => Math.max(0, i - 1));
    }
    if (key.downArrow) {
      setIndex((i: number) => Math.min(items.length - 1, i + 1));
    }
    if (key.return && items.length > 0) {
      onSelect(items[index].id);
    }
    if (key.escape || (key.ctrl && _input === 'c')) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column" marginTop={1} marginLeft={2}>
      <Text color="magenta" bold>{label}</Text>
      {items.map((m, i) => {
        const isSelected = i === index;
        return (
          <Box key={m.id}>
            <Text color={isSelected ? 'cyan' : 'gray'} bold={isSelected}>
              {isSelected ? '❯ ' : '  '}
              {m.label}
            </Text>
            {m.detail && (
              <Box marginLeft={2}>
                <Text dimColor italic>— "{m.detail}"</Text>
              </Box>
            )}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text dimColor>Use Up/Down arrows to navigate, Enter to select, Esc to cancel.</Text>
      </Box>
    </Box>
  );
}

export default function App({ initialPrompt }: { initialPrompt?: string } = {}) {
  const { exit } = useApp();
  const [sessionId, setSessionId] = useState(() => crypto.randomBytes(4).toString('hex'));
  const HISTORY_FILE = path.join(os.homedir(), '.parallax', `${sessionId}.json`);

  const [currentModel, setCurrentModel] = useState(MODEL);
  const [query, setQuery] = useState('');
  const [blocks, setBlocks] = useState<MessageBlock[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [toolsExpanded, setToolsExpanded] = useState(false);
  const [exitPrompted, setExitPrompted] = useState(false);
  const [isSelectingModel, setIsSelectingModel] = useState(false);
  const [isSelectingSession, setIsSelectingSession] = useState(false);
  const [availableSessions, setAvailableSessions] = useState<{ id: string; label: string; detail?: string }[]>([]);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const suppressInputHandling = useRef(false);
  const hasInitialized = useRef(false);
  const [yoloMode, setYoloMode] = useState(false);
  const yoloModeRef = useRef(yoloMode);
  useEffect(() => { yoloModeRef.current = yoloMode; }, [yoloMode]);
  const [pendingConfirm, setPendingConfirm] = useState<{ id: string; name: string; input: any; resolve: (b: boolean) => void } | null>(null);

  useEffect(() => { setCommandIndex(0); }, [query]);

  const loadSession = (id: string) => {
    try {
      const file = path.join(os.homedir(), '.parallax', `${id}.json`);
      if (fs.existsSync(file)) {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        setSessionId(id);
        setBlocks(data.blocks || []);
        setMessages(data.messages || []);
      }
      setIsSelectingSession(false);
    } catch (err: any) {
      setBlocks((prev: MessageBlock[]) => [...prev, { type: 'error', text: `Failed to load: ${err.message}` }]);
      setIsSelectingSession(false);
    }
  };

  useEffect(() => {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    if (messages.length > 0) {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify({ blocks, messages }, null, 2));
    }
  }, [blocks, messages]);

  useInput((input: string, key: any) => {
    if (key.shift && key.tab) {
      setYoloMode(v => !v);
      return;
    }

    if (pendingConfirm) {
      if (input.toLowerCase() === 'y' || key.return) {
        pendingConfirm.resolve(true);
        setPendingConfirm(null);
      } else if (input.toLowerCase() === 'n' || key.escape || (key.ctrl && input === 'c')) {
        pendingConfirm.resolve(false);
        setPendingConfirm(null);
        if (key.ctrl && input === 'c') {
          if (isStreaming && abortController) {
            abortController.abort();
            setIsStreaming(false);
          } else {
            setExitPrompted(true);
          }
        } else if (key.escape) {
          if (isStreaming && abortController) {
            abortController.abort();
            setIsStreaming(false);
          }
        }
      }
      return;
    }

    if (exitPrompted) {
      if (key.ctrl && input === 'c') {
        exit();
        let lastMsg = 'No previous messages.';
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b: any = blocks[i];
          if ((b.type === 'user' || b.type === 'assistant') && b.text) {
            const words = b.text.trim().split(/\s+/);
            lastMsg = words.slice(0, 5).join(' ') + (words.length > 5 ? '...' : '');
            break;
          }
        }
        console.log(`\n`);
        console.log("Parallax shutting down...")
        console.log(`Session ID: ${sessionId}`);
        console.log(`Last message: "${lastMsg}"`);
        console.log(`\n`);
        process.exit(0);
      } else {
        setExitPrompted(false);
      }
      return;
    }

    if (!isStreaming && !isSelectingModel && !isSelectingSession && query.startsWith('/')) {
      const filtered = AVAILABLE_COMMANDS.filter(c => c.cmd.startsWith(query.toLowerCase().split(' ')[0]));
      if (key.upArrow) {
        setCommandIndex((i: number) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setCommandIndex((i: number) => Math.min(filtered.length - 1, i + 1));
        return;
      }
      if (key.tab && filtered.length > 0) {
        setQuery(filtered[commandIndex].cmd + ' ');
        return;
      }
    }

    if (key.ctrl && typeof input === 'string') {
      suppressInputHandling.current = true;
      setTimeout(() => { suppressInputHandling.current = false; }, 50);
    }

    if (key.ctrl && input === 'o') {
      setToolsExpanded(!toolsExpanded);
    } else if (key.ctrl && input === 'c') {
      if (isStreaming && abortController) {
        abortController.abort();
        setIsStreaming(false);
      } else {
        setExitPrompted(true);
      }
    } else if (key.escape) {
      if (isStreaming && abortController) {
        abortController.abort();
        setIsStreaming(false);
      }
    }
  });

  const handleSubmit = useCallback(
    async (txt: string) => {
      if (!txt.trim() || isStreaming) return;

      let cmd = txt.trim().toLowerCase();
      let parts = txt.trim().split(/\s+/);
      let args = parts.slice(1);
      let sendUserText = txt;
      let displayUserText = txt;

      setQuery('');

      if (cmd.startsWith('/')) {
        let command = parts[0].toLowerCase();

        const filtered = AVAILABLE_COMMANDS.filter(c => c.cmd.startsWith(command));
        if (filtered.length > 0 && commandIndex < filtered.length && command !== filtered[commandIndex].cmd) {
          command = filtered[commandIndex].cmd;
        }

        if (command === '/') {
          return; // Ignore isolated slashes
        }
        if (command === '/model') {
          if (args[0]) {
            setCurrentModel(args[0]);
            setBlocks((prev: MessageBlock[]) => [...prev, { type: 'assistant', text: `Model changed to ${args[0]}` }]);
          } else {
            setIsSelectingModel(true);
          }
          return;
        } else if (command === '/new') {
          const freshId = crypto.randomBytes(4).toString('hex');
          setSessionId(freshId);
          setBlocks([{ type: 'assistant', text: `Created new session: ${freshId}` }]);
          setMessages([]);
          return;
        } else if (command === '/init') {
          displayUserText = '/init';
          sendUserText = "CRITICAL INSTRUCTION: Analyze the entire codebase in the current directory. Generate a 70-120 line comprehensive description of the codebase including architectural details, and write it to 'PARALLAX.md'. This file will be used as the agent's system prompt on subsequent initializations.";
        } else if (command === '/commit') {
          displayUserText = '/commit';
          sendUserText = "CRITICAL INSTRUCTION: Analyze the changes made in this session. Generate a commit message for the current changes.";
        } else if (command === '/compact') {
          const prompt = "CRITICAL INSTRUCTION: Provide an in-depth, highly comprehensive summary of our ENTIRE conversation history up to this point. Include all relevant technical context, code paths, goals, and decisions. This summary will be used to replace our entire context window to save tokens, so ensure no critical information is lost.";
          setBlocks((prev: MessageBlock[]) => [...prev, { type: 'user', text: '/compact' }, { type: 'assistant', text: '' }]);

          const provider = new GeminiProvider(currentModel);
          const newMessages = [...messages, provider.createUserMessage(prompt)];
          setMessages(newMessages); // Set temporarily so stream can evaluate it
          setIsStreaming(true);

          setTimeout(async () => {
            let fullText = '';
            try {
              const compactAgent = new ToolLoopAgent({ provider, tools: allTools, systemInstruction: "You are a coding assistant." });
              const stream = compactAgent.stream(newMessages);
              for await (const part of stream) {
                if (part.type === 'text-delta') {
                  fullText += part.text;
                  setBlocks((prev: MessageBlock[]) => {
                    const next = [...prev];
                    const last = next[next.length - 1];
                    if (last.type === 'assistant') last.text = fullText;
                    return next;
                  });
                }
              }

              // Done! Nuke the context
              setBlocks([{ type: 'assistant', text: `*[History Compacted]*\n\n${fullText}` }]);
              setMessages([
                provider.createUserMessage("Here is the comprehensive summary of our previous conversation up to this point:\n\n" + fullText),
                { role: 'model', parts: [{ text: "Understood. I have fully internalized this historical context and am ready to proceed with your next instructions." }] } as any
              ]);
            } catch (err: any) {
              setBlocks((prev: MessageBlock[]) => [...prev, { type: 'error', text: `Compact failed: ${err.message}` }]);
            } finally {
              setIsStreaming(false);
            }
          }, 0);
          return;
        } else if (command === '/load') {
          if (!args[0]) {
            try {
              const dir = path.join(os.homedir(), '.parallax');
              if (fs.existsSync(dir)) {
                let items = fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => {
                  const id = f.replace('.json', '');
                  let detail = '';
                  try {
                    const filePath = path.join(dir, f);
                    const stat = fs.statSync(filePath);
                    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                    if (!data.messages || data.messages.length === 0) {
                      try { fs.unlinkSync(filePath); } catch { } // Cleanup empty sessions
                      return null;
                    }
                    const blks = data.blocks || [];
                    for (let i = blks.length - 1; i >= 0; i--) {
                      if (blks[i].type === 'user' || blks[i].type === 'assistant') {
                        let text = blks[i].text.split('\n')[0];
                        if (text.length > 55) text = text.slice(0, 55) + '...';
                        detail = text.trim();
                        break;
                      }
                    }
                    const dateStr = new Date(stat.mtimeMs).toLocaleString();
                    return { id, label: `${id}  [${dateStr}]`, detail, mtimeMs: stat.mtimeMs };
                  } catch {
                    return null;
                  }
                }).filter(Boolean) as { id: string; label: string; detail: string; mtimeMs?: number }[];

                items.sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));

                if (items.length === 0) items = [{ id: sessionId, label: `${sessionId}  [New]`, detail: '' }];
                setAvailableSessions(items);
                setIsSelectingSession(true);
              }
            } catch { }
            return;
          }
          loadSession(args[0]);
          return;
        } else if (command === '/help') {
          const helpText = AVAILABLE_COMMANDS.map(c => `**${c.cmd}** - ${c.desc}`).join('\n');
          setBlocks((prev: MessageBlock[]) => [...prev, { type: 'assistant', text: helpText }]);
          return;
        } else {
          setBlocks((prev: MessageBlock[]) => [...prev, { type: 'error', text: `Unknown command: ${command}` }]);
          return;
        }
      }

      setBlocks((prev: MessageBlock[]) => [...prev, { type: 'user', text: displayUserText }]);

      const provider = new GeminiProvider(currentModel);
      const agent = new ToolLoopAgent({
        provider,
        tools: allTools,
        systemInstruction: `You are a coding assistant.\nAlways respond in the users language.\nAlways use tools proactively.\nWhen reading/listing files do NOT use bash commands. USE YOUR TOOLS.\nYou are in a terminal environment, not a GUI, this means you should avoid markdown at all costs.`,
        onConfirm: async (tc) => {
          if (yoloModeRef.current) return true;
          return new Promise<boolean>((resolve) => {
            setPendingConfirm({ ...tc, resolve });
          });
        }
      });

      const newMessages = [...messages, provider.createUserMessage(sendUserText)];
      setMessages(newMessages);
      setIsStreaming(true);
      const ac = new AbortController();
      setAbortController(ac);

      let fullText = '';
      const toolCalls: ToolCallInfo[] = [];
      let assistantBlockIndex = -1;
      let toolBlockIndex = -1;

      try {
        const stream = agent.stream(newMessages);
        for await (const part of stream) {
          if (ac.signal.aborted) break;

          if (part.type === 'text-delta') {
            fullText += part.text;
            const currentText = fullText;
            setBlocks((prev) => {
              let updated = [...prev];
              if (assistantBlockIndex === -1) {
                assistantBlockIndex = updated.length;
                updated.push({ type: 'assistant', text: currentText });
              } else {
                updated[assistantBlockIndex] = { type: 'assistant', text: currentText };
              }
              return updated;
            });
          } else if (part.type === 'tool-call') {
            const tc: ToolCallInfo = {
              id: part.toolCallId || '',
              name: part.toolName || '',
              args: part.input as Record<string, unknown>,
              status: 'calling',
            };
            toolCalls.push(tc);

            setBlocks((prev) => {
              let updated = [...prev];
              if (toolBlockIndex === -1) {
                if (assistantBlockIndex !== -1) {
                  toolBlockIndex = assistantBlockIndex;
                  assistantBlockIndex++;
                  updated.splice(toolBlockIndex, 0, { type: 'tool', calls: [...toolCalls] });
                } else {
                  toolBlockIndex = updated.length;
                  updated.push({ type: 'tool', calls: [...toolCalls] });
                }
              } else {
                updated[toolBlockIndex] = { type: 'tool', calls: [...toolCalls] };
              }
              return updated;
            });
          } else if (part.type === 'tool-result') {
            const existing = toolCalls.find((t) => t.id === part.toolCallId);
            if (existing) {
              existing.status = 'done';
              existing.result = part.output;
              setBlocks((prev: MessageBlock[]) => {
                let updated = [...prev];
                if (toolBlockIndex !== -1) {
                  updated[toolBlockIndex] = { type: 'tool', calls: [...toolCalls] };
                }
                return updated;
              });
            }
          }
        }
        if (!ac.signal.aborted) setMessages([...newMessages]);
      } catch (err: any) {
        setBlocks((prev: MessageBlock[]) => [...prev, { type: 'error', text: err?.message || String(err) }]);
      } finally {
        setIsStreaming(false);
        setAbortController(null);
      }
    },
    [messages, isStreaming, currentModel, commandIndex]
  );

  useEffect(() => {
    if (initialPrompt && !hasInitialized.current) {
      hasInitialized.current = true;
      handleSubmit(initialPrompt);
    }
  }, [initialPrompt, handleSubmit]);

  return (
    <Box flexDirection="column" padding={1} marginLeft={1}>
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>
          <Text color="cyan" bold>⚡ Parallax</Text>
        </Text>
        <Text dimColor>Type a message to start.</Text>
      </Box>

      {blocks.map((block: MessageBlock, i: number) => {
        if (block.type === 'user') return <Box key={i}><Text color="green" bold>❯ </Text><Text>{block.text}</Text></Box>;
        if (block.type === 'error') return <Box key={i}><Text color="red">✖ Error: {block.text}</Text></Box>;
        if (block.type === 'assistant') {
          return <Box key={i} marginLeft={2}><Text>{(marked.parse(block.text) as string).trim() || block.text}</Text></Box>;
        }
        if (block.type === 'tool') {
          if (!toolsExpanded && !isStreaming) return <Box key={i} marginLeft={2}><Text dimColor>▶ {block.calls.length} tools (Ctrl+O to expand)</Text></Box>;
          return (
            <Box key={i} marginLeft={2} flexDirection="column">
              <Text dimColor>▼ {block.calls.length} tools</Text>
              {block.calls.map((tc: ToolCallInfo) => (
                <Box key={tc.id} flexDirection="column" marginLeft={2}>
                  <Box>
                    {tc.status === 'calling' ? <Text color="yellow"><Spinner type="dots" /> </Text> : <Text color="green">✔ </Text>}
                    <Text color="cyan">{tc.name}</Text>
                    {tc.args && Object.keys(tc.args).length > 0 && (
                      <Text dimColor>
                        {' '}{JSON.stringify(tc.args).length > 200 ? JSON.stringify(tc.args).slice(0, 200) + '...' : JSON.stringify(tc.args)}
                      </Text>
                    )}
                  </Box>
                  {tc.status === 'done' && tc.result !== undefined && (
                    <Box marginLeft={4}><Text dimColor wrap="truncate-end">→ {JSON.stringify(tc.result).slice(0, 100)}</Text></Box>
                  )}
                </Box>
              ))}
            </Box>
          );
        }
        return null;
      })}

      {isStreaming && !pendingConfirm && (
        <Box marginLeft={2}><Text color="yellow"><Spinner type="dots" /> Working...</Text></Box>
      )}

      {pendingConfirm && (
        <Box marginTop={1} marginLeft={2} flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text color="yellow" bold>⚠ Agent wants to execute: {pendingConfirm.name}</Text>
          <Text dimColor>{JSON.stringify(pendingConfirm.input)}</Text>
          <Box marginTop={1}>
            <Text>Allow execution? <Text color="green" bold>[Y/Enter] Yes</Text> <Text color="red" bold>[N/Esc] No</Text></Text>
          </Box>
        </Box>
      )}

      {!isStreaming && query.startsWith('/') && !isSelectingModel && !isSelectingSession && (
        <Box flexDirection="column" marginTop={1} paddingX={1} borderStyle="round" borderColor="blue">
          {AVAILABLE_COMMANDS.filter(c => c.cmd.startsWith(query.toLowerCase().split(' ')[0])).map((c, idx) => {
            const isSelected = idx === commandIndex;
            return (
              <Box key={c.cmd} flexDirection="row">
                <Box width={14}>
                  <Text color={isSelected ? "cyan" : "yellow"} bold={isSelected}>
                    {isSelected ? '❯ ' : '  '}{c.cmd}
                  </Text>
                </Box>
                <Text dimColor>{c.desc}</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {isSelectingModel && (
        <ListPicker
          items={Array.from(VALID_GEMINI_MODELS as Set<string>).map((m) => ({ id: m, label: m }))}
          label="Select a Gemini Model:"
          onSelect={(m) => { setCurrentModel(m); setIsSelectingModel(false); }}
          onCancel={() => setIsSelectingModel(false)}
        />
      )}

      {isSelectingSession && (
        <ListPicker
          items={availableSessions}
          label="Select a historical session:"
          onSelect={(id) => loadSession(id)}
          onCancel={() => setIsSelectingSession(false)}
        />
      )}

      {!isStreaming && !isSelectingModel && !isSelectingSession && (
        <Box marginTop={1}>
          <Text color="cyan" bold>❯ </Text>
          <TextInput
            value={query}
            onChange={(val) => {
              if (suppressInputHandling.current) {
                suppressInputHandling.current = false;
                return;
              }
              setQuery(val);
            }}
            onSubmit={handleSubmit}
          />
        </Box>
      )}

      <Box marginTop={1} flexDirection="row" justifyContent="space-between">
        {exitPrompted ? <Text color="red" bold>Press Ctrl+C again to exit.</Text> : <Text dimColor>Ctrl+C - Exit {isStreaming ? '| Esc - Stop' : ''}</Text>}
        <Text dimColor>
          Ctrl+O - Toggle verbosity | Shift+Tab - YOLO {yoloMode ? <Text color="red" bold>ON</Text> : 'OFF'}
        </Text>
      </Box>

      <Box flexDirection="row" justifyContent="space-between">
        <Box flexDirection="row">
          <Text dimColor>Model: {currentModel}</Text>
        </Box>
        <Text dimColor>
          Context: {messages.length} msgs (~{Math.floor(blocks.reduce((acc: number, b: any) => acc + (b.text?.length || 0), 0) / 4 + messages.reduce((acc: number, m: any) => acc + JSON.stringify(m).length, 0) / 4).toLocaleString()} tokens)
        </Text>
      </Box>
    </Box>
  );
}

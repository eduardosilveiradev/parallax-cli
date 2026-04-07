#!/usr/bin/env node
import { applyPatch } from './patch-console.js';
import React from 'react';
import { render } from 'ink';
import App from './app.js';
import { startIpcServer } from './ipc.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'node:crypto';
import { ToolLoopAgent } from './agent/agent.js';
import { ProviderFactory } from './agent/provider-factory.js';
import { allTools } from './tools.js';
import { loadMcpTools } from './mcp.js';
import { loadWorkspaceSkills } from './skills.js';
import * as readline from 'readline/promises';

const args = process.argv.slice(2);
const isIpc = args.includes('--ipc');
const isYolo = args.includes('--yolo');
const isVerbose = args.includes('--verbose');
const isJson = args.includes('--json');
const isRepl = args.includes('--repl');

let sessionIdOpt: string | undefined = undefined;
if (args.includes('-s')) {
  sessionIdOpt = args[args.indexOf('-s') + 1];
} else if (args.includes('--session')) {
  sessionIdOpt = args[args.indexOf('--session') + 1];
}

const initialPrompt = args.filter((a, i) => {
  if (['--ipc', '--yolo', '--verbose', '--json', '--repl', '-s', '--session'].includes(a)) return false;
  if (i > 0 && ['-s', '--session'].includes(args[i - 1])) return false;
  return true;
}).join(' ');

let exitInfo: { sessionId: string, lastMsg: string, killedCount: number } | null = null;

async function start() {
  if (isIpc) {
    startIpcServer();
  } else if (initialPrompt) {
    // HEADLESS MODE
    const currentModel = 'gemini:gemini-3-flash-preview';
    const provider = ProviderFactory.create(currentModel);

    const wsSkills = loadWorkspaceSkills(process.cwd());
    const loadSkillTool = {
      description: 'Load the full contents of a SKILL.md file for a specific skill. Call this if you need to read the full instructions for an advertised skill.',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name of the skill to load' } },
        required: ['name']
      },
      execute: async (toolArgs: any) => {
        const skill = wsSkills.find(s => s.name === toolArgs.name);
        if (!skill) return { error: `Skill ${toolArgs.name} not found.` };
        return { content: fs.readFileSync(skill.filePath, 'utf8') };
      }
    };

    const mcpTools = await loadMcpTools();
    const combinedTools = { ...allTools, loadSkill: loadSkillTool, ...mcpTools };

    let sysInstruct = 'You are a coding assistant.\nAlways respond in the users language.\nAlways use tools proactively.\nWhen reading/listing files do NOT use bash commands. USE YOUR TOOLS.\nYou are in a terminal environment, not a GUI, this means you should avoid markdown at all costs.';

    const parallaxMdPath = path.join(process.cwd(), 'PARALLAX.md');
    if (fs.existsSync(parallaxMdPath)) {
      sysInstruct += `\n\n# Project Architecture (PARALLAX.md)\n${fs.readFileSync(parallaxMdPath, 'utf8')}`;
    }

    if (wsSkills.length > 0) {
      sysInstruct += `\n\n# Available Skills\nYou have access to the following specialized skills. To use them, call the \`loadSkill\` tool with the name of the skill to retrieve its full instructions.\n`;
      for (const skill of wsSkills) {
        sysInstruct += `\n${skill.frontmatter}\n`;
      }
    }

    const agent = new ToolLoopAgent({
      provider,
      tools: combinedTools,
      systemInstruction: sysInstruct,
      onConfirm: async () => true // YOLO
    });

    let blocks: any[] = [];
    let messages: any[] = [];
    const sessionId = sessionIdOpt || crypto.randomBytes(4).toString('hex');
    const HISTORY_FILE = path.join(os.homedir(), '.parallax', `${sessionId}.json`);

    if (sessionIdOpt && fs.existsSync(HISTORY_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        blocks = data.blocks || [];
        messages = data.messages || [];
      } catch (err) {}
    }

    const sendUserText = initialPrompt;
    messages = [...messages, provider.createUserMessage(sendUserText)];
    blocks.push({ type: 'user', id: crypto.randomUUID(), text: sendUserText });

    let fullText = '';
    let thinkingBlockIndex = -1;
    let assistantBlockIndex = -1;

    try {
      const stream = agent.stream(messages);
      for await (const part of stream) {
        if (part.type === 'text-delta') {
          const textChunk = part.text || '';
          fullText += textChunk;
          if (!isJson) {
            process.stdout.write(textChunk);
          }
          if (assistantBlockIndex === -1) {
            assistantBlockIndex = blocks.length;
            blocks.push({ type: 'assistant', id: crypto.randomUUID(), text: fullText });
          } else {
            blocks[assistantBlockIndex].text = fullText;
          }
        } else if (part.type === 'thinking-delta') {
          const thinkChunk = part.text || '';
          if (thinkingBlockIndex === -1) {
            thinkingBlockIndex = blocks.length;
            blocks.push({ type: 'thinking', id: crypto.randomUUID(), text: thinkChunk });
          } else {
            blocks[thinkingBlockIndex].text += thinkChunk;
          }
        } else if (part.type === 'tool-call') {
          blocks.push({ type: 'tool-call', id: part.toolCallId || crypto.randomUUID(), call: { id: part.toolCallId || crypto.randomUUID(), name: part.toolName || '', args: part.input, status: 'calling' } });
        } else if (part.type === 'tool-result') {
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (b.type === 'tool-call' && b.call.id === part.toolCallId) {
              blocks[i] = { type: 'tool-call', id: b.id, call: { ...b.call, status: 'done', result: part.output } };
              break;
            }
          }
        } else if (part.type === 'finish-step') {
           thinkingBlockIndex = -1;
           assistantBlockIndex = -1;
           fullText = ''; // ready for possible next text block in the same turn (e.g. after tool use)
        }
      }

      if (!isJson) {
        process.stdout.write('\n');
      } else {
        process.stdout.write(JSON.stringify(blocks, null, 2) + '\n');
      }

      // the agent.stream(messages) successfully mutated the 'messages' array to include what it produced.
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      fs.writeFileSync(HISTORY_FILE, JSON.stringify({ blocks, messages }, null, 2));

    } catch (err: any) {
      if (!isJson) {
        console.error(`\nError: ${err.message}`);
      } else {
        process.stdout.write(JSON.stringify({ error: err.message, blocks }, null, 2) + '\n');
      }
      process.exit(1);
    }
    process.exit(0);

  } else if (isRepl) {
    // REPL MODE
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const currentModel = 'gemini:gemini-3-flash-preview';
    const provider = ProviderFactory.create(currentModel);

    const wsSkills = loadWorkspaceSkills(process.cwd());
    const loadSkillTool = {
      description: 'Load the full contents of a SKILL.md file for a specific skill. Call this if you need to read the full instructions for an advertised skill.',
      requiresConfirmation: false,
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name of the skill to load' } },
        required: ['name']
      },
      execute: async (toolArgs: any) => {
        const skill = wsSkills.find(s => s.name === toolArgs.name);
        if (!skill) return { error: `Skill ${toolArgs.name} not found.` };
        return { content: fs.readFileSync(skill.filePath, 'utf8') };
      }
    };

    const mcpTools = await loadMcpTools();
    const combinedTools = { ...allTools, loadSkill: loadSkillTool, ...mcpTools };

    let sysInstruct = 'You are a coding assistant.\nAlways respond in the users language.\nAlways use tools proactively.\nWhen reading/listing files do NOT use bash commands. USE YOUR TOOLS.\nYou are in a terminal environment, not a GUI, this means you should avoid markdown at all costs.';

    const parallaxMdPath = path.join(process.cwd(), 'PARALLAX.md');
    if (fs.existsSync(parallaxMdPath)) {
      sysInstruct += `\n\n# Project Architecture (PARALLAX.md)\n${fs.readFileSync(parallaxMdPath, 'utf8')}`;
    }

    if (wsSkills.length > 0) {
      sysInstruct += `\n\n# Available Skills\nYou have access to the following specialized skills. To use them, call the \`loadSkill\` tool with the name of the skill to retrieve its full instructions.\n`;
      for (const skill of wsSkills) {
        sysInstruct += `\n${skill.frontmatter}\n`;
      }
    }

    const agent = new ToolLoopAgent({
      provider,
      tools: combinedTools,
      systemInstruction: sysInstruct,
      onConfirm: async (tc) => {
        if (isYolo) return true;
        const answer = await rl.question(`\n[Confirm] Execute tool '${tc.name}'? [Y/n]: `);
        return answer.toLowerCase() === 'y' || answer === '';
      }
    });

    let blocks: any[] = [];
    let messages: any[] = [];
    const sessionId = sessionIdOpt || crypto.randomBytes(4).toString('hex');
    const HISTORY_FILE = path.join(os.homedir(), '.parallax', `${sessionId}.json`);

    if (sessionIdOpt && fs.existsSync(HISTORY_FILE)) {
      try {
        const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        blocks = data.blocks || [];
        messages = data.messages || [];
      } catch (err) {}
    }

    console.log(`⚡ Parallax REPL (Session: ${sessionId})`);
    console.log(`Model: ${currentModel} | YOLO: ${isYolo ? 'ON' : 'OFF'}\nType your message below. Press Ctrl+C to exit.\n`);

    rl.on('SIGINT', () => {
      console.log('\nExiting Parallax REPL...');
      process.exit(0);
    });

    rl.on('close', () => {
      console.log('\nInput stream closed. Exiting Parallax REPL...');
      process.exit(0);
    });

    while (true) {
      const answer = await rl.question('❯ ');
      if (!answer.trim()) continue;

      messages = [...messages, provider.createUserMessage(answer)];
      blocks.push({ type: 'user', id: crypto.randomUUID(), text: answer });

      let fullText = '';
      let thinkingBlockIndex = -1;
      let assistantBlockIndex = -1;

      try {
        const stream = agent.stream(messages);
        for await (const part of stream) {
          if (part.type === 'text-delta') {
            const textChunk = part.text || '';
            fullText += textChunk;
            process.stdout.write(textChunk);
            if (assistantBlockIndex === -1) {
              assistantBlockIndex = blocks.length;
              blocks.push({ type: 'assistant', id: crypto.randomUUID(), text: fullText });
            } else {
              blocks[assistantBlockIndex].text = fullText;
            }
          } else if (part.type === 'thinking-delta') {
            const thinkChunk = part.text || '';
            process.stdout.write(`\x1b[90m${thinkChunk}\x1b[0m`);
            if (thinkingBlockIndex === -1) {
              thinkingBlockIndex = blocks.length;
              blocks.push({ type: 'thinking', id: crypto.randomUUID(), text: thinkChunk });
            } else {
              blocks[thinkingBlockIndex].text += thinkChunk;
            }
          } else if (part.type === 'tool-call') {
            const tcId = part.toolCallId || crypto.randomUUID();
            console.log(`\n[Tool] Running ${part.toolName}...`);
            blocks.push({ type: 'tool-call', id: tcId, call: { id: tcId, name: part.toolName || '', args: part.input, status: 'calling' } });
          } else if (part.type === 'tool-result') {
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i];
              if (b.type === 'tool-call' && b.call.id === part.toolCallId) {
                blocks[i] = { type: 'tool-call', id: b.id, call: { ...b.call, status: 'done', result: part.output } };
                break;
              }
            }
          } else if (part.type === 'finish-step') {
            thinkingBlockIndex = -1;
            assistantBlockIndex = -1;
            fullText = ''; // Next text-delta starts fresh segment
          }
        }
        
        process.stdout.write('\n\n');
        fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
        fs.writeFileSync(HISTORY_FILE, JSON.stringify({ blocks, messages }, null, 2));
      } catch (err: any) {
        console.error(`\nError: ${err.message}\n`);
      }
    }

  } else {
    // INTERACTIVE MODE
    applyPatch();
    const instance = render(
      <App initialPrompt={initialPrompt} initialSessionId={sessionIdOpt} initialYolo={isYolo} initialVerbose={isVerbose} onExitCb={(info) => { exitInfo = info; }} />,
      { exitOnCtrlC: false }
    );

    await instance.waitUntilExit();

    try { instance.cleanup(); } catch (e) { }

    if (exitInfo) {
      setTimeout(() => {
        process.stdout.write(`\n`);
        process.stdout.write("Parallax shutting down...\n");
        if (exitInfo!.lastMsg !== "No previous messages.") {
          process.stdout.write(`Session ID: ${exitInfo!.sessionId}\n`);
          process.stdout.write(`Last message: "${exitInfo!.lastMsg}"\n`);
        }
        process.stdout.write(`\n`);
        if (exitInfo!.killedCount > 0) {
          process.stdout.write(`Forcefully terminated ${exitInfo!.killedCount} background process(es).\n`);
        }
        process.exit(0);
      }, 50);
    } else {
      process.exit(0);
    }
  }
}

start();

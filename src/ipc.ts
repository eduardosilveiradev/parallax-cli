import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { ProviderFactory } from './agent/provider-factory.js';
import { ToolLoopAgent } from './agent/agent.js';
import { allTools } from './tools.js';
import { loadMcpTools } from './mcp.js';
import { loadWorkspaceSkills } from './skills.js';
import { fetchAvailableModels } from './agent/model-loader.js';
import type { ToolSet } from './agent/types.js';

let currentModel = 'gemini:gemini-3-flash-preview';
let messages: any[] = [];
let pendingConfirms = new Map<string, (accept: boolean) => void>();
let combinedTools: ToolSet = allTools;

// Mute console.log so we don't break JSON stream
const originalLog = console.log;
console.log = () => {};
console.error = () => {};

export async function startIpcServer() {
  const mcpTools = await loadMcpTools();
  combinedTools = { ...allTools, ...mcpTools };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false
  });

  const send = (msg: any) => {
    try {
      fs.writeSync(1, JSON.stringify(msg) + '\n');
    } catch (e: any) {
      if (e.code === 'EPIPE') process.exit(0);
    }
  };

  send({ type: 'ready' });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      
      if (msg.type === 'message') {
        let sysInstruct = `You are a coding assistant.\nAlways respond in the users language.\nAlways use tools proactively.\nWhen reading/listing files do NOT use bash commands. USE YOUR TOOLS.\nYou are in a terminal environment, not a GUI, this means you should avoid markdown at all costs.`;

        const parallaxMdPath = path.join(process.cwd(), 'PARALLAX.md');
        if (fs.existsSync(parallaxMdPath)) {
          sysInstruct += `\n\n# Project Architecture (PARALLAX.md)\n${fs.readFileSync(parallaxMdPath, 'utf8')}`;
        }

        const workspaceSkills = loadWorkspaceSkills(process.cwd());
        if (workspaceSkills.length > 0) {
          sysInstruct += `\n\n# Available Skills\nYou have access to the following specialized skills. To use them, call the \`loadSkill\` tool with the name of the skill to retrieve its full instructions.\n`;
          for (const skill of workspaceSkills) {
            sysInstruct += `\n${skill.frontmatter}\n`;
          }
        }

        const provider = ProviderFactory.create(currentModel);
        messages.push(provider.createUserMessage(msg.text));
        
        const agent = new ToolLoopAgent({
          provider,
          tools: combinedTools,
          systemInstruction: sysInstruct,
          onConfirm: async (tc) => {
            return new Promise<boolean>((resolve) => {
              pendingConfirms.set(tc.id, resolve);
              send({ type: 'tool-call-confirm', id: tc.id, name: tc.name, input: tc.input });
            });
          }
        });

        try {
          const stream = agent.stream(messages);
          for await (const part of stream) {
             send(part);
          }
          send({ type: 'step-done', messages });
        } catch (e: any) {
          send({ type: 'error', error: e.message });
        }
      } else if (msg.type === 'confirm') {
         const resolve = pendingConfirms.get(msg.id);
         if (resolve) {
           resolve(msg.accept);
           pendingConfirms.delete(msg.id);
         }
      } else if (msg.type === 'clear') {
         messages = [];
      } else if (msg.type === 'set-history') {
         messages = msg.history || [];
      } else if (msg.type === 'fetch-models') {
          try {
             const models = await fetchAvailableModels();
             send({ type: 'models-list', models });
          } catch (e: any) {
             send({ type: 'error', error: e.message });
          }
      } else if (msg.type === 'set-model') {
          currentModel = msg.model;
      }
    } catch (err: any) {
      send({ type: 'error', error: `IPC parse error: ${err.message}` });
    }
  });
}

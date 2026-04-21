import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { ProviderFactory } from './agent/provider-factory.js';
import { ToolLoopAgent } from './agent/agent.js';
import { allTools } from './tools.js';
import { loadMcpTools } from './mcp.js';
import { loadWorkspaceSkills } from './skills.js';
import { fetchAvailableModels } from './agent/model-loader.js';
import { getSystemPrompt } from './system-prompt.js';
import type { ToolSet } from './agent/types.js';

let currentModel = 'gemini:gemini-3-flash-preview';
let messages: any[] = [];
let pendingConfirms = new Map<string, (accept: boolean) => void>();
let combinedTools: ToolSet = allTools;
let abortController: AbortController | null = null;

function getToolLabel(name: string, args: any, status: 'calling' | 'done', result?: any): string {
  const isDone = status === 'done';
  const isFail = isDone && result && typeof result === 'object' && result.success === false;
  const fileName = args?.path ? path.basename(args.path) : '';

  if (isFail) {
    switch (name) {
      case 'AskQuestion': return `Failed to collect answers`;
      case 'CreatePlan': return `Failed to create plan`;
      case 'TodoWrite': return `Failed to update todos`;
      case 'SwitchMode': return `Failed to switch mode`;
      case 'Task': return `Task failed`;
      case 'listDirectory': return `Failed to list ${args.path}`;
      case 'readFile': return `Failed to read ${fileName}`;
      case 'writeFile': return `Failed to write ${fileName}`;
      case 'editFile': return `Failed to edit ${fileName}`;
      case 'runCommand': return `Failed to run ${args.command}`;
      case 'subagent': return `Subagent failed`;
      case 'checkCommandStatus': return `Failed to check command ${args.commandId}`;
      default: return `Failed ${name}`;
    }
  }

  switch (name) {
    case 'AskQuestion': return isDone ? `Collected answers` : `Asking questions`;
    case 'CreatePlan': return isDone ? `Created plan` : `Creating plan`;
    case 'TodoWrite': return isDone ? `Updated todos` : `Updating todos`;
    case 'SwitchMode': return isDone ? `Switched mode` : `Switching mode`;
    case 'Task': return isDone ? `Task finished` : `Running task`;
    case 'listDirectory': return isDone ? `Listed ${args.path}` : `Listing ${args.path}`;
    case 'readFile': return isDone ? `Read ${fileName}` : `Reading ${fileName}`;
    case 'writeFile': return isDone ? `Wrote ${fileName}` : `Writing ${fileName}`;
    case 'editFile': return isDone ? `Edited ${fileName}` : `Editing ${fileName}`;
    case 'runCommand': return isDone ? `Ran ${args.command}` : `Running ${args.command}`;
    case 'subagent': return isDone ? `Subagent finished` : `Running subagent`;
    case 'checkCommandStatus': return isDone ? `Checked command ${args.commandId}` : `Checking command ${args.commandId}`;
    default:
      if (name.includes('_')) {
        const [server, ...tool] = name.split('_');
        const toolName = tool.join('_');
        return isDone ? `${server}: Finished ${toolName}` : `${server}: Calling ${toolName}`;
      }
      return isDone ? `Finished ${name}` : `Calling ${name}`;
  }
}

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
        let sysInstruct = getSystemPrompt();

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
            send({ type: 'status-update', text: `Waiting for user confirmation: ${tc.name}` });
            return new Promise<boolean>((resolve) => {
              pendingConfirms.set(tc.id, resolve);
              send({ type: 'tool-call-confirm', id: tc.id, name: tc.name, input: tc.input });
            });
          }
        });

        abortController = new AbortController();

        try {
          const stream = agent.stream(messages);
          for await (const part of stream) {
             if (abortController?.signal.aborted) {
               send({ type: 'error', error: 'User stopped generation.' });
               break;
             }
             if (part.type === 'tool-call') {
               send({ type: 'status-update', text: getToolLabel(part.toolName!, part.input, 'calling') });
             } else if (part.type === 'tool-result') {
               send({ type: 'status-update', text: getToolLabel(part.toolName || 'tool', {}, 'done', part.output) });
             }
             send(part);
          }
          send({ type: 'step-done', messages });
        } catch (e: any) {
          send({ type: 'error', error: e.message });
        }
      } else if (msg.type === 'abort') {
         if (abortController) {
           abortController.abort();
           abortController = null;
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

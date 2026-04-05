import fs from 'fs';
import path from 'path';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import crypto from 'node:crypto';
import * as diff from 'diff';
import { IdeClient } from '@google/gemini-cli-core';
import { ProviderFactory } from './agent/provider-factory.js';
import type { ToolSet, ToolContext } from './agent/types.js';
import { ToolLoopAgent } from './agent/agent.js';
import { GeminiProvider } from './agent/gemini-provider.js';
import { threadedSearch } from './agent/fast-search.js';

const execAsync = promisify(exec);

let ideClientInstance: IdeClient | null = null;
let ideClientInitAttempted = false;

async function getConnectedIdeClient(): Promise<IdeClient | null> {
  if (!ideClientInitAttempted) {
    ideClientInitAttempted = true;
    try {
      ideClientInstance = await IdeClient.getInstance();
      await ideClientInstance.connect({ logToConsole: false });
    } catch (err) {
      ideClientInstance = null;
    }
  }
  return ideClientInstance;
}

export interface RunningCommand {
  id: string;
  process: ChildProcess;
  outputBuffer: string;
  exitCode: number | null;
}
export const activeCommands = new Map<string, RunningCommand>();

export const allTools: ToolSet = {
  editJson: {
    description: 'Safely parse, modify, and overwrite JSON files iteratively using direct key paths without manually text replacing blocks. Target must be a valid JSON file. Path should be dot-delimited (e.g. "scripts.build"). If you intend to delete a key, leave operation as "delete". Ensure your JSON injection values are structurally valid parameters.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the json file' },
        keyPath: { type: 'string', description: 'Dot-delimited path of the key to mutate' },
        operation: { type: 'string', description: '"set" or "delete"' },
        value: { type: 'string', description: 'Stringified JSON value to set if operation is "set"' }
      },
      required: ['path', 'keyPath', 'operation']
    },
    execute: async (args: any) => {
      try {
        const fullPath = path.resolve(args.path);
        if (!fs.existsSync(fullPath)) return { success: false, error: `File not found at ${fullPath}` };

        const content = fs.readFileSync(fullPath, 'utf8');
        const json = JSON.parse(content);
        const keys = args.keyPath.split('.');
        
        let current = json;
        for (let i = 0; i < keys.length - 1; i++) {
          if (!current[keys[i]]) current[keys[i]] = {};
          current = current[keys[i]];
        }
        
        const finalKey = keys[keys.length - 1];
        if (args.operation === 'delete') {
          delete current[finalKey];
        } else {
          current[finalKey] = JSON.parse(args.value);
        }

        fs.writeFileSync(fullPath, JSON.stringify(json, null, 2));
        return { success: true, msg: `JSON mutated successfully at ${args.keyPath}` };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  },
  searchCodebase: {
    description: 'Fast concurrent worker-threaded codebase search traversing all files internally without needing ripgrep installed locally. Best for finding references, tokens, or variables globally.',
    parameters: {
      type: 'object',
      properties: {
        directory: { type: 'string' },
        pattern: { type: 'string' },
        isRegex: { type: 'boolean' },
        caseSensitive: { type: 'boolean' }
      },
      required: ['directory', 'pattern']
    },
    execute: async (args: any) => {
      try {
        const fullPath = path.resolve(args.directory);
        const MAX_RESULTS = 250;
        const matches = await threadedSearch(fullPath, args.pattern, {
           isRegex: !!args.isRegex,
           caseSensitive: !!args.caseSensitive,
           maxResults: MAX_RESULTS
        });
        return { 
           success: true, 
           matchesFound: matches.length,
           truncated: matches.length === MAX_RESULTS,
           matches 
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  },
  readClipboard: {
    description: 'Natively retrieves the text payload currently locked inside the host users operating system clipboard queue.',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      try {
        let command = '';
        if (process.platform === 'darwin') {
          command = 'pbpaste';
        } else if (process.platform === 'linux') {
          command = 'xclip -selection clipboard -o || xsel --clipboard --output';
        } else if (process.platform === 'win32') {
          command = 'powershell.exe -command "Get-Clipboard"';
        } else {
          return { success: false, error: 'Unsupported clipboard OS platform' };
        }
        
        const { stdout } = await execAsync(command);
        return { success: true, clipboardText: stdout };
      } catch (err: any) {
        return { success: false, error: 'Clipboard extraction failed: ' + err.message };
      }
    }
  },
  writeClipboard: {
    description: 'Injects an arbitrary string buffer directly into the host users OS clipboard queue natively.',
    requiresConfirmation: true,
    parameters: { 
      type: 'object', 
      properties: { text: { type: 'string' } },
      required: ['text'] 
    },
    execute: async (args: any) => {
      try {
        let runner;
        if (process.platform === 'darwin') {
          runner = spawn('pbcopy');
        } else if (process.platform === 'linux') {
          runner = spawn('xclip', ['-selection', 'clipboard']);
        } else if (process.platform === 'win32') {
          runner = spawn('clip');
        } else {
          return { success: false, error: 'Unsupported clipboard OS platform' };
        }
        
        runner.stdin.write(args.text);
        runner.stdin.end();
        return { success: true, msg: 'Clipboard buffer successfully replaced' };
      } catch (err: any) {
        return { success: false, error: 'Clipboard injection failed: ' + err.message };
      }
    }
  },
  listDirectory: {
    description: 'List contents of a directory',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    execute: async (args: any) => {
      try {
        const fullPath = path.resolve(args.path);
        const files = fs.readdirSync(fullPath, { withFileTypes: true });
        return {
          success: true,
          path: fullPath,
          items: files.map(f => ({ name: f.name, type: f.isDirectory() ? 'directory' : 'file' }))
        };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  },
  readFile: {
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    execute: async (args: any) => {
      try {
        const fullPath = path.resolve(args.path);
        const content = fs.readFileSync(fullPath, 'utf8');
        return { success: true, path: fullPath, content: content.slice(0, 100000) };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  },
  writeFile: {
    description: 'Write to a file',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content']
    },
    execute: async (args: any) => {
      try {
        const fullPath = path.resolve(args.path);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        
        fs.writeFileSync(fullPath, args.content);
        return { success: true, path: fullPath, bytesWritten: Buffer.byteLength(args.content) };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  },
  editFile: {
    description: 'Edit an existing file by replacing a specific block of text. You must provide the exact old text to be replaced and the new text.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: { 
        path: { type: 'string', description: 'Path to the file to edit' },
        oldText: { type: 'string', description: 'The exact string to find and replace. Must match perfectly, including indentation.' },
        newText: { type: 'string', description: 'The string to replace oldText with.' }
      },
      required: ['path', 'oldText', 'newText']
    },
    execute: async (args: any) => {
      try {
        const fullPath = path.resolve(args.path);
        if (!fs.existsSync(fullPath)) {
            return { success: false, error: 'File does not exist: ' + fullPath };
        }
        const content = fs.readFileSync(fullPath, 'utf8');
        
        const occurrences = content.split(args.oldText).length - 1;
        if (occurrences === 0) {
            return { success: false, error: 'The provided oldText was not found in the file. Make sure to match whitespace perfectly.' };
        } else if (occurrences > 1) {
            return { success: false, error: 'The provided oldText was found multiple times in the file. Provide a larger block of text to uniquely match.' };
        }
        
        const newContent = content.replace(args.oldText, args.newText);
        const diffPatch = diff.createPatch(args.path, content, newContent);
        
        const client = await getConnectedIdeClient();
        if (client && client.isDiffingEnabled()) {
          client.openDiff(fullPath, newContent).then(res => {
             if (res.status === 'accepted' && res.content !== undefined && res.content !== newContent) {
                fs.writeFileSync(fullPath, res.content);
             }
          }).catch(() => {});
          await new Promise(r => setTimeout(r, 150));
        }
        
        fs.writeFileSync(fullPath, newContent);
        return { success: true, path: fullPath, message: 'File successfully edited.', diff: diffPatch };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  },
  runCommand: {
    description: 'Run a shell command. By default, it waits up to 5000ms for the command to finish. If the command takes longer, it leaves it running in the background and returns a commandId. You can use checkCommandStatus to read its ongoing output and sendCommandInput to interact with it.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: { 
        command: { type: 'string' },
        waitMs: { type: 'number', description: 'How long to wait for the command to finish before detaching to the background (default 5000ms)' }
      },
      required: ['command']
    },
    execute: async (args: any) => {
      try {
        const id = crypto.randomUUID();
        const waitMs = args.waitMs || 5000;
        
        const child = spawn(args.command, { shell: true });
        
        const runningCmd: RunningCommand = {
          id,
          process: child,
          outputBuffer: '',
          exitCode: null
        };
        activeCommands.set(id, runningCmd);

        child.stdout?.on('data', (data) => runningCmd.outputBuffer += data.toString());
        child.stderr?.on('data', (data) => runningCmd.outputBuffer += data.toString());
        
        return new Promise((resolve) => {
          let timeoutCompleted = false;
          
          const timeout = setTimeout(() => {
            if (runningCmd.exitCode === null) {
              timeoutCompleted = true;
              const outputSoFar = runningCmd.outputBuffer;
              runningCmd.outputBuffer = ''; 
              resolve({ 
                success: true, 
                status: 'running_in_background', 
                commandId: id, 
                outputSoFar 
              });
            }
          }, waitMs);

          child.on('close', (code) => {
            runningCmd.exitCode = code;
            if (!timeoutCompleted) {
              clearTimeout(timeout);
              const output = runningCmd.outputBuffer;
              activeCommands.delete(id);
              if (code !== 0) {
                resolve({ success: false, error: `Command exited with code ${code}`, output });
              } else {
                resolve({ success: true, output });
              }
            }
          });
          
          child.on('error', (err) => {
             if (!timeoutCompleted) {
               clearTimeout(timeout);
               activeCommands.delete(id);
               resolve({ success: false, error: err.message, output: runningCmd.outputBuffer });
             }
          });
        });
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  },
  checkCommandStatus: {
    description: 'Check the status of a background command and read its recent output.',
    parameters: {
      type: 'object',
      properties: { commandId: { type: 'string' } },
      required: ['commandId']
    },
    execute: async (args: any) => {
      const cmd = activeCommands.get(args.commandId);
      if (!cmd) return { success: false, error: 'Command ID not found or already completed.' };
      
      const output = cmd.outputBuffer;
      cmd.outputBuffer = '';
      return {
        success: true,
        status: cmd.exitCode === null ? 'running' : 'exited',
        exitCode: cmd.exitCode,
        output
      };
    }
  },
  sendCommandInput: {
    description: 'Send standard input to a running background command, or terminate it.',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: {
        commandId: { type: 'string' },
        input: { type: 'string', description: 'Text to send to stdin (include \\n if needed)' },
        terminate: { type: 'boolean', description: 'If true, kills the running command' }
      },
      required: ['commandId']
    },
    execute: async (args: any) => {
      const cmd = activeCommands.get(args.commandId);
      if (!cmd) return { success: false, error: 'Command ID not found.' };
      
      if (args.terminate) {
        cmd.process.kill();
        return { success: true, message: 'Termination signal sent.' };
      }
      
      if (args.input !== undefined) {
        cmd.process.stdin?.write(args.input);
        return { success: true, message: 'Input written to stdin.' };
      }
      
      return { success: false, error: 'Must provide either input or terminate.' };
    }
  },
  subagent: {
    description: 'Spawns a subagent to perform a specific task.',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task to perform' },
        systemInstruction: { type: 'string', description: 'Optional system instruction for the subagent' },
        model: { type: 'string', description: 'Optional explicit model name to use, e.g. gemini-3-flash-preview. Leave blank for default.' }
      },
      required: ['prompt']
    },
    execute: async (args: any, context?: ToolContext) => {
      if (!context) {
        return { success: false, error: 'Context not provided to subagent tool' };
      }
      try {
        const subagentProvider = ProviderFactory.create(args.model || 'gemini:gemini-3-flash-preview');
        const subagent = new ToolLoopAgent({
          provider: subagentProvider,
          tools: context.tools,
          systemInstruction: args.systemInstruction || 'You are a subagent helping a main agent with a task. Be concise and precise.',
          onConfirm: context.onConfirm
        });

        const messages = [context.provider.createUserMessage(args.prompt)];
        let fullText = '';
        const stream = subagent.stream(messages);

        for await (const part of stream) {
          if (part.type === 'text-delta') {
            fullText += part.text;
          }
        }

        return { success: true, answer: fullText };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }
  }
};

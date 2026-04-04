import fs from 'fs';
import path from 'path';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import crypto from 'node:crypto';
import * as diff from 'diff';
import type { ToolSet, ToolContext } from './agent/types.js';
import { ToolLoopAgent } from './agent/agent.js';

const execAsync = promisify(exec);

export interface RunningCommand {
  id: string;
  process: ChildProcess;
  outputBuffer: string;
  exitCode: number | null;
}
export const activeCommands = new Map<string, RunningCommand>();

export const allTools: ToolSet = {
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
        systemInstruction: { type: 'string', description: 'Optional system instruction for the subagent' }
      },
      required: ['prompt']
    },
    execute: async (args: any, context?: ToolContext) => {
      if (!context) {
        return { success: false, error: 'Context not provided to subagent tool' };
      }
      try {
        const subagent = new ToolLoopAgent({
          provider: context.provider,
          tools: context.tools,
          systemInstruction: args.systemInstruction || 'You are a subagent helping a main agent with a task.',
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

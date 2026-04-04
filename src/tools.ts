import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolSet, ToolContext } from './agent/types.js';
import { ToolLoopAgent } from './agent/agent.js';

const execAsync = promisify(exec);

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
  runCommand: {
    description: 'Run a shell command',
    requiresConfirmation: true,
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command']
    },
    execute: async (args: any) => {
      try {
        const { stdout, stderr } = await execAsync(args.command);
        return { success: true, output: stdout || stderr };
      } catch (err: any) {
        return { success: false, error: err.message, output: err.stdout || err.stderr };
      }
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

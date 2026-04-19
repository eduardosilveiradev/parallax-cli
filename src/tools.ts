import fs from 'fs';
import path from 'path';
import { exec, spawn, ChildProcess } from 'child_process';
import striptags from 'striptags';
import { search } from 'duck-duck-scrape';
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
    status: 'running' | 'done';
    exitCode: number | null;
}
export const activeCommands = new Map<string, RunningCommand>();

export const allTools: ToolSet = {
    EditJson: {
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
    GrepSearch: {
        description: 'Fast concurrent worker-threaded codebase search traversing all files internally without needing ripgrep installed locally. Best for finding references, tokens, or variables globally.',
        parameters: {
            type: 'object',
            properties: {
                SearchPath: { type: 'string' },
                Query: { type: 'string' },
                IsRegex: { type: 'boolean' },
                CaseInsensitive: { type: 'boolean' }
            },
            required: ['SearchPath', 'Query']
        },
        execute: async (args: any) => {
            try {
                const fullPath = path.resolve(args.SearchPath);
                const MAX_RESULTS = 250;
                const matches = await threadedSearch(fullPath, args.Query, {
                    isRegex: !!args.IsRegex,
                    caseSensitive: !args.CaseInsensitive,
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
    ReadClipboard: {
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
    WriteClipboard: {
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
    ListDir: {
        description: "List the contents of a directory, i.e. all files and subdirectories.",
        parameters: {
            type: 'object',
            properties: { DirectoryPath: { type: 'string', description: 'Path to list contents of, should be absolute path to a directory.' } },
            required: ['DirectoryPath']
        },
        execute: async ({ DirectoryPath }: any) => {
            try {
                const resolved = path.resolve(DirectoryPath);
                const entries = fs.readdirSync(resolved, { withFileTypes: true });
                const results = [];
                for (const entry of entries) {
                    if (entry.isFile()) {
                        try {
                            const stats = fs.statSync(path.join(resolved, entry.name));
                            results.push(`${entry.name} - File (${stats.size} bytes)`);
                        } catch {
                            results.push(`${entry.name} - File`);
                        }
                    } else if (entry.isDirectory()) {
                        results.push(`${entry.name}/ - Directory`);
                    }
                }
                return { success: true, path: resolved, content: results.join('\n') };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    },
    ViewFile: {
        description: "View the contents of a file from the local filesystem.",
        parameters: {
            type: 'object',
            properties: {
                AbsolutePath: { type: 'string', description: 'Absolute or relative path to the file to read.' },
                StartLine: { type: 'number', description: 'Optional. Startline to view, 1-indexed as usual, inclusive.' },
                EndLine: { type: 'number', description: 'Optional. Endline to view, 1-indexed as usual, inclusive.' }
            },
            required: ['AbsolutePath']
        },
        execute: async ({ AbsolutePath, StartLine, EndLine }: any) => {
            try {
                const resolved = path.resolve(AbsolutePath);
                const content = fs.readFileSync(resolved, 'utf8');
                if (StartLine || EndLine) {
                    const lines = content.split('\n');
                    const start = Math.max(0, (StartLine || 1) - 1);
                    const end = EndLine ? Math.min(lines.length, EndLine) : lines.length;
                    return { success: true, path: resolved, content: lines.slice(start, end).join('\n') };
                }
                return { success: true, path: resolved, content };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    },
    WriteToFile: {
        description: "Create new files. By default errors if TargetFile exists to prevent overwrite.",
        requiresConfirmation: true,
        parameters: {
            type: 'object',
            properties: {
                TargetFile: { type: 'string', description: 'Path to the file to create and write code to.' },
                CodeContent: { type: 'string', description: 'The code contents to write to the file.' },
                Overwrite: { type: 'boolean', description: 'Set this to true to overwrite an existing file.' }
            },
            required: ['TargetFile', 'CodeContent']
        },
        execute: async ({ TargetFile, CodeContent, Overwrite }: any) => {
            try {
                const resolved = path.resolve(TargetFile);
                if (fs.existsSync(resolved) && !Overwrite) {
                    return { success: false, error: `File already exists at ${TargetFile}. Use Overwrite=true if you are sure.` };
                }
                fs.mkdirSync(path.dirname(resolved), { recursive: true });
                fs.writeFileSync(resolved, CodeContent, 'utf8');
                return { success: true, path: resolved, bytesWritten: Buffer.byteLength(CodeContent) };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    },
    MultiReplaceFileContent: {
        description: "Edit an existing file by making multiple non-adjacent contiguous block edits.",
        requiresConfirmation: true,
        parameters: {
            type: 'object',
            properties: {
                TargetFile: { type: 'string', description: 'The target file to modify.' },
                Instruction: { type: 'string', description: 'Description of the changes' },
                Description: { type: 'string', description: 'Brief explanation of what this change did' },
                TargetLintErrorIds: { type: 'array', items: { type: 'string' } },
                ReplacementChunks: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            StartLine: { type: 'number' },
                            EndLine: { type: 'number' },
                            TargetContent: { type: 'string' },
                            ReplacementContent: { type: 'string' },
                            AllowMultiple: { type: 'boolean' }
                        },
                        required: ['TargetContent', 'ReplacementContent']
                    }
                }
            },
            required: ['TargetFile', 'ReplacementChunks']
        },
        execute: async ({ TargetFile, ReplacementChunks }: any) => {
            try {
                const resolved = path.resolve(TargetFile);
                if (!fs.existsSync(resolved)) return { success: false, error: 'File does not exist: ' + resolved };
                let content = fs.readFileSync(resolved, 'utf-8');
                let replacedCount = 0;

                for (let i = 0; i < ReplacementChunks.length; i++) {
                    const chunk = ReplacementChunks[i];
                    const targetContent = chunk.TargetContent;
                    const replacementContent = chunk.ReplacementContent;
                    const allowMultiple = chunk.AllowMultiple;

                    const occurrences = content.split(targetContent).length - 1;
                    if (occurrences === 0) return { success: false, error: `Chunk ${i} Target text not found in file. Whitespace must match exactly.` };
                    if (occurrences > 1 && !allowMultiple) return { success: false, error: `Chunk ${i} Multiple occurrences found (${occurrences}). Set AllowMultiple=true if intended.` };

                    content = allowMultiple ? content.split(targetContent).join(replacementContent) : content.replace(targetContent, replacementContent);
                    replacedCount += allowMultiple ? occurrences : 1;
                }

                fs.writeFileSync(resolved, content, 'utf-8');
                return { success: true, message: `Successfully replaced ${replacedCount} occurrences across ${ReplacementChunks.length} chunks in ${TargetFile}` };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    },
    ReplaceFileContent: {
        description: "Edit an existing file by making a single contiguous block of edits.",
        requiresConfirmation: true,
        parameters: {
            type: 'object',
            properties: {
                TargetFile: { type: 'string', description: 'The target file to modify.' },
                TargetContent: { type: 'string', description: 'The exact character-sequence to be replaced, including whitespace.' },
                ReplacementContent: { type: 'string', description: 'The content to replace the target content with.' },
                AllowMultiple: { type: 'boolean', description: 'If true, replace multiple occurrences.' }
            },
            required: ['TargetFile', 'TargetContent', 'ReplacementContent']
        },
        execute: async ({ TargetFile, TargetContent, ReplacementContent, AllowMultiple }: any) => {
            try {
                const resolved = path.resolve(TargetFile);
                if (!fs.existsSync(resolved)) return { success: false, error: 'File does not exist: ' + resolved };
                let content = fs.readFileSync(resolved, 'utf-8');
                const occurrences = content.split(TargetContent).length - 1;

                if (occurrences === 0) return { success: false, error: 'Target text not found in file. Whitespace must match exactly.' };
                if (occurrences > 1 && !AllowMultiple) return { success: false, error: `Multiple occurrences found (${occurrences}). Set AllowMultiple=true if intended.` };

                const newContent = AllowMultiple ? content.split(TargetContent).join(ReplacementContent) : content.replace(TargetContent, ReplacementContent);

                const diffPatch = diff.createPatch(TargetFile, content, newContent);
                const client = await getConnectedIdeClient();
                if (client && client.isDiffingEnabled()) {
                    client.openDiff(resolved, newContent).then(res => {
                        if (res.status === 'accepted' && res.content !== undefined && res.content !== newContent) {
                            fs.writeFileSync(resolved, res.content);
                        }
                    }).catch(() => { });
                    await new Promise(r => setTimeout(r, 150));
                }

                fs.writeFileSync(resolved, newContent, 'utf-8');
                return { success: true, message: `Successfully replaced ${AllowMultiple ? occurrences : 1} occurrences in ${TargetFile}`, diff: diffPatch };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    },
    RunCommand: {
        description: "PROPOSE a command to run on behalf of the user in the terminal. Handles background tasks and long-running processes natively.",
        requiresConfirmation: true,
        parameters: {
            type: 'object',
            properties: {
                CommandLine: { type: 'string', description: 'The exact command line string to execute.' },
                Cwd: { type: 'string', description: 'The current working directory for the command. Will default to project root if left empty.' },
                WaitMsBeforeAsync: { type: 'number', description: 'Optional wait time before returning if command is long running.' }
            },
            required: ['CommandLine']
        },
        execute: async ({ CommandLine, Cwd, WaitMsBeforeAsync }: any) => {
            try {
                const id = crypto.randomUUID();
                const child = spawn(CommandLine, { shell: true, cwd: Cwd ? path.resolve(Cwd) : process.cwd() });

                const cmdState: RunningCommand = {
                    id,
                    process: child,
                    outputBuffer: '',
                    status: 'running',
                    exitCode: null
                };
                activeCommands.set(id, cmdState);

                child.stdout?.on('data', (data) => { cmdState.outputBuffer += data.toString(); });
                child.stderr?.on('data', (data) => { cmdState.outputBuffer += data.toString(); });
                child.on('close', (code) => {
                    cmdState.status = 'done';
                    cmdState.exitCode = code;
                });
                child.on('error', (err) => {
                    cmdState.status = 'done';
                    cmdState.outputBuffer += `\n[System Error]: ${err.message}`;
                });

                const waitTime = WaitMsBeforeAsync || 5000;

                return await new Promise((resolve) => {
                    let done = false;
                    const cleanup = () => {
                        if (done) return;
                        done = true;
                        if (cmdState.status === 'done') {
                            resolve({ success: cmdState.exitCode === 0, output: `Command exited with code ${cmdState.exitCode}.\nOutput:\n${cmdState.outputBuffer}` });
                        } else {
                            resolve({ success: true, status: 'running_in_background', commandId: id, outputSoFar: `Command is running in background. ID: ${id}\nOutput so far:\n${cmdState.outputBuffer}` });
                        }
                    };
                    child.once('close', cleanup);
                    setTimeout(cleanup, waitTime);
                });
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    },
    CommandStatus: {
        description: "Get the status of a previously executed terminal command by its ID.",
        parameters: {
            type: 'object',
            properties: {
                CommandId: { type: 'string', description: 'ID of the command to get status for' },
                OutputCharacterCount: { type: 'number', description: 'Number of characters to view. Max 5000.' },
                WaitDurationSeconds: { type: 'number', description: 'Seconds to wait for command completion before getting status' }
            },
            required: ['CommandId']
        },
        execute: async ({ CommandId, OutputCharacterCount, WaitDurationSeconds }: any) => {
            const cmdState = activeCommands.get(CommandId);
            if (!cmdState) return { success: false, error: `Unknown command ID ${CommandId}` };

            if (WaitDurationSeconds && cmdState.status === 'running') {
                await new Promise((resolve) => {
                    const timeout = setTimeout(resolve, WaitDurationSeconds * 1000);
                    cmdState.process.once('close', () => { clearTimeout(timeout); resolve(undefined); });
                });
            }

            const limit = OutputCharacterCount || 2000;
            const out = cmdState.outputBuffer.slice(-limit);
            cmdState.outputBuffer = out;

            return {
                success: true,
                status: cmdState.status,
                exitCode: cmdState.exitCode,
                output: `Status: ${cmdState.status}\nExit code: ${cmdState.exitCode ?? 'N/A'}\nRecent Output:\n${out}`
            };
        }
    },
    SendCommandInput: {
        description: "Send standard input to a running command or to terminate a command.",
        requiresConfirmation: true,
        parameters: {
            type: 'object',
            properties: {
                CommandId: { type: 'string', description: 'The command ID.' },
                Input: { type: 'string', description: 'The input to send to stdin. Include newline characters if needed.' },
                Terminate: { type: 'boolean', description: 'Whether to terminate the command.' }
            },
            required: ['CommandId']
        },
        execute: async ({ CommandId, Input, Terminate }: any) => {
            const cmdState = activeCommands.get(CommandId);
            if (!cmdState) return { success: false, error: `Unknown command ID ${CommandId}` };

            if (Terminate) {
                cmdState.process.kill();
                return { success: true, message: `Sent SIGTERM to command ${CommandId}` };
            }

            if (Input && cmdState.status === 'running') {
                cmdState.process.stdin?.write(Input);
                await new Promise(resolve => setTimeout(resolve, 500));
                return { success: true, message: `Input sent.\nCurrent output:\n${cmdState.outputBuffer.slice(-1000)}` };
            }

            return { success: false, error: "No action taken." };
        }
    },
    Subagent: {
        description: 'Spawns a subagent to perform a specific task.',
        parameters: {
            type: 'object',
            properties: {
                prompt: { type: 'string', description: 'The task to perform' },
                systemInstruction: { type: 'string', description: 'Optional system instruction for the subagent' },
                model: { type: 'string', description: 'Optional explicit model name to use, e.g. gemini:gemini-3-flash-preview. Leave blank for default.' }
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
    },
    MultiReplaceFileContent: {
        description: 'Edit a file using multiple non-contiguous target blocks. Best for complex edits across different parts of a file.',
        requiresConfirmation: true,
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'The target file to modify.' },
                chunks: {
                    type: 'array',
                    description: 'A list of chunks to replace.',
                    items: {
                        type: 'object',
                        properties: {
                            targetContent: { type: 'string', description: 'Exact string to be replaced.' },
                            replacementContent: { type: 'string', description: 'Content to replace it with.' },
                            allowMultiple: { type: 'boolean', description: 'If true, multiple occurrences will be replaced. Only use this if you are absolutely certain you want to replace multiple instances of the target content in the file' }
                        },
                        required: ['targetContent', 'replacementContent']
                    }
                }
            },
            required: ['path', 'chunks']
        },
        execute: async (args: any) => {
            try {
                const fullPath = path.resolve(args.path);
                if (!fs.existsSync(fullPath)) return { success: false, error: `File not found at ${fullPath}` };
                let content = fs.readFileSync(fullPath, 'utf8');

                for (let i = 0; i < args.chunks.length; i++) {
                    const chunk = args.chunks[i];
                    const occurrences = content.split(chunk.targetContent).length - 1;
                    if (occurrences === 0) {
                        return { success: false, error: `Chunk ${i} targetContent not found.` };
                    } else if (occurrences > 1 && !chunk.allowMultiple) {
                        return { success: false, error: `Chunk ${i} targetContent found multiple times. Pass allowMultiple=true if intended.` };
                    }
                    content = content.split(chunk.targetContent).join(chunk.replacementContent);
                }

                fs.writeFileSync(fullPath, content);
                return { success: true, message: `Successfully replaced ${args.chunks.length} chunks.` };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    },
    SearchWeb: {
        description: 'Performs a web search for a given query using DuckDuckGo. Returns a summary of relevant information along with URL citations.',
        parameters: {
            type: 'object',
            properties: {
                domain: { type: 'string', description: 'Optional domain to restrict the search to' },
                query: { type: 'string' }
            },
            required: ['query']
        },
        execute: async (args: any) => {
            try {
                const searchQuery = args.domain ? `site:${args.domain} ${args.query}` : args.query;
                const searchResults = await search(searchQuery, { safeSearch: -2 });
                const results = searchResults.results.slice(0, 5).map(r => ({ title: r.title, url: r.url, description: r.description }));
                return { success: true, results };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    },
    ReadUrlContent: {
        description: 'Fetch content from a URL via HTTP request. Converts HTML to markdown. No JavaScript execution, no authentication.',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string' } },
            required: ['url']
        },
        execute: async ({ url }: any) => {
            try {
                const response = await fetch(url);
                if (!response.ok) return { success: false, error: `HTTP ${response.status} ${response.statusText}` };
                const text = await response.text();
                const contentText = text;
                let clean = striptags(contentText, ['h1', 'h2', 'h3', 'p', 'a', 'b', 'i', 'strong', 'em', 'ul', 'ol', 'li']);
                clean = clean.replace(/<[^>]*>/g, ' ');
                clean = clean.replace(/\s+/g, ' ').trim();
                return { success: true, content: clean.substring(0, 100000) };
            } catch (err: any) {
                return { success: false, error: err.message };
            }
        }
    }
};

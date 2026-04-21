import type { ReactNode } from 'react';

export interface ToolCallInfo {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: 'calling' | 'done';
    result?: unknown;
}

export type MessageBlock =
    | { type: 'user'; id: string; text: string }
    | { type: 'assistant'; id: string; text: string }
    | { type: 'error'; id: string; text: string }
    | { type: 'thinking'; id: string; text: string; startTime?: number; endTime?: number }
    | { type: 'tool-call'; id: string; call: ToolCallInfo }
    | { type: 'tool'; id?: string; calls: ToolCallInfo[] }; // Legacy loaded sessions

export interface StreamPart {
    type: 'text-delta' | 'thinking-delta' | 'tool-call' | 'tool-result' | 'finish-step';
    text?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    reason?: string;
}

export interface ToolContext {
    provider: AgentProvider;
    tools: ToolSet;
    onConfirm?: (tool: { id: string; name: string; input: any }) => Promise<boolean>;
    toolCallId?: string;
    sessionId?: string;
    cwd?: string;
}

export interface ToolDefinition {
    description: string;
    parameters: any;
    execute: (args: any, context?: ToolContext) => Promise<unknown>;
    requiresConfirmation?: boolean;
}

export type ToolSet = Record<string, ToolDefinition>;

export interface AgentProvider {
    name: string;
    setModel(model: string): void;
    stream(args: { systemInstruction?: string; messages: any[]; tools?: ToolSet }): AsyncGenerator<StreamPart, void, unknown>;
    createUserMessage(content: string): any;
    createToolResultMessage(id: string, name: string, output: unknown): any;
}

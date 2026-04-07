import OpenAI from 'openai';
import { randomUUID } from 'crypto';
import type { AgentProvider, StreamPart, ToolSet } from './types.js';

export interface GenericProviderConfig {
  name: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

export class GenericProvider implements AgentProvider {
  name: string;
  protected model: string;
  protected client: OpenAI;

  constructor(config: GenericProviderConfig) {
    this.name = config.name;
    this.model = config.model;
    this.client = new OpenAI({
      apiKey: config.apiKey || 'not-needed-for-local',
      baseURL: config.baseURL
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  private mapTools(tools?: ToolSet): OpenAI.Chat.Completions.ChatCompletionTool[] | undefined {
    if (!tools || Object.keys(tools).length === 0) return undefined;
    return Object.entries(tools).map(([name, def]) => {
      // Gemini schemas translated to standard JSON Schema
      const parameters = JSON.parse(JSON.stringify(def.parameters));
      return {
        type: 'function',
        function: {
          name,
          description: def.description,
          parameters
        }
      };
    });
  }

  private mapMessages(systemInstruction: string | undefined, messages: any[]): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (systemInstruction) {
      out.push({ role: 'system', content: systemInstruction });
    }

    for (const msg of messages) {
      const role = msg.role === 'model' ? 'assistant' : 'user';
      if (role === 'assistant') {
        const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
        let content = '';
        for (const part of msg.parts) {
          if (part.text) content += part.text;
          if (part.functionCall) {
            toolCalls.push({
              id: part.functionCall.id || `call_${randomUUID().substring(0, 8)}`,
              type: 'function',
              function: {
                name: part.functionCall.name,
                arguments: JSON.stringify(part.functionCall.args)
              }
            });
          }
        }
        if (toolCalls.length > 0) {
          out.push({ role: 'assistant', content, tool_calls: toolCalls });
        } else {
          out.push({ role: 'assistant', content });
        }
      } else {
        const toolResponses = msg.parts.filter((p: any) => p.functionResponse);
        const textParts = msg.parts.filter((p: any) => p.text);
        
        if (toolResponses.length > 0) {
          for (const resp of toolResponses) {
            out.push({
              role: 'tool',
              tool_call_id: resp.functionResponse.id || 'unknown_id',
              content: typeof resp.functionResponse.response === 'object' 
                         ? JSON.stringify(resp.functionResponse.response) 
                         : String(resp.functionResponse.response)
            });
          }
        } else {
          out.push({ role: 'user', content: textParts.map((p:any) => p.text).join('') });
        }
      }
    }
    return out;
  }

  async *stream(args: { systemInstruction?: string; messages: any[]; tools?: ToolSet }): AsyncGenerator<StreamPart, void, unknown> {
    const formattedMessages = this.mapMessages(args.systemInstruction, args.messages);
    const formattedTools = this.mapTools(args.tools);

    let stream: any;
    try {
      stream = await this.client.chat.completions.create({
        model: this.model,
        messages: formattedMessages,
        tools: formattedTools,
        stream: true,
      });
    } catch (err: any) {
      if (err?.message?.includes('greater than the context length') || err?.message?.includes('context_length_exceeded')) {
        throw new Error(`Context limit exceeded. For local hosts (LMStudio, Ollama), increase your Context Length (n_ctx) setting. Or type /compact to clear memory. Original: ${err.message}`);
      }
      throw err;
    }

    const toolCallBuffers = new Map<number, { id: string, name: string, args: string }>();
    const finalParts: any[] = [];
    let textContent = '';

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        textContent += delta.content;
        yield { type: 'text-delta', text: delta.content };
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          let buffer = toolCallBuffers.get(tc.index);
          if (!buffer) {
            buffer = { id: '', name: '', args: '' };
            toolCallBuffers.set(tc.index, buffer);
          }
          if (tc.id) buffer.id = tc.id;
          if (tc.function?.name) buffer.name = tc.function.name;
          if (tc.function?.arguments) buffer.args += tc.function.arguments;
        }
      }

      const finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason) {
        if (textContent.length > 0) {
          finalParts.push({ text: textContent });
        }

        if (finishReason === 'tool_calls') {
          const sorted = Array.from(toolCallBuffers.entries()).sort((a,b) => a[0] - b[0]).map(e => e[1]);
          for (const tc of sorted) {
            let parsedArgs;
            try { parsedArgs = tc.args ? JSON.parse(tc.args) : {}; } catch(e) { parsedArgs = {}; }
            
            const toolCallId = tc.id || randomUUID();
            yield { type: 'tool-call', toolCallId, toolName: tc.name, input: parsedArgs };
            
            finalParts.push({
              functionCall: {
                id: toolCallId,
                name: tc.name,
                args: parsedArgs
              }
            });
          }
          args.messages.push({ role: 'model', parts: finalParts });
          yield { type: 'finish-step', reason: 'tool-calls' };
          return;
        } else {
          args.messages.push({ role: 'model', parts: finalParts });
          yield { type: 'finish-step', reason: finishReason === 'stop' ? 'stop' : 'other' };
          return;
        }
      }
    }
    
    // Fallback if stream closes without explicit finish_reason
    if (textContent.length > 0 && finalParts.length === 0) {
      finalParts.push({ text: textContent });
      args.messages.push({ role: 'model', parts: finalParts });
    }
    yield { type: 'finish-step', reason: 'stop' };
  }

  createUserMessage(content: string): any {
    return {
      role: 'user',
      parts: [{ text: content }]
    };
  }

  createToolResultMessage(id: string, name: string, output: unknown): any {
    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id,
            name,
            response: typeof output === 'object' && output !== null ? output : { result: output }
          }
        }
      ]
    };
  }
}

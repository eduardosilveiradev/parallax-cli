import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'crypto';
import type { AgentProvider, StreamPart, ToolSet } from './types.js';

export interface AnthropicProviderConfig {
  name: string;
  model: string;
  apiKey?: string;
}

export class AnthropicProvider implements AgentProvider {
  name: string;
  protected model: string;
  protected client: Anthropic;

  constructor(config: AnthropicProviderConfig) {
    this.name = config.name;
    this.model = config.model;
    this.client = new Anthropic({
      apiKey: config.apiKey || process.env.ANTHROPIC_API_KEY
    });
  }

  setModel(model: string): void {
    this.model = model;
  }

  private mapTools(tools?: ToolSet): Anthropic.Tool[] | undefined {
    if (!tools || Object.keys(tools).length === 0) return undefined;
    return Object.entries(tools).map(([name, def]) => {
      return {
        name,
        description: def.description,
        input_schema: JSON.parse(JSON.stringify(def.parameters))
      };
    });
  }

  private mapMessages(messages: any[]): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      const role = msg.role === 'model' ? 'assistant' : 'user';
      if (role === 'assistant') {
        const blocks: any[] = [];
        for (const part of msg.parts) {
          if (part.text) {
            blocks.push({ type: 'text', text: part.text });
          }
          if (part.functionCall) {
            blocks.push({
              type: 'tool_use',
              id: part.functionCall.id || `call_${randomUUID().substring(0, 8)}`,
              name: part.functionCall.name,
              input: part.functionCall.args
            });
          }
        }
        if (blocks.length > 0) {
          out.push({ role: 'assistant', content: blocks });
        }
      } else {
        const blocks: any[] = [];
        for (const part of msg.parts) {
          if (part.text) {
            blocks.push({ type: 'text', text: part.text });
          }
          if (part.functionResponse) {
            blocks.push({
              type: 'tool_result',
              tool_use_id: part.functionResponse.id || 'unknown_id',
              content: typeof part.functionResponse.response === 'object' 
                         ? JSON.stringify(part.functionResponse.response) 
                         : String(part.functionResponse.response)
            });
          }
        }
        if (blocks.length > 0) {
          out.push({ role: 'user', content: blocks });
        }
      }
    }
    return out;
  }

  async *stream(args: { systemInstruction?: string; messages: any[]; tools?: ToolSet }): AsyncGenerator<StreamPart, void, unknown> {
    const formattedMessages = this.mapMessages(args.messages);
    const formattedTools = this.mapTools(args.tools);

    const stream = await this.client.messages.create({
      model: this.model,
      system: args.systemInstruction,
      messages: formattedMessages,
      tools: formattedTools,
      stream: true,
      max_tokens: 8192
    });

    const finalParts: any[] = [];
    let textContent = '';
    
    let currentToolCallId = '';
    let currentToolName = '';
    let currentToolArgs = '';

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_start') {
        if (chunk.content_block.type === 'tool_use') {
           currentToolCallId = chunk.content_block.id;
           currentToolName = chunk.content_block.name;
           currentToolArgs = '';
        }
      } else if (chunk.type === 'content_block_delta') {
        if (chunk.delta.type === 'text_delta') {
          textContent += chunk.delta.text;
          yield { type: 'text-delta', text: chunk.delta.text };
        } else if (chunk.delta.type === 'input_json_delta') {
          currentToolArgs += chunk.delta.partial_json;
        }
      } else if (chunk.type === 'content_block_stop') {
         if (currentToolCallId !== '') {
            let parsedArgs;
            try { parsedArgs = currentToolArgs ? JSON.parse(currentToolArgs) : {}; } catch(e) { parsedArgs = {}; }
            yield { type: 'tool-call', toolCallId: currentToolCallId, toolName: currentToolName, input: parsedArgs };
            finalParts.push({ functionCall: { id: currentToolCallId, name: currentToolName, args: parsedArgs } });
            currentToolCallId = '';
            currentToolName = '';
            currentToolArgs = '';
         }
      }
    }

    if (textContent.length > 0) {
      finalParts.unshift({ text: textContent }); // ensure text comes first before tool calls natively
    }

    if (finalParts.length > 0) {
       args.messages.push({ role: 'model', parts: finalParts });
    }

    const hasToolCalls = finalParts.some(p => p.functionCall);
    yield { type: 'finish-step', reason: hasToolCalls ? 'tool-calls' : 'stop' };
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

import type { AgentProvider, StreamPart, ToolSet } from './types.js';

export interface ToolLoopAgentSettings {
  provider: AgentProvider;
  systemInstruction?: string;
  tools?: ToolSet;
  maxSteps?: number;
}

export class ToolLoopAgent {
  private provider: AgentProvider;
  private systemInstruction?: string;
  private tools?: ToolSet;
  private maxSteps: number;

  constructor(settings: ToolLoopAgentSettings) {
    this.provider = settings.provider;
    this.systemInstruction = settings.systemInstruction;
    this.tools = settings.tools;
    this.maxSteps = settings.maxSteps ?? 10;
  }

  async *stream(messages: any[]): AsyncGenerator<StreamPart, void, unknown> {
    let stepCount = 0;
    while (stepCount < this.maxSteps) {
      stepCount++;
      const currentTools = [];
      const stream = this.provider.stream({
        systemInstruction: this.systemInstruction,
        messages,
        tools: this.tools
      });

      let finishReason = 'stop';

      for await (const part of stream) {
        if (part.type === 'tool-call') {
          currentTools.push({ id: part.toolCallId!, name: part.toolName!, input: part.input });
        }
        if (part.type === 'finish-step') {
            finishReason = part.reason || 'stop';
        }
        if (part.type !== 'finish-step') {
            yield part;
        }
      }

      if (currentTools.length > 0) {
        const toolResults = [];
        for (const tc of currentTools) {
          const toolDef = this.tools?.[tc.name];
          let output;
          if (toolDef) {
            output = await toolDef.execute(tc.input);
          } else {
            output = { error: `Tool ${tc.name} not found` };
          }
          yield { type: 'tool-result', toolCallId: tc.id, output };
          toolResults.push(this.provider.createToolResultMessage(tc.id, tc.name, output));
        }

        const mergedParts = toolResults.flatMap(tr => tr.parts);
        messages.push({ role: 'user', parts: mergedParts });
        yield { type: 'finish-step', reason: 'tool-calls' };
        continue;
      }

      yield { type: 'finish-step', reason: finishReason };
      break;
    }
  }

  async *smoothStream(stream: AsyncGenerator<StreamPart, void, unknown>, delayMs: number = 10) {
    for await (const part of stream) {
      yield await new Promise(resolve => setTimeout(() => resolve(part), delayMs));
    }
  }
}

import type { AgentProvider, StreamPart, ToolSet, ToolContext } from './types.js';

export interface ToolLoopAgentSettings {
  provider: AgentProvider;
  systemInstruction?: string;
  tools?: ToolSet;
  onConfirm?: (tool: { id: string; name: string; input: any }) => Promise<boolean>;
}

export class ToolLoopAgent {
  private provider: AgentProvider;
  private systemInstruction?: string;
  private tools?: ToolSet;
  private onConfirm?: (tool: { id: string; name: string; input: any }) => Promise<boolean>;

  constructor(settings: ToolLoopAgentSettings) {
    this.provider = settings.provider;
    this.systemInstruction = settings.systemInstruction;
    this.tools = settings.tools;
    this.onConfirm = settings.onConfirm;
  }

  async *stream(messages: any[]): AsyncGenerator<StreamPart, void, unknown> {
    while (true) {
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
        const executePromises = [];

        for (let i = 0; i < currentTools.length; i++) {
          const tc = currentTools[i];
          const toolDef = this.tools?.[tc.name];
          if (toolDef) {
            const context: ToolContext = {
              provider: this.provider,
              tools: this.tools!,
              onConfirm: this.onConfirm
            };

            let executionPromise: Promise<any>;
            if (toolDef.requiresConfirmation && this.onConfirm) {
              const approved = await this.onConfirm({ id: tc.id, name: tc.name, input: tc.input });
              if (!approved) {
                executionPromise = Promise.resolve({ error: 'The user manually rejected/cancelled the execution of this tool.' });
              } else {
                executionPromise = Promise.resolve().then(() => toolDef.execute(tc.input, context));
              }
            } else {
              executionPromise = Promise.resolve().then(() => toolDef.execute(tc.input, context));
            }
            
            executePromises.push(
               executionPromise
                 .then(output => ({ tc, output, index: i }))
                 .catch(err => ({ tc, output: { error: err.message || String(err) }, index: i }))
            );
          } else {
            executePromises.push(Promise.resolve({ tc, output: { error: `Tool ${tc.name} not found` }, index: i }));
          }
        }

        const finalToolParts = new Array(currentTools.length);
        const pendingWrappers = new Set<Promise<any>>();
        
        for (const p of executePromises) {
           const wrapper: Promise<any> = p.then(res => ({ wrapper, res }));
           pendingWrappers.add(wrapper);
        }

        while (pendingWrappers.size > 0) {
          const { wrapper, res } = await Promise.race(pendingWrappers);
          pendingWrappers.delete(wrapper);

          yield { type: 'tool-result', toolCallId: res.tc.id, output: res.output };
          
          const toolResultMsg = this.provider.createToolResultMessage(res.tc.id, res.tc.name, res.output);
          finalToolParts[res.index] = toolResultMsg.parts[0];
        }

        messages.push({ role: 'user', parts: finalToolParts });
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

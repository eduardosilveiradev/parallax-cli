import {
  createContentGenerator,
  createContentGeneratorConfig,
  AuthType
} from '@google/gemini-cli-core';
import { randomUUID } from 'node:crypto';
import type { AgentProvider, StreamPart, ToolSet } from './types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

export class GeminiProvider implements AgentProvider {
  name = 'gemini';
  private client: any = null;
  private model: string;
  private authType: AuthType;

  constructor(model: string = 'gemini-3.1-pro-preview') {
    this.model = model;
    this.authType = AuthType.LOGIN_WITH_GOOGLE;
  }

  setModel(newModel: string) {
    this.model = newModel;
    this.client = null;
  }

  async ensureInit() {
    if (this.client) return this.client;

    const sessionId = randomUUID();
    const baseConfig: any = {
      getModel: () => this.model,
      getProxy: () => undefined,
      getUsageStatisticsEnabled: () => false,
      getContentGeneratorConfig: () => ({
        authType: this.authType,
        model: this.model,
      }),
      getSessionId: () => sessionId,
      getDebugMode: () => false,
      getTelemetryEnabled: () => false,
      getTargetDir: () => process.cwd(),
      getFullContext: () => false,
      getIdeMode: () => false,
      getCoreTools: () => [],
      getExcludeTools: () => [],
      getMaxSessionTurns: () => 100,
      getFileFilteringRespectGitIgnore: () => true,
      isBrowserLaunchSuppressed: () => false,
      getContextManager: () => undefined,
      getGlobalMemory: () => "",
      getEnvironmentMemory: () => "",
      getHookSystem: () => undefined,
      getModelAvailabilityService: () => undefined,
      getShellToolInactivityTimeout: () => 120000,
      getExperimentsAsync: () => Promise.resolve(undefined),
      getModelConfig: () => Promise.resolve({ overageStrategy: 'DEFAULT' })
    };

    const configMock = new Proxy(baseConfig, {
      get(target, prop) {
        if (prop in target) return target[prop as keyof typeof baseConfig];
        if (typeof prop === 'string') {
          if (prop.startsWith('get') || prop.startsWith('is') || prop.startsWith('has')) {
            return () => {
              if (prop.startsWith('is') || prop.startsWith('has')) return false;
              if (prop.includes('Enabled') || prop.includes('Mode')) return false;
              if (prop.includes('Timeout')) return 120000;
              if (prop.includes('Memory')) return "";
              if (prop.includes('Async')) return Promise.resolve({});
              return {}; 
            };
          }
        }
        return undefined;
      }
    });

    const config = await createContentGeneratorConfig(configMock, this.authType);
    
    // Monkey-patch for 0.36.0
    (config as any).refreshUserQuotaIfStale = async () => {};
    configMock.refreshUserQuotaIfStale = async () => {};
    
    this.client = await createContentGenerator(config, configMock, sessionId);
    return this.client;
  }

  createUserMessage(content: string) {
    return {
      role: 'user',
      parts: [{ text: content }]
    };
  }

  createToolResultMessage(toolCallId: string, toolName: string, output: unknown) {
    let resultValue;
    if (typeof output === 'string') {
      resultValue = { result: output };
    } else if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
      resultValue = output;
    } else {
      resultValue = { result: output };
    }

    return {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: toolName,
            response: resultValue
          }
        }
      ]
    };
  }

  private zodToJsonSchema(schema: any) {
    try {
      let jsonSchema = schema;
      // If it looks like a Zod object, convert it. Otherwise treat it as a raw JSON schema.
      if (schema && typeof schema._def === 'object') {
        jsonSchema = zodToJsonSchema(schema);
      }
      const cleaned = this.cleanSchema(jsonSchema);
      cleaned.type = 'OBJECT'; 
      delete cleaned.additionalProperties; 
      return cleaned;
    } catch {
      return { type: 'OBJECT' };
    }
  }

  private cleanSchema(schema: any): any {
    if (typeof schema !== 'object' || schema === null) return schema;
    const cleaned = { ...schema };
    delete cleaned.$schema;
    delete cleaned.$ref;
    delete cleaned.$defs;
    delete cleaned.definitions;
    delete cleaned.additionalProperties; 
    
    if (cleaned.properties && typeof cleaned.properties === 'object') {
      const cls: any = {};
      for (const [k, v] of Object.entries(cleaned.properties)) {
        cls[k] = this.cleanSchema(v);
      }
      cleaned.properties = cls;
    }
    if (cleaned.items) cleaned.items = this.cleanSchema(cleaned.items);
    if (cleaned.properties && cleaned.type === undefined) cleaned.type = 'object';
    
    if (typeof cleaned.type === 'string') {
      cleaned.type = cleaned.type.toUpperCase();
    }
    
    return cleaned;
  }

  async *stream({ systemInstruction, messages, tools }: { systemInstruction?: string; messages: any[]; tools?: ToolSet }): AsyncGenerator<StreamPart, void, unknown> {
    const client = await this.ensureInit();

    const request: any = {
      model: this.model,
      contents: messages,
      config: {
        thinkingConfig: { thinkingLevel: 'HIGH' }
      }
    };

    if (systemInstruction) {
      request.config.systemInstruction = {
        role: 'user',
        parts: [{ text: systemInstruction }]
      };
    }

    if (tools && Object.keys(tools).length > 0) {
      const functionDeclarations = Object.entries(tools).map(([name, def]) => {
        return {
          name,
          description: def.description,
          parameters: this.zodToJsonSchema(def.parameters)
        };
      });
      request.config.tools = [{ functionDeclarations }];
    }

    let responseStream;
    let retries = 0;
    const MAX_RETRIES = 5;

    while (true) {
      try {
        responseStream = await client.generateContentStream(request, randomUUID());
        break;
      } catch (err: any) {
        const is429 = err?.status === 429 || err?.status === 'RESOURCE_EXHAUSTED' || (typeof err?.message === 'string' && err.message.includes('429'));
        if (is429 && retries < MAX_RETRIES) {
          retries++;
          yield { type: 'text-delta', text: `\n\n[Rate limit exceeded (429). Auto-retrying in 10 seconds... (Attempt ${retries}/${MAX_RETRIES})]\n\n` };
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }
        yield { type: 'finish-step', reason: 'error' };
        throw err;
      }
    }

    let finishReason: 'stop' | 'tool-calls' | 'length' | 'error' | 'other' = 'stop';
    const finalParts: any[] = [];
    
    for await (const chunk of responseStream) {
      const candidate = chunk.candidates?.[0];
      if (!candidate || !candidate.content || !candidate.content.parts) continue;
      
      for (const part of candidate.content.parts) {
        if (part.text !== undefined) {
          yield { type: 'text-delta', text: part.text };
          if (finalParts.length > 0 && finalParts[finalParts.length - 1].text !== undefined) {
             finalParts[finalParts.length - 1].text += part.text;
          } else {
             finalParts.push({ ...part });
          }
        } else {
          if (part.functionCall) {
            const toolCallId = randomUUID();
            yield {
              type: 'tool-call',
              toolCallId,
              toolName: part.functionCall.name || '',
              input: part.functionCall.args || {}
            };
            finishReason = 'tool-calls';
          }
          finalParts.push(part);
        }
      }

      if (candidate.finishReason && candidate.finishReason !== 'STOP') {
        if (candidate.finishReason === 'MAX_TOKENS') finishReason = 'length';
        else finishReason = 'other';
      }
    }

    if (finalParts.length > 0) {
      messages.push({
        role: 'model',
        parts: finalParts
      });
    }
    
    yield { type: 'finish-step', reason: finishReason };
  }
}

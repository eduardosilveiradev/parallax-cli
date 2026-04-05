import { AgentProvider } from './types.js';
import { GeminiProvider } from './gemini-provider.js';
import { GenericProvider } from './generic-provider.js';
import { AnthropicProvider } from './anthropic-provider.js';

export class OpenAIProvider extends GenericProvider {
  constructor(model: string) {
    super({
      name: 'openai',
      model,
      apiKey: process.env.OPENAI_API_KEY
    });
  }
}

export class OllamaProvider extends GenericProvider {
  constructor(model: string) {
    super({
      name: 'ollama',
      model,
      baseURL: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1'
    });
  }
}

export class LMStudioProvider extends GenericProvider {
  constructor(model: string) {
    super({
      name: 'lmstudio',
      model,
      baseURL: process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1'
    });
  }
}

export class VLLMProvider extends GenericProvider {
  constructor(model: string) {
    super({
      name: 'vllm',
      model,
      baseURL: process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1'
    });
  }
}

export class OpenRouterProvider extends GenericProvider {
  constructor(model: string) {
    super({
      name: 'openrouter',
      model,
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1'
    });
  }
}

export class ProviderFactory {
  static create(modelConfigString: string): AgentProvider {
    if (modelConfigString.startsWith('openai:')) {
      return new OpenAIProvider(modelConfigString.split(':')[1]);
    } else if (modelConfigString.startsWith('anthropic:')) {
       return new AnthropicProvider({
          name: 'anthropic',
          model: modelConfigString.split(':')[1]
       });
    } else if (modelConfigString.startsWith('ollama:')) {
       return new OllamaProvider(modelConfigString.substring('ollama:'.length));
    } else if (modelConfigString.startsWith('lmstudio:')) {
       return new LMStudioProvider(modelConfigString.substring('lmstudio:'.length));
    } else if (modelConfigString.startsWith('vllm:')) {
       return new VLLMProvider(modelConfigString.substring('vllm:'.length));
    } else if (modelConfigString.startsWith('openrouter:')) {
       return new OpenRouterProvider(modelConfigString.substring('openrouter:'.length));
    } else {
       // Default fallback to Gemini
       const model = modelConfigString.startsWith('gemini:') ? modelConfigString.split(':')[1] : modelConfigString;
       return new GeminiProvider(model);
    }
  }
}

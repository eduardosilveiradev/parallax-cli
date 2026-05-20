import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { VALID_GEMINI_MODELS, AuthType, getAuthTypeFromEnv } from '@google/gemini-cli-core';
import { GoogleAuth } from 'google-auth-library';

// Register gemini-3.5-flash as a valid Gemini model
VALID_GEMINI_MODELS.add('gemini-3.5-flash');

export interface ModelListing {
    id: string;
    label: string;
    provider: string;
    group: string;
}

const TIMEOUT_MS = 1000;

async function fetchWithTimeout(url: string, options: any = {}): Promise<Response> {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (err) {
        clearTimeout(id);
        throw err;
    }
}

async function getDynamicGeminiModels(): Promise<ModelListing[]> {
    const staticFallback = Array.from(VALID_GEMINI_MODELS as Set<string>)
        .filter(m => !m.includes('lite') && !m.includes('customtools'))
        .map(m => ({ id: `gemini:${m}`, label: m, provider: 'google', group: 'Google Gemini' }));

    const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
    if (!apiKey) {
        return staticFallback;
    }

    try {
        const res = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        if (!res.ok) return staticFallback;
        const json = await res.json();
        if (!json.models || !Array.isArray(json.models)) return staticFallback;

        const fetched = json.models
            .filter((m: any) => m.supportedGenerationMethods && m.supportedGenerationMethods.includes('generateContent'))
            .map((m: any) => {
                const cleanId = m.name.replace(/^models\//, '');
                return {
                    id: `gemini:${cleanId}`,
                    label: cleanId,
                    provider: 'google',
                    group: 'Google Gemini'
                };
            })
            .filter((m: any) => 
                (m.label.startsWith('gemini') || m.label.startsWith('gemma')) && 
                !m.label.includes('lite') && 
                !m.label.includes('customtools') && 
                !m.label.includes('embedding') && 
                !m.label.includes('text-')
            );

        const merged = [...staticFallback];
        for (const model of fetched) {
            if (!merged.some(m => m.id === model.id)) {
                merged.push(model);
            }
        }
        return merged;
    } catch {
        return staticFallback;
    }
}

async function getDynamicVertexModels(): Promise<ModelListing[]> {
    const staticFallback = Array.from(VALID_GEMINI_MODELS as Set<string>)
        .filter(m => !m.includes('lite') && !m.includes('customtools'))
        .map(m => ({ id: `vertex:${m}`, label: m, provider: 'vertex', group: 'Google Vertex AI' }));

    const hasVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' || 
                      !!process.env.GOOGLE_CLOUD_PROJECT || 
                      !!process.env.GOOGLE_CLOUD_PROJECT_ID;

    if (!hasVertex) {
        return [];
    }

    try {
        const auth = new GoogleAuth({
            scopes: 'https://www.googleapis.com/auth/cloud-platform'
        });
        
        const project = process.env.GOOGLE_CLOUD_PROJECT || 
                        process.env.GOOGLE_CLOUD_PROJECT_ID || 
                        await auth.getProjectId();
                        
        let location = process.env.GOOGLE_CLOUD_LOCATION || 'us-central1';
        if (location === 'global') {
            location = 'us-central1';
        }

        if (!project) {
            return staticFallback;
        }

        const client = await auth.getClient();
        const tokenResponse = await client.getAccessToken();
        const accessToken = tokenResponse.token;

        if (!accessToken) {
            return staticFallback;
        }

        const url = `https://${location}-aiplatform.googleapis.com/v1beta1/publishers/google/models`;
        const res = await fetchWithTimeout(
            url,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'x-goog-user-project': project
                }
            }
        );

        if (!res.ok) return staticFallback;
        const json = await res.json();
        if (!json.publisherModels || !Array.isArray(json.publisherModels)) return staticFallback;

        const fetched = json.publisherModels
            .map((m: any) => {
                const parts = m.name.split('/');
                const cleanId = parts[parts.length - 1];
                return {
                    id: `vertex:${cleanId}`,
                    label: cleanId,
                    provider: 'vertex',
                    group: 'Google Vertex AI'
                };
            })
            .filter((m: any) => 
                (m.label.startsWith('gemini') || m.label.startsWith('gemma')) && 
                !m.label.includes('lite') && 
                !m.label.includes('customtools') &&
                !m.label.includes('embedding')
            );

        const merged = [...staticFallback];
        for (const model of fetched) {
            if (!merged.some(m => m.id === model.id)) {
                merged.push(model);
            }
        }
        return merged;
    } catch (e: any) {
        console.error('[getDynamicVertexModels] Error:', e.message || e);
        return staticFallback;
    }
}

export async function fetchAvailableModels(): Promise<ModelListing[]> {
    const tasks: Promise<ModelListing[]>[] = [];

    // 1. Google Gemini (always available, dynamic + static fallback)
    tasks.push(getDynamicGeminiModels());

    // 2. Google Vertex AI (available if configured, dynamic + static fallback)
    const hasVertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === 'true' || 
                      !!process.env.GOOGLE_CLOUD_PROJECT || 
                      !!process.env.GOOGLE_CLOUD_PROJECT_ID;

    if (hasVertex) {
        tasks.push(getDynamicVertexModels());
    }

    // 2. OpenAI
    if (process.env.OPENAI_API_KEY) {
        tasks.push(
            (async () => {
                try {
                    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                    const list = await client.models.list();
                    return list.data
                        .filter(m => m.id.includes('gpt') || m.id.includes('o1') || m.id.includes('o3'))
                        .map(m => ({ id: `openai:${m.id}`, label: m.id, provider: 'openai', group: 'OpenAI' }));
                } catch { return []; }
            })()
        );
    }

    // 3. Anthropic
    if (process.env.ANTHROPIC_API_KEY) {
        tasks.push(
            (async () => {
                try {
                    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
                    const list = await client.models.list();
                    return list.data.map(m => ({ id: `anthropic:${m.id}`, label: m.id, provider: 'anthropic', group: 'Anthropic' }));
                } catch { return []; }
            })()
        );
    }

    // 4. Ollama (Local)
    tasks.push(
        (async () => {
            try {
                const baseURL = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
                const res = await fetchWithTimeout(`${baseURL}/api/tags`);
                if (!res.ok) return [];
                const json = await res.json();
                return json.models.map((m: any) => ({ id: `ollama:${m.name}`, label: m.name, provider: 'ollama', group: 'Ollama (Local)' }));
            } catch { return []; }
        })()
    );

    // 5. LMStudio (Local)
    tasks.push(
        (async () => {
            try {
                const baseURL = process.env.LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';
                const res = await fetchWithTimeout(`${baseURL}/models`);
                if (!res.ok) return [];
                const json = await res.json();
                return json.data.map((m: any) => ({ id: `lmstudio:${m.id}`, label: m.id, provider: 'lmstudio', group: 'LMStudio (Local)' }));
            } catch { return []; }
        })()
    );

    // 6. vLLM (Local)
    tasks.push(
        (async () => {
            try {
                const baseURL = process.env.VLLM_BASE_URL || 'http://127.0.0.1:8000/v1';
                const res = await fetchWithTimeout(`${baseURL}/models`);
                if (!res.ok) return [];
                const json = await res.json();
                return json.data.map((m: any) => ({ id: `vllm:${m.id}`, label: m.id, provider: 'vllm', group: 'vLLM (Local)' }));
            } catch { return []; }
        })()
    );

    // 7. OpenRouter
    if (process.env.OPENROUTER_API_KEY) {
        tasks.push(
            (async () => {
                try {
                    const client = new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' });
                    const list = await client.models.list();
                    return list.data.map(m => ({ id: `openrouter:${m.id}`, label: m.id, provider: 'openrouter', group: 'OpenRouter' }));
                } catch { return []; }
            })()
        );
    }

    const results = await Promise.allSettled(tasks);
    const finalModels: ModelListing[] = [];

    for (const result of results) {
        if (result.status === 'fulfilled') {
            finalModels.push(...result.value);
        }
    }

    // Sort them so local vs cloud groups natively cluster well visually.
    return finalModels;
}

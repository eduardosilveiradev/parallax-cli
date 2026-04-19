import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { VALID_GEMINI_MODELS } from '@google/gemini-cli-core';

export interface ModelListing {
    id: string;
    label: string;
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

export async function fetchAvailableModels(): Promise<ModelListing[]> {
    const tasks: Promise<ModelListing[]>[] = [];

    // 1. Google Gemini (Static fallback / CLI integrated)
    tasks.push(
        Promise.resolve(
            Array.from(VALID_GEMINI_MODELS as Set<string>)
                .filter(m => !m.includes('lite') && !m.includes('customtools'))
                .map(m => ({ id: `gemini:${m}`, label: m, group: 'Google Gemini' }))
        )
    );

    // 2. OpenAI
    if (process.env.OPENAI_API_KEY) {
        tasks.push(
            (async () => {
                try {
                    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
                    const list = await client.models.list();
                    return list.data
                        .filter(m => m.id.includes('gpt') || m.id.includes('o1') || m.id.includes('o3'))
                        .map(m => ({ id: `openai:${m.id}`, label: m.id, group: 'OpenAI' }));
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
                    return list.data.map(m => ({ id: `anthropic:${m.id}`, label: m.id, group: 'Anthropic' }));
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
                return json.models.map((m: any) => ({ id: `ollama:${m.name}`, label: m.name, group: 'Ollama (Local)' }));
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
                return json.data.map((m: any) => ({ id: `lmstudio:${m.id}`, label: m.id, group: 'LMStudio (Local)' }));
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
                return json.data.map((m: any) => ({ id: `vllm:${m.id}`, label: m.id, group: 'vLLM (Local)' }));
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
                    return list.data.map(m => ({ id: `openrouter:${m.id}`, label: m.id, group: 'OpenRouter' }));
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

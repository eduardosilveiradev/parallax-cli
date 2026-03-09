// ─────────────────────────────────────────────────────────────────
//  store.ts — Conversation persistence for parallax-cli
//
//  Saves and loads conversations as JSON files under
//  ~/.parallax/conversations/<id>.json
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { nanoid } from "nanoid";
import type { ChatMessage } from "./providers.js";

// ── Types ──────────────────────────────────────────────────────

export interface Conversation {
    id: string;
    title: string;
    model: string;
    provider: string;
    createdAt: string;
    updatedAt: string;
    messages: ChatMessage[];
    displayData?: Record<string, unknown>;
}

export interface ConversationSummary {
    id: string;
    title: string;
    model: string;
    provider: string;
    createdAt: string;
    updatedAt: string;
    messageCount: number;
    lastMessage: string;
}

// ── Paths ──────────────────────────────────────────────────────

const PARALLAX_DIR = path.join(os.homedir(), ".parallax");
const CONVERSATIONS_DIR = path.join(PARALLAX_DIR, "conversations");

// ── Helpers ────────────────────────────────────────────────────

/** Generate a short random conversation ID (8 hex chars). */
export function generateId(): string {
    return nanoid(12);
}

/** Derive a title from the first user message (truncated fallback). */
export function deriveTitle(messages: ChatMessage[]): string {
    const first = messages.find((m) => m.role === "user");
    if (!first) return "untitled";
    const oneLine = first.content.replace(/\s+/g, " ").trim();
    return oneLine.length > 80 ? oneLine.slice(0, 77) + "…" : oneLine;
}

/** Generate a short title using qwen3:14b via Ollama. Falls back to deriveTitle. */
export async function generateTitle(messages: ChatMessage[]): Promise<string> {
    try {
        const convo = messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .slice(0, 4)
            .map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
            .join("\n");

        const res = await fetch("http://localhost:11434/api/generate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "qwen3:14b",
                prompt: `/no_think\nGenerate a short title (max 6 words) for this conversation. Reply with ONLY the title, no quotes or punctuation.\n\n${convo}`,
                stream: false,
            }),
        });

        if (!res.ok) return deriveTitle(messages);
        const data = (await res.json()) as { response?: string };
        const title = (data.response ?? "").replace(/^["']|["']$/g, "").trim();
        return title.length > 0 && title.length <= 80 ? title : deriveTitle(messages);
    } catch {
        return deriveTitle(messages);
    }
}

/** Ensure the conversations directory exists. */
export async function ensureDir(): Promise<void> {
    await fs.mkdir(CONVERSATIONS_DIR, { recursive: true });
}

// ── CRUD ───────────────────────────────────────────────────────

/** Save (create or overwrite) a conversation to disk. */
export async function saveConversation(conv: Conversation): Promise<void> {
    await ensureDir();
    const filePath = path.join(CONVERSATIONS_DIR, `${conv.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(conv, null, 2), "utf-8");
}

/** Load a single conversation by ID. Returns null if not found. */
export async function loadConversation(id: string): Promise<Conversation | null> {
    try {
        const filePath = path.join(CONVERSATIONS_DIR, `${id}.json`);
        const raw = await fs.readFile(filePath, "utf-8");
        return JSON.parse(raw) as Conversation;
    } catch {
        return null;
    }
}

/** List all saved conversations, sorted by most recent first. */
export async function listConversations(): Promise<ConversationSummary[]> {
    await ensureDir();
    const files = await fs.readdir(CONVERSATIONS_DIR);
    const summaries: ConversationSummary[] = [];

    for (const file of files) {
        if (!file.endsWith(".json")) continue;
        try {
            const raw = await fs.readFile(
                path.join(CONVERSATIONS_DIR, file),
                "utf-8",
            );
            const conv = JSON.parse(raw) as Conversation;
            summaries.push({
                id: conv.id,
                title: conv.title,
                model: conv.model,
                provider: conv.provider,
                createdAt: conv.createdAt,
                updatedAt: conv.updatedAt,
                messageCount: conv.messages.length,
                lastMessage: conv.messages.length > 0
                    ? conv.messages[conv.messages.length - 1]!.content.replace(/\s+/g, " ").trim().slice(0, 120)
                    : "",
            });
        } catch {
            // skip corrupted files
        }
    }

    // Most recent first
    summaries.sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    return summaries;
}

/** Delete a conversation file. Returns true if it existed. */
export async function deleteConversation(id: string): Promise<boolean> {
    try {
        const filePath = path.join(CONVERSATIONS_DIR, `${id}.json`);
        await fs.unlink(filePath);
        return true;
    } catch {
        return false;
    }
}

/** Delete ALL saved conversations. Returns the number deleted. */
export async function deleteAllConversations(): Promise<number> {
    await ensureDir();
    const files = await fs.readdir(CONVERSATIONS_DIR);
    let count = 0;
    for (const file of files) {
        if (!file.endsWith(".json")) continue;
        await fs.unlink(path.join(CONVERSATIONS_DIR, file));
        count++;
    }
    return count;
}

// ── Last-used model (derived from most recent conversation) ────

/** Get the model and provider from the most recent conversation. */
export async function getLastModel(): Promise<{ model: string; provider: string } | null> {
    const convos = await listConversations();
    if (convos.length === 0) return null;
    return { model: convos[0]!.model, provider: convos[0]!.provider };
}

// TEST EDIT: This line was added to demonstrate git diffs functionality

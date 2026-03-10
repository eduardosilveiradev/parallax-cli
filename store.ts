// ─────────────────────────────────────────────────────────────────
//  store.ts — Conversation persistence for parallax-cli
//
//  Uses Neon Postgres when DATABASE_URL is set, otherwise falls
//  back to local filesystem storage (~/.parallax/conversations/).
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
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

// ── Helpers ────────────────────────────────────────────────────

/** Generate a short random conversation ID. */
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

// ── Storage backend interface ─────────────────────────────────

interface StorageBackend {
    save(conv: Conversation): Promise<void>;
    load(id: string): Promise<Conversation | null>;
    list(): Promise<ConversationSummary[]>;
    remove(id: string): Promise<boolean>;
    removeAll(): Promise<number>;
}

// ═══════════════════════════════════════════════════════════════
//  Neon Postgres backend
// ═══════════════════════════════════════════════════════════════

function createNeonBackend(databaseUrl: string): StorageBackend {
    type NeonSql = ReturnType<typeof import("@neondatabase/serverless").neon>;
    let _sql: NeonSql | null = null;
    const getSql = async (): Promise<NeonSql> => {
        if (!_sql) {
            const { neon } = await import("@neondatabase/serverless");
            _sql = neon(databaseUrl, { fullResults: false }) as NeonSql;
        }
        return _sql;
    };

    // Auto-create table on first use
    let initialized = false;
    const init = async () => {
        if (initialized) return;
        const sql = await getSql();
        await sql`
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'untitled',
                model TEXT NOT NULL DEFAULT '',
                provider TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                messages JSONB NOT NULL DEFAULT '[]'::jsonb,
                display_data JSONB
            )
        `;
        initialized = true;
    };

    return {
        async save(conv) {
            await init();
            const sql = await getSql();
            const messagesJson = JSON.stringify(conv.messages);
            const displayDataJson = conv.displayData ? JSON.stringify(conv.displayData) : null;
            await sql`
                INSERT INTO conversations (id, title, model, provider, created_at, updated_at, messages, display_data)
                VALUES (${conv.id}, ${conv.title}, ${conv.model}, ${conv.provider}, ${conv.createdAt}, ${conv.updatedAt}, ${messagesJson}::jsonb, ${displayDataJson}::jsonb)
                ON CONFLICT (id) DO UPDATE SET
                    title = EXCLUDED.title,
                    model = EXCLUDED.model,
                    provider = EXCLUDED.provider,
                    updated_at = EXCLUDED.updated_at,
                    messages = EXCLUDED.messages,
                    display_data = EXCLUDED.display_data
            `;
        },

        async load(id) {
            await init();
            const sql = await getSql();
            const rows = await sql`SELECT * FROM conversations WHERE id = ${id}` as Record<string, unknown>[];
            if (rows.length === 0) return null;
            const r = rows[0]!;
            return {
                id: r.id as string,
                title: r.title as string,
                model: r.model as string,
                provider: r.provider as string,
                createdAt: String(r.created_at),
                updatedAt: String(r.updated_at),
                messages: r.messages as ChatMessage[],
                displayData: (r.display_data as Record<string, unknown>) ?? undefined,
            };
        },

        async list() {
            await init();
            const sql = await getSql();
            const rows = await sql`
                SELECT id, title, model, provider, created_at, updated_at, messages
                FROM conversations ORDER BY updated_at DESC
            `;
            return (rows as Record<string, unknown>[]).map((r) => {
                const msgs = r.messages as ChatMessage[];
                return {
                    id: r.id as string,
                    title: r.title as string,
                    model: r.model as string,
                    provider: r.provider as string,
                    createdAt: String(r.created_at),
                    updatedAt: String(r.updated_at),
                    messageCount: msgs.length,
                    lastMessage: msgs.length > 0
                        ? msgs[msgs.length - 1]!.content.replace(/\s+/g, " ").trim().slice(0, 120)
                        : "",
                };
            });
        },

        async remove(id) {
            await init();
            const sql = await getSql();
            const rows = await sql`DELETE FROM conversations WHERE id = ${id} RETURNING id` as Record<string, unknown>[];
            return rows.length > 0;
        },

        async removeAll() {
            await init();
            const sql = await getSql();
            const rows = await sql`DELETE FROM conversations RETURNING id` as Record<string, unknown>[];
            return rows.length;
        },
    };
}

// ═══════════════════════════════════════════════════════════════
//  Filesystem backend (local dev fallback)
// ═══════════════════════════════════════════════════════════════

function createFsBackend(): StorageBackend {
    const PARALLAX_DIR = path.join(os.homedir(), ".parallax");
    const CONVERSATIONS_DIR = path.join(PARALLAX_DIR, "conversations");

    const ensureDir = async () => {
        await fs.mkdir(CONVERSATIONS_DIR, { recursive: true });
    };

    return {
        async save(conv) {
            await ensureDir();
            await fs.writeFile(
                path.join(CONVERSATIONS_DIR, `${conv.id}.json`),
                JSON.stringify(conv, null, 2),
                "utf-8",
            );
        },

        async load(id) {
            try {
                const raw = await fs.readFile(
                    path.join(CONVERSATIONS_DIR, `${id}.json`),
                    "utf-8",
                );
                return JSON.parse(raw) as Conversation;
            } catch {
                return null;
            }
        },

        async list() {
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
                } catch { /* skip corrupted */ }
            }
            summaries.sort(
                (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
            );
            return summaries;
        },

        async remove(id) {
            try {
                await fs.unlink(path.join(CONVERSATIONS_DIR, `${id}.json`));
                return true;
            } catch {
                return false;
            }
        },

        async removeAll() {
            await ensureDir();
            const files = await fs.readdir(CONVERSATIONS_DIR);
            let count = 0;
            for (const file of files) {
                if (!file.endsWith(".json")) continue;
                await fs.unlink(path.join(CONVERSATIONS_DIR, file));
                count++;
            }
            return count;
        },
    };
}

// ═══════════════════════════════════════════════════════════════
//  Pick backend + export public API
// ═══════════════════════════════════════════════════════════════

const backend: StorageBackend = process.env.DATABASE_URL
    ? (() => { console.log("📦 Store: Neon Postgres"); return createNeonBackend(process.env.DATABASE_URL!); })()
    : (() => { console.log("📦 Store: local filesystem (~/.parallax/conversations/)"); return createFsBackend(); })();

export const saveConversation = (conv: Conversation) => backend.save(conv);
export const loadConversation = (id: string) => backend.load(id);
export const listConversations = () => backend.list();
export const deleteConversation = (id: string) => backend.remove(id);
export const deleteAllConversations = () => backend.removeAll();

// ── Last-used model (derived from most recent conversation) ────

export async function getLastModel(): Promise<{ model: string; provider: string } | null> {
    const convos = await listConversations();
    if (convos.length === 0) return null;
    return { model: convos[0]!.model, provider: convos[0]!.provider };
}

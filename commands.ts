// ─────────────────────────────────────────────────────────────────
//  commands.ts — Slash-command registry for parallax-cli
//
//  Each command has metadata (name, description) AND an action
//  callback that receives an AppContext, giving it access to
//  application state and mutators without importing React hooks.
// ─────────────────────────────────────────────────────────────────

import { writeFileSync } from "node:fs";
import { listProviders, getProvider, ChatMessage } from "./providers.js";
import type { ConversationSummary, Conversation } from "./store.js";
import { deleteAllConversations } from "./store.js";

/** Subset of app state/actions exposed to command handlers. */
export interface AppContext {
    /** Quit the application. */
    exit: () => void;
    /** Clear all displayed messages. */
    clearMessages: () => void;
    /** Reset the agent's conversation memory. */
    resetHistory: () => void;
    /** Inject a system-style message into the chat display. */
    addSystemMessage: (content: string) => void;
    /** Send a message to the agent as if the user typed it. */
    sendMessage: (content: string) => void;
    /** Connected MCP servers (read-only snapshot). */
    mcpConnections: {
        config: { name: string };
        tools: { function: { name: string } }[];
    }[];
    /** The active model identifier. */
    model: string;
    /** Switch the active model. */
    setModel: (model: string) => void;
    /** The active provider name. */
    provider: string;
    /** Switch the active provider. */
    setProvider: (provider: string) => void;
    /** Current conversation ID. */
    conversationId: string;
    /** Conversation history. */
    conversationHistory: ChatMessage[];
    /** Load a saved conversation by ID. */
    loadConversation: (id: string) => Promise<void>;
    /** List all saved conversations. */
    listConversations: () => Promise<ConversationSummary[]>;
    /** Delete a saved conversation. */
    deleteConversation: (id: string) => Promise<boolean>;
    /** OTP for /deleteall confirmation (getter/setter). */
    deleteAllOtp: { current: string | null };
}

export interface Command {
    name: string;
    description: string;
    args: string[];
    action: (ctx: AppContext, args: string[]) => void;
}

// ── Command definitions ────────────────────────────────────────

export const commands: Record<string, Command> = {
    exit: {
        name: "exit",
        description: "Exit the application",
        args: [],
        action: (ctx) => {
            ctx.exit();
        },
    },

    help: {
        name: "help",
        description: "Show all available commands",
        args: [],
        action: (ctx) => {
            const lines = Object.entries(commands).map(
                ([key, cmd]) => `  /${key}  —  ${cmd.description}`,
            );
            ctx.addSystemMessage(
                "**Available commands**\n\n" + lines.join("\n"),
            );
        },
    },

    clear: {
        name: "clear",
        description: "Clear the chat display",
        args: [],
        action: (ctx) => {
            ctx.clearMessages();
        },
    },

    model: {
        name: "model",
        description: "Switch model (/model <name>) or show current",
        args: ["name?"],
        action: (ctx, args) => {
            if (args.length > 0) {
                const newModel = args.join(" ");
                ctx.setModel(newModel);
                ctx.addSystemMessage(`Switched model to **${newModel}**`);
            } else {
                ctx.addSystemMessage(`Current model: **${ctx.model}**\n\nUse \`/model <name>\` to switch.`);
            }
        },
    },

    mcp: {
        name: "mcp",
        description: "List connected MCP servers and tools",
        args: [],
        action: (ctx) => {
            if (ctx.mcpConnections.length === 0) {
                ctx.addSystemMessage("No MCP servers connected.");
                return;
            }
            const lines = ctx.mcpConnections.map((c) => {
                const toolNames = c.tools
                    .map((t) => t.function.name)
                    .join(", ");
                return `  **${c.config.name}** — ${c.tools.length} tools\n    ${toolNames}`;
            });
            ctx.addSystemMessage(
                "**Connected MCP servers**\n\n" + lines.join("\n\n"),
            );
        },
    },

    reset: {
        name: "reset",
        description: "Reset conversation memory (agent forgets context)",
        args: [],
        action: (ctx) => {
            ctx.resetHistory();
            ctx.addSystemMessage("Conversation memory cleared.");
        },
    },

    dump: {
        name: "dump",
        description: "Dump conversation history",
        args: [],
        action: (ctx) => {
            writeFileSync("./conversation-history.json", JSON.stringify(ctx.conversationHistory, null, 2));
            ctx.addSystemMessage("Conversation history dumped to ./conversation-history.json");
        },
    },

    provider: {
        name: "provider",
        description: "Switch provider (/provider <name>) or list all",
        args: ["name?"],
        action: (ctx, args) => {
            if (args.length > 0) {
                const name = args[0]!;
                try {
                    getProvider(name); // validate it exists
                    ctx.setProvider(name);
                    ctx.addSystemMessage(`Switched provider to **${name}**`);
                } catch {
                    ctx.addSystemMessage(`Unknown provider: **${name}**`);
                }
            } else {
                const providers = listProviders();
                const lines = providers.map(
                    (p) => `  ${p.name === ctx.provider ? "▶" : " "} **${p.name}** — ${p.label}\n`,
                );
                ctx.addSystemMessage(
                    `**Providers** (active: ${ctx.provider})\n\n` + lines.join("\n") + "\n\nUse \`/provider <name>\` to switch.",
                );
            }
        },
    },

    init: {
        name: "init",
        description: "Generate a PARALLAX.md project instruction file",
        args: [],
        action: (ctx) => {
            ctx.addSystemMessage("Starting project analysis to generate **PARALLAX.md**…");
            ctx.sendMessage(
                `Analyze this project and create a PARALLAX.md file in the current working directory.

IMPORTANT INSTRUCTIONS:
1. First, use executeTerminalCommand to list the project structure (e.g. ls or dir, and find/list key files).
2. Read important files like package.json, tsconfig.json, README.md, any config files, and a few representative source files to understand the codebase.
3. Based on your analysis, create a comprehensive PARALLAX.md file using patchLocalFile.

The PARALLAX.md file should follow this structure:

# Project Name

One-line description of what this project is.

## Overview
Brief explanation of the project's purpose, scope, and goals.

## Tech Stack
List the languages, frameworks, runtimes, and key dependencies.

## Architecture
Describe the high-level structure: how modules/files relate to each other, data flow, entry points.

## Code Style & Conventions
- Naming conventions (files, variables, functions, classes)
- Import style and module system
- Formatting preferences (indentation, quotes, semicolons)
- TypeScript strictness level if applicable

## Key Patterns
Document recurring patterns in the codebase (e.g. factory pattern, event-driven, hooks-based, etc.)

## Project Structure
Brief annotated tree of the most important files/directories.

## Common Commands
List dev, build, test, and deploy commands.

## Important Notes
Any gotchas, known issues, environment requirements, or things a developer should know before contributing.

Make the content specific to THIS project — not generic boilerplate. Reference actual file names, actual dependencies, actual patterns you observe. Keep it concise but comprehensive.`,
            );
        },
    },

    history: {
        name: "history",
        description: "List recent saved conversations",
        args: [],
        action: async (ctx) => {
            const convos = await ctx.listConversations();
            if (convos.length === 0) {
                ctx.addSystemMessage("No saved conversations.");
                return;
            }
            const lines = convos.slice(0, 15).map((c) => {
                const date = new Date(c.updatedAt).toLocaleString();
                return `  \`${c.id}\`  ${c.title}  *(${date}, ${c.messageCount} msgs)*\n`;
            });
            ctx.addSystemMessage(
                "**Saved conversations**\n\n" + lines.join("\n") +
                "\n\nUse `/load <id>` to restore.",
            );
        },
    },

    load: {
        name: "load",
        description: "Load a saved conversation (/load <id>)",
        args: ["id"],
        action: async (ctx, args) => {
            if (args.length === 0) {
                ctx.addSystemMessage("Usage: `/load <id>` — use `/history` to see IDs.");
                return;
            }
            try {
                await ctx.loadConversation(args[0]!);
            } catch (err: any) {
                ctx.addSystemMessage(`Failed to load: ${err.message}`);
            }
        },
    },

    delete: {
        name: "delete",
        description: "Delete a saved conversation (/delete <id>)",
        args: ["id"],
        action: async (ctx, args) => {
            if (args.length === 0) {
                ctx.addSystemMessage("Usage: `/delete <id>` — use `/history` to see IDs.");
                return;
            }
            const ok = await ctx.deleteConversation(args[0]!);
            if (ok) {
                ctx.addSystemMessage(`Deleted conversation \`${args[0]}\`.`);
            } else {
                ctx.addSystemMessage(`Conversation \`${args[0]}\` not found.`);
            }
        },
    },

    deleteall: {
        name: "deleteall",
        description: "Delete all saved conversations (requires OTP)",
        args: ["otp"],
        action: async (ctx, args) => {
            if (args.length === 0) {
                const otp = String(Math.floor(1000 + Math.random() * 9000));
                ctx.deleteAllOtp.current = otp;
                ctx.addSystemMessage(
                    `⚠️ This will **permanently delete ALL** saved conversations.\n\n` +
                    `To confirm, type: \`/deleteall ${otp}\``,
                );
                return;
            }
            if (!ctx.deleteAllOtp.current || args[0] !== ctx.deleteAllOtp.current) {
                ctx.addSystemMessage("Invalid or expired OTP. Run `/deleteall` again to get a new code.");
                return;
            }
            const count = await deleteAllConversations();
            ctx.deleteAllOtp.current = null;
            ctx.addSystemMessage(`Deleted **${count}** conversation${count !== 1 ? "s" : ""}.`);
        },
    },
};
// ─────────────────────────────────────────────────────────────────
//  commands.ts — Slash-command registry for parallax-cli
//
//  Each command has metadata (name, description) AND an action
//  callback that receives an AppContext, giving it access to
//  application state and mutators without importing React hooks.
// ─────────────────────────────────────────────────────────────────

import { listProviders, getProvider } from "./providers.js";

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
                    (p) => `  ${p.name === ctx.provider ? "▶" : " "} **${p.name}** — ${p.label}`,
                );
                ctx.addSystemMessage(
                    `**Providers** (active: ${ctx.provider})\n\n` + lines.join("\n") + "\n\nUse \`/provider <name>\` to switch.",
                );
            }
        },
    },
};
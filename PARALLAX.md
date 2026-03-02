# Parallax CLI

A terminal-based AI agentic code assistant powered by Ink (React for terminals).

## Overview

Parallax CLI is an awesome interactive command-line interface that provides an AI-powered coding assistant directly in the terminal. It features a rich terminal UI built with React and Ink, supports multiple LLM providers (Ollama, OpenAI, Anthropic, Google Gemini, OpenRouter), and can execute tools like file operations, terminal commands, and remote VPS interactions. The assistant follows a strict protocol for tool usage and maintains conversation context.

## Tech Stack

- **Language**: TypeScript 5.9.3 (ES2022)
- **Runtime**: Node.js with ES modules (`"type": "module"`)
- **UI Framework**: Ink 6.8.0 (React 19.2.4 for terminals)
- **LLM Integration**: Multiple providers via custom Provider interface
- **MCP (Model Context Protocol)**: @modelcontextprotocol/sdk 1.27.1
- **Build Tools**: tsx 4.21.0 (dev), tsc (build)
- **Utilities**: 
  - chalk 5.6.2 (styling)
  - diff 8.0.3 (diff parsing)
  - marked 17.0.3 + marked-terminal 7.3.0 (markdown rendering)

## Architecture

### High-Level Structure

```
┌─────────────────────────────────────────────────────────────┐
│                         index.tsx                            │
│  (Main entry - React/Ink app, event handling, UI layout)      │
├─────────────────────────────────────────────────────────────┤
│                         agent.ts                             │
│  (Core orchestration - runAgent generator, tool dispatch)     │
├─────────────────────────────────────────────────────────────┤
│                      providers.ts                            │
│  (LLM provider implementations - Ollama, OpenAI, etc.)       │
├─────────────────────────────────────────────────────────────┤
│                      mcp-client.ts                           │
│  (MCP client service - connect, discover, call tools)        │
├─────────────────────────────────────────────────────────────┤
│                       commands.ts                            │
│  (Slash-command registry - /help, /model, /clear, etc.)         │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **User Input** → `index.tsx` captures keystrokes via `useInput`
2. **Slash Commands** → Routed to `commands.ts` for execution
3. **Chat Messages** → Sent to `agent.ts` `runAgent()` generator
4. **LLM Streaming** → Provider in `providers.ts` streams tokens
5. **Tool Calls** → Dispatched via `dispatchTool()` or `dispatchMCPTool()`
6. **Results** → Appended to conversation history, re-trigger LLM
7. **UI Updates** → AgentEvents yielded to update Ink components

### Key Components (Ink)

- `App` - Main application container, state management
- `Header` - Shows current model/provider
- `MessageRow` - Renders chat messages with markdown support
- `StreamingRow` - Shows streaming LLM output with cursor
- `InputLine` - User input with multi-line support
- `CommandPalette` - Slash-command autocomplete UI
- `ModelPalette` - Model selection UI
- `ToolBadge` - Shows active/completed tool executions

## Code Style & Conventions

### Naming Conventions
- **Files**: kebab-case (`mcp-client.ts`, `diff-view.ts`)
- **Types/Interfaces**: PascalCase (`AgentEvent`, `ChatMessage`)
- **Functions**: camelCase (`runAgent`, `dispatchTool`)
- **Constants**: UPPER_SNAKE_CASE (`DEFAULT_MODEL`, `MAX_TOOL_ITERATIONS`)

### Import Style
- ES modules only (`"type": "module"` in package.json)
- Explicit `.js` extensions on imports (Node.js ESM requirement)
- Named imports preferred over default imports
- Example: `import { runAgent } from "./agent.js"`

### Formatting Preferences
- Indentation: 4 spaces (observed in source files)
- Semicolons: required
- Quotes: double quotes for strings
- Trailing commas: used in objects/arrays
- Line length: ~100-120 characters

### TypeScript Configuration
- `strict: true` enabled
- `module: "nodenext"` with `moduleResolution: "nodenext"`
- JSX: `"react-jsx"` for React 17+ transform
- Target: ES2022

## Key Patterns

### 1. Generator-Based Streaming (`agent.ts`)
```typescript
export async function* runAgent(...): AsyncGenerator<AgentEvent>
```
- Yields typed events for UI updates
- Supports cancellation via `break` from consumer
- Handles tool execution loops with iteration limits

### 2. Provider Pattern (`providers.ts`)
```typescript
export interface Provider {
    readonly name: string;
    readonly label: string;
    stream(messages, model, tools): AsyncIterable<StreamChunk>;
    listModels(): Promise<string[]>;
}
```
- Pluggable architecture for LLM backends
- Registry pattern with `providerRegistry` Map
- Consistent streaming interface across all providers

### 3. MCP Tool Prefixing
- Local tools: `readLocalFile`, `executeTerminalCommand`
- MCP tools: prefixed with `mcp_<server>_<toolname>`
- Tool name map tracks prefixed → original name mapping

### 4. Event-Driven UI Updates
- AgentEvent union type for all possible events
- UI components react to events without polling
- Tool badges, status lines, streaming text all event-driven

### 5. Command Pattern (`commands.ts`)
```typescript
export const commands: Record<string, Command> = {
    exit: { name, description, args, action },
    // ...
}
```
- Slash commands self-contained with metadata
- Actions receive `AppContext` for state access
- Palette UI auto-generates from command registry

### 6. System Prompt Building
- `buildSystemPrompt()` in `agent.ts`
- Dynamically loads `PARALLAX.md` if present
- Injects runtime info (platform, date)

## Project Structure

```
.
├── index.tsx              # Entry point - Ink React app
├── agent.ts               # Core agent orchestration + tool dispatch
├── providers.ts           # LLM provider implementations
├── mcp-client.ts          # MCP client service
├── commands.ts            # Slash-command registry
├── diff-view.ts           # Diff rendering utilities
├── marked-terminal.d.ts   # Type declarations for marked-terminal
├── package.json           # Project config (type: module)
├── tsconfig.json          # TypeScript strict config
├── PARALLAX.md            # This file
└── node_modules/          # Dependencies
```

## Common Commands

```bash
# Development (hot reload)
pnpm dev              # tsx index.tsx

# Build
pnpm build            # tsc → dist/

# Run compiled
pnpm start            # node dist/index.js

# Install globally
npm link              # Makes `parallax` CLI available globally
```

## Important Notes

### Environment Variables
- `OLLAMA_HOST` / `OLLAMA_PORT` - Ollama server connection (default: localhost:11434)
- `OLLAMA_MODEL` - Default model for Ollama (default: cogito:14b)
- `OPENAI_API_KEY` - Required for OpenAI provider
- `ANTHROPIC_API_KEY` - Required for Anthropic provider
- `GOOGLE_API_KEY` - Required for Google Gemini provider
- `OPENROUTER_API_KEY` - Required for OpenRouter provider
- `PARALLAX_MCP_SERVERS` - JSON array of MCP server configs

### MCP Server Configuration
Default MCP server (filesystem) is auto-connected. Override with:
```bash
export PARALLAX_MCP_SERVERS='[{"name":"filesystem","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/path"]}]'
```

### Key Behaviors
1. **Tool Protocol**: Assistant only calls tools when explicitly requested by user
2. **Tool Results**: System injects results as `role: "tool"` messages - assistant must NOT greet or restart
3. **Multi-line Input**: Alt+Enter for newlines in input
4. **Command Palette**: Type `/` then Tab/Arrow keys to autocomplete
5. **Model Palette**: `/model` opens interactive model selector
6. **Context Display**: Shows estimated token count in status bar

### Limitations
- Max tool iterations: 10 (prevents runaway loops)
- Streaming timeout: 30s for terminal commands
- MCP tools: only filesystem server bundled by default

### Extension Points
- Add new providers: implement `Provider` interface + register in `providerRegistry`
- Add new local tools: define in `TOOL_DEFINITIONS` + implement in `dispatchTool()`
- Add slash commands: add to `commands` record in `commands.ts`

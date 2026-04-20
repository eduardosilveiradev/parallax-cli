# Parallax CLI: Comprehensive Architecture & System Overview

Parallax is a high-performance, terminal-native AI coding assistant designed for seamless pair programming. It leverages a reactive UI, multi-provider LLM orchestration, and an extensible tool-and-skill architecture to provide a powerful developer environment directly in the command line.

## 1. Core Architectural Pillars

*   **Reactive UI Layer (`src/app.tsx`)**: Built with **React** and **Ink**, Parallax manages a complex, stateful terminal interface. It features real-time streaming, interactive pickers for models and sessions, and a custom CLI with auto-suggestion for slash commands.
*   **Agent Orchestration (`src/agent/`)**:
    *   **ToolLoopAgent**: A custom ReAct (Reasoning and Acting) loop implementation that manages multi-step interactions, allowing the model to call multiple tools sequentially or in parallel.
    *   **Provider Pattern**: Supports multiple LLM backends (Gemini, Anthropic, OpenAI) through a unified interface (`provider-factory.ts`), enabling easy model switching and future-proofing.
    *   **Context Management**: Handles conversation history, persistence in `~/.parallax/`, and history compaction (`/compact`) to optimize token usage and context window efficiency.

## 2. The Tooling & Capability System

*   **Native Tools (`src/tools.ts`)**: A suite of asynchronous primitives for filesystem manipulation (`ViewFile`, `WriteToFile`, `ReplaceFileContent`, `MultiReplaceFileContent`), codebase exploration (`GrepSearch`, `ListDir`), and system interaction (`RunCommand`, `ReadClipboard`).
*   **Model Context Protocol (MCP) (`src/mcp.ts`)**: Dynamically connects to external MCP servers (e.g., git, fetch) via `StdioClientTransport`. It discovers and injects remote tools as native agent capabilities, configurable via `~/.parallax/mcp-config.json`.
*   **Skill System (`src/skills.ts`)**: An extensible system that discovers `SKILL.md` files in workspace-local (`.agents/`) or global (`~/.agents/`) directories. These provide specialized instructions and can be loaded on-demand via the `loadSkill` tool.
*   **Multi-Agent Coordination**: Features a master-coordinator pattern (accessible via `/parallax`) where a high-tier model orchestrates specialized subagents to solve complex, multi-faceted tasks concurrently.

## 3. Advanced Features & Execution Modes

*   **Execution Modes**: Supports specialized behaviors through modes:
    *   **Agent**: Standard problem-solving and implementation.
    *   **Plan**: Focuses on architectural design and step-by-step planning before execution.
    *   **Debug**: Optimized for bug hunting, state reasoning, and log analysis.
*   **Interactive Controls**:
    *   **YOLO Mode**: Toggled via `Shift+Tab`, allowing the agent to execute tool calls without explicit user confirmation for faster iteration.
    *   **Verbose Mode**: Toggled via `Ctrl+O`, providing deep visibility into tool arguments and raw outputs.
    *   **Diff-Based Editing**: Integrates with native IDE diff editors when available, allowing users to review and accept code changes interactively.
*   **Command Suite**: A comprehensive set of slash commands for environment control:
    *   `/model`: Hot-switch between AI providers.
    *   `/init`: Re-generates this architectural overview to maintain agent alignment.
    *   `/compact`: Compresses history to stay within context limits.
    *   `/commit`, `/commit:pr`: Autonomous Git workflow integration for committing and submitting pull requests.
    *   `/skills`: Interactive installer for adding new capabilities from external repositories.

## 4. Technical Stack & Safety

*   **Runtime**: Powered by `Node.js` and `tsx` for high-performance TypeScript execution.
*   **LLM Integration**: Utilizes `@google/genai`, Vercel `ai` SDK, and provider-specific SDKs.
*   **Search**: Implements `threadedSearch` in `fast-search.ts` for rapid local codebase indexing without external dependencies.
*   **Safety**: Implements strict abort controllers for interrupting rogue generations and provides signal handling for clean exits and process cleanup.
*   **IPC & Server**: Uses an Express-based server (`src/server.ts`) and IPC (`src/ipc.ts`) for handling external events and maintaining state across sessions.

This documentation serves as the primary system prompt and ground truth for the Parallax agent, ensuring consistent behavior and architectural awareness across sessions.

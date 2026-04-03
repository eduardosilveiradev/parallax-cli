# Parallax CLI: Architecture & System Overview

Parallax is a high-performance, terminal-based AI coding assistant built with **React** and **Ink**. It leverages the **Google Gemini** family of models to provide a seamless, tool-augmented development experience directly from the command line.

## Core Architectural Pillars

1.  **Reactive UI Layer (`src/app.tsx`)**:
    Utilizes `ink` to manage a complex, stateful terminal interface. It handles real-time streaming, interactive pickers (for models and sessions), and a custom command-line interface with auto-suggestion capabilities for slash commands (`/model`, `/new`, `/init`, `/compact`, `/load`).

2.  **Agent Orchestration (`src/agent/`)**:
    *   **ToolLoopAgent**: A manual implementation of the ReAct (Reasoning and Acting) loop. It manages multi-step interactions where the model can call multiple tools sequentially before returning a final response.
    *   **GeminiProvider**: A dedicated provider that maps internal message structures to the Gemini API requirements, supporting system instructions and native tool definitions.
    *   **Streaming**: Supports granular delta updates for both text and tool call states, providing immediate feedback during long-running operations.

3.  **Tooling System (`src/tools.ts`)**:
    A set of secure, asynchronous primitive tools that grant the agent capabilities to:
    *   `listDirectory`: Inspect workspace structure.
    *   `readFile` / `writeFile`: Manipulate source code with high-capacity buffers.
    *   `runCommand`: Execute shell commands, enabling compilation, testing, and git operations.

4.  **Session & Context Management**:
    *   **Persistence**: Conversations are automatically serialized to `~/.parallax/[session-id].json`, allowing for seamless state recovery across restarts.
    *   **Context Compaction**: The `/compact` command uses the LLM to recursively summarize history, effectively managing the context window and optimizing token consumption for long-running projects.

## Developer & System Guidelines

*   **Language**: Responds in the user's preferred language.
*   **Proactivity**: Always prioritizes tool usage for information gathering and implementation.
*   **Performance**: Employs console patching (`src/patch-console.js`) to suppress noisy library logs, ensuring a clean UI.
*   **Safety**: Implements abort controllers for interrupting model generations or rogue tool executions via `Ctrl+C` or `Esc`.

This document serves as the ground truth for the Parallax agent's environment and capabilities.

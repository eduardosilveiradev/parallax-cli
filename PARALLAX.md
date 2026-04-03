# Parallax CLI Architecture & Codebase Overview

Parallax CLI is a sophisticated, React-powered terminal-based coding assistant designed to interface with Google's Gemini models. It leverages the `ink` library to provide a rich, interactive command-line interface that supports multi-turn conversations, tool-driven automation, and session management.

## 1. Core Architectural Pillars

The codebase is organized into a clean, layered architecture that separates the user interface, the reasoning agent, the model provider, and the underlying system tools.

### UI Layer (`src/index.tsx`, `src/app.tsx`)
- **Entry Point**: `src/index.tsx` initializes the terminal environment and renders the main `App` component.
- **Ink Component**: `src/app.tsx` manages the terminal UI lifecycle. It uses React hooks (`useState`, `useEffect`, `useCallback`) to handle complex state transitions during streaming and tool execution.
- **Session Management**: Sessions are uniquely identified and persisted locally in `~/.parallax/` as JSON files, allowing users to load and resume previous coding contexts using the `/load` command.
- **Command Dispatcher**: Implements a slash-command system (`/model`, `/clear`, `/init`, `/compact`) providing advanced control over the agent's behavior and model settings.

### Agent Layer (`src/agent/agent.ts`)
- **ToolLoopAgent**: This class orchestrates the "think-act-observe" loop. It manages the recursion required when a model emits multiple tool calls sequentially.
- **Streaming Logic**: Implements an `AsyncGenerator` that yields fine-grained `StreamPart` objects (`text-delta`, `tool-call`, `tool-result`). This allows the UI to update in real-time as the agent works.
- **Context Injection**: Automatically merges tool results back into the message history, maintaining a consistent state for the LLM to process.

### Provider Layer (`src/agent/gemini-provider.ts`)
- **Abstraction**: Defines the `AgentProvider` interface, which decouples the agent logic from the specific model API.
- **Gemini Adapter**: Specifically wraps `@google/gemini-cli-core` and `@google/genai`. It handles the nuances of the Gemini API, including Google OAuth authentication (`AuthType.LOGIN_WITH_GOOGLE`).
- **Schema Mapping**: Dynamically converts Zod validation schemas into Google's expected function declaration format, enabling type-safe tool calls.
- **Resilience**: Features built-in exponential backoff and retry logic for handling rate limits (HTTP 429), ensuring a stable user experience.

### Tool Layer (`src/tools.ts`)
- **Primitive Capabilities**: Exposes a `ToolSet` that gives the agent direct access to the local environment.
- **Available Tools**:
    - `listDirectory`: High-level filesystem traversal.
    - `readFile`: Content retrieval with a 100k character buffer safety.
    - `writeFile`: Atomic file creation and directory path auto-resolution.
    - `runCommand`: Shell execution via `child_process.exec`, allowing the agent to run compilers, linters, or test suites.

## 2. Key Data Structures (`src/agent/types.ts`)
- **StreamPart**: A union type representing all possible events in an agent's turn.
- **MessageBlock**: Defines how the UI segments content into User, Assistant, Tool, and Error blocks for rendering.
- **ToolSet**: A registry of available functions mapped to their JSON schemas and execution handlers.

## 3. Design Philosophy
- **Real-time Feedback**: Every part of the agent's turn is streamed to the UI, from raw text to the live execution status of background tools.
- **Transparency**: The UI explicitly shows which tools are being called and their outputs (toggleable via Ctrl+O), preventing "hidden" system changes.
- **Context Preservation**: Advanced commands like `/compact` use LLM-driven summarization to shrink conversation history while preserving critical architectural and decision-making context, optimizing token usage for long-running sessions.
- **Safety**: While powerful, tool execution is performed within the user's terminal context, giving the user final control via standard terminal signals (Ctrl+C).

## 4. Execution Flow
1. User enters a query or slash command via the `TextInput`.
2. `App` component captures input and initiates a stream from the `ToolLoopAgent`.
3. `ToolLoopAgent` calls the `GeminiProvider` with the current message history and system instructions.
4. Gemini emits a response. If it includes a `functionCall`, the agent pauses the text stream.
5. The agent executes the corresponding handler from `allTools`.
6. The result is appended to the message history, and the agent automatically triggers a new generation turn.
7. The loop continues until the model produces a terminal `STOP` reason or reaches `maxSteps`.
8. The final state is automatically persisted to the local history file.

This codebase serves as a blueprint for a modern, extensible, and powerful LLM-powered developer tool.

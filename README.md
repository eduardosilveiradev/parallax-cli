# Parallax CLI

Parallax is an open-source AI coding assistant that runs in your terminal. You probably already know what an agent is and what it does. I built this one because I was tired of brittle framework abstractions, context windows bloating out of control, and CLI tools that felt like a black box.

Here is what Parallax does differently:

**Multi-Agent Coordination & Parallelization**  
Parallax isn't just one model struggling to write an entire app in a single turn. The `/parallax` command delegates planning to a high-capacity large reasoning model (like `gemini-3.1-pro`), which acts solely as a Master Coordinator. It decomposes your objective and dynamically spins up a swarm of lightweight subagents (e.g. `gemini-3-flash`) to execute the smaller tasks. Since the core tool execution engine is fully asynchronous and non-blocking, these subagents run and write code concurrently to accomplish massive refactors in seconds.

**Native IDE Connection**  
While Parallax streams beautiful line-numbered diffs into its terminal interface, it also natively hooks right into your IDE's internal state. When an agent edits a file, it seamlessly opens a native, non-blocking UI Diff Editor directly in your IDE environment (like VS Code). You never have to manually `git diff` an agent's work again; the moment a change is made to disk, the precise diff pops open next to your active code for read-only inspection and rapid `Cmd + Z` reversion if desired.

**Native Ink TUI**  
Most CLI agents just spew text until they finish a thought. Parallax uses React and Ink to render a proper, reactive terminal interface. It maintains your session state in a status bar and renders the model's reasoning trace while it streams. You never have to guess if the process is stuck.

**Real Interrupts**  
Hitting `Ctrl+C` doesn't just nuke the node process. It explicitly signals an `AbortController` that hard-stops the model generation and gracefully aborts running tools. If the model starts going down a rabbit hole, you can stop it instantly and correct course without losing your previous session history.

**Context Compaction**  
Long-running conversational sessions usually hit token limits or become painfully slow. Type `/compact` and the model summarizes your entire conversation history, clears the old message blocks, and replaces the context window with the summary. You keep the thread alive without dragging around dead weight.

**YOLO Mode & Verbosity**  
By default, Parallax asks for confirmation before running bash commands or modifying files. If you trust the model with your current task, `Shift+Tab` toggles YOLO mode to bypass confirmations. `Ctrl+O` toggles verbose mode, letting you expand or collapse the noisy reasoning traces and raw tool outputs.

### Commands

Parallax runs a built-in command palette. Type `/` in the prompt to bring up auto-suggestions:

- `/parallax` - Spawns a Master Coordinator Agent to orchestrate fully parallel subagents for a large task.
- `/skills` - Installs new semantic agent skills from `skills.sh` locally or globally.
- `/model` - Switch the active Gemini model via an interactive list picker.
- `/new` - Starts a clean slate.
- `/init` - Scans your codebase and dumps an architectural overview into `PARALLAX.md`. The model reads this file on boot so it understands your local coding conventions.
- `/compact` - Compresses history to save tokens.
- `/load` - Opens an interactive session history picker to resume old threads.
- `/commit` - Tells the model to analyze your current `git diff`, write a commit message, and push the changes.

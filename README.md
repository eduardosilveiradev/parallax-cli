# Parallax CLI

Parallax is an open-source AI coding assistant that runs in your terminal. You probably already know what an agent is and what it does. I built this one because I was tired of brittle framework abstractions, context windows bloating out of control, and CLI tools that felt like a black box.

Here is what Parallax does differently:

**Native Ink TUI**  
Most CLI agents just spew text until they finish a thought. Parallax uses React and Ink to render a proper, reactive terminal interface. It displays live diffs for code edits with line numbers, tracks your session state in a status bar, and renders the model's reasoning trace while it streams. You never have to guess if the process is stuck.

**Real Interrupts**  
Hitting `Ctrl+C` doesn't just nuke the node process. It explicitly signals an `AbortController` that hard-stops the model generation and aborts running tools. If the model starts going down a rabbit hole, you can stop it instantly and correct course without losing your session history.

**Context Compaction**  
Long-running conversational sessions usually hit token limits or become painfully slow. Type `/compact` and the model summarizes your entire conversation history, clears the old message blocks, and replaces the context window with the summary. You keep the thread alive without dragging around dead weight.

**YOLO Mode & Verbosity**  
By default, Parallax asks for confirmation before running bash commands or modifying files. If you trust the model with your current task, `Shift+Tab` toggles YOLO mode to bypass confirmations. `Ctrl+O` toggles verbose mode, letting you expand or collapse the noisy reasoning traces and raw tool outputs.

### Commands

Parallax runs a built-in command palette. Type `/` in the prompt to bring up auto-suggestions:

- `/model` - Switch the active Gemini model via an interactive list picker.
- `/new` - Starts a clean slate.
- `/init` - Scans your codebase and dumps an architectural overview into `PARALLAX.md`. The model reads this file on boot so it understands your local coding conventions.
- `/compact` - Compresses history to save tokens.
- `/load` - Opens an interactive session history picker to resume old threads.
- `/commit` - Tells the model to analyze your current `git diff`, write a commit message, and push the changes.

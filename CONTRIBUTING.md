# Contributing

Parallax tries to do very little under the hood. Most "provider agnostic" tools use giant abstraction libraries (like Vercel AI SDK) that intercept and modify API payloads. We don't do that. Parallax strictly maps all ReAct reasoning loops directly against the Google Gemini `Content` schema, so we get fully deterministic function calling without a generic middleman.

If you submit a structural PR, keep that in mind. Try to avoid adding generic wrapper libraries.

## Setup

Parallax uses `pnpm` and `tsx`.

1. Clone the repo:
   ```bash
   git clone https://github.com/eduardosilveiradev/parallax-cli.git
   cd parallax-cli
   ```
2. Install dependencies: `pnpm install`
3. Run the dev server: `pnpm dev`

`pnpm dev` spins up a `tsx watch` process on `src/index.tsx`. The CLI interface will reload instantly in your terminal whenever you save changes.

## Environment Variables

Parallax detects multiple providers by checking your shell variables at runtime. Set these to unlock different models in the `/model` dropdown:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENROUTER_API_KEY`
- `OLLAMA_BASE_URL` (Defaults to `http://127.0.0.1:11434`)
- `LMSTUDIO_BASE_URL` (Defaults to `http://127.0.0.1:1234/v1`)
- `VLLM_BASE_URL` (Defaults to `http://127.0.0.1:8000/v1`)

## Adding New Providers

If you want to plug in a new API provider:

1. Create a new provider file in `src/agent/` (e.g., `cohere-provider.ts`). 
2. Have the class extend `GenericProvider` (if it supports OpenAI schemas natively) or `AgentProvider` (if you need to write custom payload mapping).
3. Add a prefix mapping in `src/agent/provider-factory.ts`.
4. Add it to the fetch loop inside `src/agent/model-loader.ts`. Watch the timeout—we wrap all fetches in a strict 1-second `AbortController` so the CLI doesn't hang if an endpoint is offline.

## Adding CLI Commands

Slash commands live in `src/app.tsx` inside the `AVAILABLE_COMMANDS` array. Just add your command block to the `if (command === '/...')` execution trap. 

Note: stay away from `console.log()`. It completely breaks Ink's async layout rendering. If you need to surface information to the user, append it to the React `blocks` state instead.

## Adding Tools

Agent tools go in `src/tools.ts`. Make sure the JSON schema and the handler return fully deterministic types.

## PR Process

- Check if there's an open issue first.
- Branch off `main`.
- If you're bored, run the `/commit` command to have Parallax automatically analyze your local diff and write the commit message for you.

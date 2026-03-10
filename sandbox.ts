// ─────────────────────────────────────────────────────────────────
//  sandbox.ts — Vercel Sandbox wrapper for Parallax
//
//  When VERCEL_OIDC_TOKEN is available (production on Vercel),
//  uses @vercel/sandbox to create isolated Linux microVMs.
//  Falls back to local filesystem operations for local dev.
// ─────────────────────────────────────────────────────────────────

import fs from "node:fs/promises";
import { exec } from "node:child_process";
import path from "node:path";

// ── Public interface ───────────────────────────────────────────

export interface PRResult {
    url: string;
    branch: string;
}

export interface SandboxInstance {
    id: string;
    repoUrl?: string;
    readFile(filePath: string, offset?: number, limit?: number): Promise<string>;
    writeFile(filePath: string, content: string): Promise<string>;
    runCommand(cmd: string): Promise<string>;
    listDir(dirPath: string): Promise<string>;
    createPR(title: string, body: string, token: string): Promise<PRResult>;
    stop(): Promise<void>;
}

// ── Vercel Sandbox backend ────────────────────────────────────

async function createVercelSandbox(repoUrl?: string, oidcToken?: string): Promise<SandboxInstance> {
    const { Sandbox } = await import("@vercel/sandbox");

    const sandbox = await Sandbox.create({
        runtime: "node24",
        ...(oidcToken ? { oidcToken } : {}),
        ...(repoUrl ? { source: { type: "git" as const, url: repoUrl, depth: 1 } } : {}),
    });

    const workDir = "/vercel/sandbox";

    const instance: SandboxInstance = {
        id: sandbox.sandboxId,
        repoUrl,

        async readFile(filePath: string, offset = 0, limit = 200): Promise<string> {
            const absPath = filePath.startsWith("/") ? filePath : `${workDir}/${filePath}`;
            const buf = await sandbox.readFileToBuffer({ path: absPath });
            if (!buf) return `error: file not found — ${absPath}`;

            const content = buf.toString("utf-8");
            const lines = content.split("\n");
            const totalLines = lines.length;

            if (totalLines <= limit && offset === 0) return content;

            const page = lines.slice(offset, offset + limit);
            const endLine = Math.min(offset + limit, totalLines);
            let result = page.join("\n");
            result += `\n\n--- Showing lines ${offset + 1}-${endLine} of ${totalLines} total ---`;
            if (endLine < totalLines) {
                result += `\n--- Use offset=${endLine} to read the next page ---`;
            }
            return result;
        },

        async writeFile(filePath: string, content: string): Promise<string> {
            const absPath = filePath.startsWith("/") ? filePath : `${workDir}/${filePath}`;
            const dir = absPath.substring(0, absPath.lastIndexOf("/"));
            if (dir) {
                await sandbox.runCommand("mkdir", ["-p", dir]);
            }

            await sandbox.writeFiles([{
                path: absPath,
                content: Buffer.from(content, "utf-8"),
            }]);
            return `success: wrote ${content.length} bytes to ${filePath}`;
        },

        async runCommand(cmd: string): Promise<string> {
            const result = await sandbox.runCommand("bash", ["-c", cmd], {
                cwd: workDir,
            } as any);
            const stdout = await result.stdout();
            const stderr = await result.stderr();
            if (result.exitCode !== 0) {
                return `exit ${result.exitCode}\n${stderr}\n${stdout}`.trim();
            }
            return stdout.trim() || stderr.trim() || "(no output)";
        },

        async listDir(dirPath: string): Promise<string> {
            const absPath = dirPath.startsWith("/") ? dirPath : `${workDir}/${dirPath}`;
            const result = await sandbox.runCommand("ls", ["-la", absPath]);
            const stdout = await result.stdout();
            return stdout.trim();
        },

        async createPR(title: string, body: string, token: string): Promise<PRResult> {
            return createPRFromSandbox(instance, title, body, token);
        },

        async stop(): Promise<void> {
            await sandbox.stop();
        },
    };
    return instance;
}

// ── Local fallback backend ────────────────────────────────────

function createLocalSandbox(repoUrl?: string): SandboxInstance {
    const workDir = path.resolve(process.cwd(), ".parallax-sandbox");
    let setupDone = false;

    // Force ALL paths inside workDir — never let absolute paths escape
    const containPath = (p: string): string => {
        // If the path is absolute (drive letter or leading /), default to sandbox root
        if (path.isAbsolute(p) || /^[a-zA-Z]:/.test(p)) {
            return workDir;
        }
        const resolved = path.resolve(workDir, p);
        // Safety: ensure resolved path is actually inside workDir
        if (!resolved.startsWith(workDir)) {
            return workDir;
        }
        return resolved;
    };

    const ensureSetup = async () => {
        if (setupDone) return;
        await fs.mkdir(workDir, { recursive: true });

        if (repoUrl) {
            await fs.rm(workDir, { recursive: true, force: true });
            await new Promise<void>((resolve, reject) => {
                exec(`git clone --depth 1 ${repoUrl} "${workDir}"`, (err) => {
                    if (err) reject(err);
                    else resolve();
                });
            });
        }
        setupDone = true;
        console.log(`[sandbox] local sandbox ready at ${workDir}`);
    };

    const id = `local-${Date.now()}`;

    const instance: SandboxInstance = {
        id,
        repoUrl,

        async readFile(filePath: string, offset = 0, limit = 200): Promise<string> {
            await ensureSetup();
            const absPath = containPath(filePath);
            try {
                const content = await fs.readFile(absPath, "utf-8");
                const lines = content.split("\n");
                const totalLines = lines.length;

                if (totalLines <= limit && offset === 0) return content;

                const page = lines.slice(offset, offset + limit);
                const endLine = Math.min(offset + limit, totalLines);
                let result = page.join("\n");
                result += `\n\n--- Showing lines ${offset + 1}-${endLine} of ${totalLines} total ---`;
                if (endLine < totalLines) {
                    result += `\n--- Use offset=${endLine} to read the next page ---`;
                }
                return result;
            } catch (err: any) {
                return `error: could not read file — ${err.message}`;
            }
        },

        async writeFile(filePath: string, content: string): Promise<string> {
            await ensureSetup();
            const absPath = containPath(filePath);
            try {
                await fs.mkdir(path.dirname(absPath), { recursive: true });
                await fs.writeFile(absPath, content, "utf-8");
                return `success: wrote ${content.length} bytes to ${filePath}`;
            } catch (err: any) {
                return `error: could not write file — ${err.message}`;
            }
        },

        async runCommand(cmd: string): Promise<string> {
            await ensureSetup();
            return new Promise((resolve) => {
                exec(cmd, { cwd: workDir, timeout: 30_000 }, (err, stdout, stderr) => {
                    if (err) {
                        resolve(`exit ${err.code ?? 1}\n${stderr}\n${stdout}`.trim());
                    } else {
                        resolve(stdout.trim() || stderr.trim() || "(no output)");
                    }
                });
            });
        },

        async listDir(dirPath: string): Promise<string> {
            await ensureSetup();
            const absPath = containPath(dirPath);
            try {
                const entries = await fs.readdir(absPath, { withFileTypes: true });
                return entries
                    .map((e) => `${e.isDirectory() ? "d" : "-"}  ${e.name}`)
                    .join("\n");
            } catch (err: any) {
                return `error: could not list directory — ${err.message}`;
            }
        },

        async createPR(title: string, body: string, token: string): Promise<PRResult> {
            return createPRFromSandbox(instance, title, body, token);
        },

        async stop(): Promise<void> {
            try {
                await fs.rm(workDir, { recursive: true, force: true });
            } catch { /* best-effort */ }
        },
    };
    return instance;
}

// ── Shared PR creation logic ──────────────────────────────────

function parseGitHubRepo(repoUrl: string): { owner: string; repo: string } | null {
    // Handle HTTPS URLs: https://github.com/owner/repo(.git)
    const httpsMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/.]+)/);
    if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
    // Handle SSH URLs: git@github.com:owner/repo.git
    const sshMatch = repoUrl.match(/github\.com:([^/]+)\/([^/.]+)/);
    if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
    return null;
}

async function createPRFromSandbox(
    sandbox: SandboxInstance,
    title: string,
    body: string,
    token: string,
): Promise<PRResult> {
    if (!sandbox.repoUrl) throw new Error("No repository URL — cannot create PR");

    const parsed = parseGitHubRepo(sandbox.repoUrl);
    if (!parsed) throw new Error(`Cannot parse GitHub owner/repo from: ${sandbox.repoUrl}`);

    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    const branch = `parallax/${slug}-${Math.floor(Date.now() / 1000)}`;

    // Configure git user for the commit
    await sandbox.runCommand(`git config user.email "parallax@bot"`);
    await sandbox.runCommand(`git config user.name "Parallax"`);

    // Create branch, stage, commit
    const checkoutResult = await sandbox.runCommand(`git checkout -b "${branch}"`);
    if (checkoutResult.startsWith("exit")) throw new Error(`Failed to create branch: ${checkoutResult}`);

    await sandbox.runCommand(`git add -A`);

    const commitResult = await sandbox.runCommand(`git commit -m "${title.replace(/"/g, '\\"')}"`);
    if (commitResult.includes("nothing to commit")) throw new Error("No changes to commit");

    // Push using token-authenticated HTTPS URL
    const pushUrl = `https://x-access-token:${token}@github.com/${parsed.owner}/${parsed.repo}.git`;
    const pushResult = await sandbox.runCommand(`git push "${pushUrl}" "${branch}"`);
    if (pushResult.startsWith("exit") && !pushResult.includes("->" )) {
        throw new Error(`Failed to push: ${pushResult}`);
    }

    // Create PR via GitHub REST API
    const prResponse = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            title,
            body: body || `Changes made by Parallax agent.`,
            head: branch,
            base: "main",
        }),
    });

    if (!prResponse.ok) {
        const errData = await prResponse.json().catch(() => ({}));
        // If "main" doesn't exist, try "master"
        if (prResponse.status === 422 && JSON.stringify(errData).includes("base")) {
            const retryResponse = await fetch(`https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls`, {
                method: "POST",
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github+json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ title, body: body || `Changes made by Parallax agent.`, head: branch, base: "master" }),
            });
            if (!retryResponse.ok) {
                const retryErr = await retryResponse.json().catch(() => ({}));
                throw new Error(`GitHub API error: ${JSON.stringify(retryErr)}`);
            }
            const retryData = await retryResponse.json();
            return { url: retryData.html_url, branch };
        }
        throw new Error(`GitHub API error: ${JSON.stringify(errData)}`);
    }

    const prData = await prResponse.json();
    return { url: prData.html_url, branch };
}

// ── Auto-restart wrapper ─────────────────────────────────────
//
// Wraps a SandboxInstance so that any operation that fails with
// a timeout/disconnect error automatically recreates the sandbox
// (same config) and retries the operation once.

/** Error patterns that indicate the sandbox timed out or was killed. */
const TIMEOUT_PATTERNS = [
    "timed out", "timeout", "ETIMEDOUT",
    "sandbox not found", "sandbox has stopped",
    "disconnected", "ECONNRESET", "ECONNREFUSED",
    "socket hang up",
];

function isTimeoutError(err: unknown): boolean {
    const msg = String(err instanceof Error ? err.message : err).toLowerCase();
    return TIMEOUT_PATTERNS.some((p) => msg.includes(p.toLowerCase()));
}

export interface SandboxCreateOptions {
    repoUrl?: string;
    oidcToken?: string;
    /** Called when the sandbox is recreated after a timeout — use to update external refs. */
    onRestart?: (newInstance: SandboxInstance) => void;
}

function wrapWithAutoRestart(
    inner: SandboxInstance,
    opts: SandboxCreateOptions,
): SandboxInstance {
    let current = inner;

    const recreate = async (): Promise<void> => {
        console.log(`[sandbox] auto-restarting sandbox ${current.id}…`);
        try { await current.stop(); } catch { /* best-effort cleanup */ }
        const fresh = opts.oidcToken || process.env.VERCEL
            ? await createVercelSandbox(opts.repoUrl, opts.oidcToken)
            : createLocalSandbox(opts.repoUrl);
        current = fresh;
        // Propagate the new inner ID to the wrapper
        wrapper.id = current.id;
        opts.onRestart?.(wrapper);
        console.log(`[sandbox] restarted → ${current.id}`);
    };

    /** Execute an operation; on timeout, recreate and retry once. */
    const withRetry = async <T>(op: (s: SandboxInstance) => Promise<T>): Promise<T> => {
        try {
            return await op(current);
        } catch (err) {
            if (!isTimeoutError(err)) throw err;
            await recreate();
            return await op(current);
        }
    };

    const wrapper: SandboxInstance = {
        id: current.id,
        get repoUrl() { return current.repoUrl; },

        readFile: (filePath, offset?, limit?) =>
            withRetry((s) => s.readFile(filePath, offset, limit)),

        writeFile: (filePath, content) =>
            withRetry((s) => s.writeFile(filePath, content)),

        runCommand: (cmd) =>
            withRetry((s) => s.runCommand(cmd)),

        listDir: (dirPath) =>
            withRetry((s) => s.listDir(dirPath)),

        createPR: (title, body, token) =>
            withRetry((s) => s.createPR(title, body, token)),

        stop: () => current.stop(),
    };

    return wrapper;
}

// ── Factory ───────────────────────────────────────────────────

export async function createSandbox(opts: SandboxCreateOptions = {}): Promise<SandboxInstance> {
    const inner = (opts.oidcToken || process.env.VERCEL)
        ? await createVercelSandbox(opts.repoUrl, opts.oidcToken)
        : createLocalSandbox(opts.repoUrl);
    return wrapWithAutoRestart(inner, opts);
}

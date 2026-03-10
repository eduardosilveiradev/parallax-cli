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

export interface SandboxInstance {
    id: string;
    repoUrl?: string;
    readFile(filePath: string, offset?: number, limit?: number): Promise<string>;
    writeFile(filePath: string, content: string): Promise<string>;
    runCommand(cmd: string): Promise<string>;
    listDir(dirPath: string): Promise<string>;
    stop(): Promise<void>;
}

// ── Vercel Sandbox backend ────────────────────────────────────

async function createVercelSandbox(repoUrl?: string): Promise<SandboxInstance> {
    const { Sandbox } = await import("@vercel/sandbox");

    const sandbox = await Sandbox.create({
        runtime: "node24",
        ...(repoUrl ? { source: { type: "git" as const, url: repoUrl, depth: 1 } } : {}),
    });

    const workDir = "/vercel/sandbox";

    return {
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

        async stop(): Promise<void> {
            await sandbox.stop();
        },
    };
}

// ── Local fallback backend ────────────────────────────────────

function createLocalSandbox(repoUrl?: string): SandboxInstance {
    const workDir = path.resolve(process.cwd(), ".parallax-sandbox");
    let setupDone = false;

    // Force ALL paths inside workDir — never let absolute paths escape
    const containPath = (p: string): string => {
        // Strip drive letters (C:\...) and leading slashes to make relative
        const stripped = p.replace(/^[a-zA-Z]:/, "").replace(/^[/\\]+/, "");
        const resolved = path.resolve(workDir, stripped);
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

    return {
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

        async stop(): Promise<void> {
            try {
                await fs.rm(workDir, { recursive: true, force: true });
            } catch { /* best-effort */ }
        },
    };
}

// ── Factory ───────────────────────────────────────────────────

const isVercelProduction = !!process.env["VERCEL_OIDC_TOKEN"];

export async function createSandbox(repoUrl?: string): Promise<SandboxInstance> {
    if (isVercelProduction) {
        return createVercelSandbox(repoUrl);
    }
    return createLocalSandbox(repoUrl);
}

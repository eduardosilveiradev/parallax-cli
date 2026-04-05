import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import * as fs from 'fs';
import * as path from 'path';
import os from 'node:os';

export interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.parallax']);
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB limit per file

if (!isMainThread) {
  // --- WORKER THREAD LOGIC ---
  const { files, pattern, isRegex, caseSensitive } = workerData;
  const matches: SearchMatch[] = [];

  const searchRegExp = isRegex
    ? new RegExp(pattern, caseSensitive ? 'g' : 'gi')
    : undefined;

  for (const file of files) {
    try {
      const stat = fs.statSync(file);
      if (stat.size > MAX_FILE_SIZE) continue;

      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let found = false;

        if (isRegex && searchRegExp) {
          if (searchRegExp.test(line)) found = true;
          searchRegExp.lastIndex = 0; // reset
        } else {
          if (caseSensitive) {
            if (line.includes(pattern)) found = true;
          } else {
            if (line.toLowerCase().includes(pattern.toLowerCase())) found = true;
          }
        }

        if (found) {
          matches.push({
            file,
            line: i + 1,
            content: line.trim().slice(0, 150) // truncate super long lines natively
          });
        }
      }
    } catch {
      // Ignore read errors natively (broken symlinks, perms, binary file crashes)
    }
  }

  parentPort?.postMessage(matches);
}

// --- MAIN THREAD LOGIC ---
function getAllFiles(dir: string, fileList: string[] = []): string[] {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      
      // Skip hidden files to stay clean
      if (entry.name.startsWith('.')) continue;

      const fullPath = path.join(dir, entry.name);
      
      if (entry.isDirectory()) {
        getAllFiles(fullPath, fileList);
      } else if (entry.isFile()) {
        fileList.push(fullPath);
      }
    }
  } catch (err) {}
  
  return fileList;
}

export async function threadedSearch(
  directory: string,
  pattern: string,
  options: { isRegex?: boolean; caseSensitive?: boolean; maxResults?: number } = {}
): Promise<SearchMatch[]> {
  const allFiles = getAllFiles(directory);
  const numCPUs = os.cpus().length;
  // Cap at 8 threads to prevent thrashing
  const threadCount = Math.min(Math.max(2, numCPUs - 1), 8, allFiles.length);
  
  if (allFiles.length === 0) return [];

  const chunkSize = Math.ceil(allFiles.length / threadCount);
  const workers: Promise<SearchMatch[]>[] = [];

  for (let i = 0; i < threadCount; i++) {
    const chunk = allFiles.slice(i * chunkSize, (i + 1) * chunkSize);
    if (chunk.length === 0) continue;

    workers.push(new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), {
        execArgv: process.execArgv,
        workerData: {
          files: chunk,
          pattern,
          isRegex: !!options.isRegex,
          caseSensitive: !!options.caseSensitive
        }
      });

      worker.on('message', resolve);
      worker.on('error', reject);
      worker.on('exit', (code) => {
        if (code !== 0) reject(new Error(`Worker stopped with exit code ${code}`));
      });
    }));
  }

  const resultsPool = await Promise.all(workers);
  const allMatches = resultsPool.flat();

  // Sort by file deterministically
  allMatches.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);

  if (options.maxResults && allMatches.length > options.maxResults) {
    return allMatches.slice(0, options.maxResults);
  }

  return allMatches;
}

#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const binDir = path.dirname(__filename);
const rootDir = path.resolve(binDir, '..');

const tsxPath = path.resolve(rootDir, 'node_modules', '.bin', 'tsx');
const child = spawn(tsxPath, [path.join(rootDir, 'src', 'index.tsx'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--no-warnings=DEP0040'].filter(Boolean).join(' ')
  }
});

child.on('exit', (code) => process.exit(code || 0));

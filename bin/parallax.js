#!/usr/bin/env node
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const binDir = path.dirname(__filename);
const rootDir = path.resolve(binDir, '..');

const child = spawn(process.execPath, ['--no-warnings=DEP0040', '--import', 'tsx', path.join(rootDir, 'src', 'index.tsx'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS].filter(Boolean).join(' ')
  }
});

child.on('exit', (code) => process.exit(code || 0));

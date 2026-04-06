#!/usr/bin/env node
import { applyPatch } from './patch-console.js';
import React from 'react';
import { render } from 'ink';
import App from './app.js';
import { startIpcServer } from './ipc.js';

const args = process.argv.slice(2);
const isIpc = args.includes('--ipc');
const initialPrompt = args.filter(a => a !== '--ipc').join(' ');

if (isIpc) {
  startIpcServer();
} else {
  render(<App initialPrompt={initialPrompt} />, { exitOnCtrlC: false });
  applyPatch();
}

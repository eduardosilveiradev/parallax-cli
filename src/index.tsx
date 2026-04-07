#!/usr/bin/env node
import { applyPatch } from './patch-console.js';
import React from 'react';
import { render } from 'ink';
import App from './app.js';
import { startIpcServer } from './ipc.js';

const args = process.argv.slice(2);
const isIpc = args.includes('--ipc');
const initialPrompt = args.filter(a => a !== '--ipc').join(' ');

let exitInfo: { sessionId: string, lastMsg: string, killedCount: number } | null = null;

async function start() {
  if (isIpc) {
    startIpcServer();
  } else {
    applyPatch();
    const instance = render(
      <App initialPrompt={initialPrompt} onExitCb={(info) => { exitInfo = info; }} />,
      { exitOnCtrlC: false }
    );

    await instance.waitUntilExit();

    try { instance.cleanup(); } catch (e) { }

    if (exitInfo) {
      setTimeout(() => {
        process.stdout.write(`\n`);
        process.stdout.write("Parallax shutting down...\n");
        if (exitInfo!.lastMsg !== "No previous messages.") {
          process.stdout.write(`Session ID: ${exitInfo!.sessionId}\n`);
          process.stdout.write(`Last message: "${exitInfo!.lastMsg}"\n`);
        }
        process.stdout.write(`\n`);
        if (exitInfo!.killedCount > 0) {
          process.stdout.write(`Forcefully terminated ${exitInfo!.killedCount} background process(es).\n`);
        }
        process.exit(0);
      }, 50);
    } else {
      process.exit(0);
    }
  }
}

start();

#!/usr/bin/env node
import './patch-console.js';
import React from 'react';
import { render } from 'ink';
import App from './app.js';

const args = process.argv.slice(2);
const initialPrompt = args.length > 0 ? args.join(' ') : '';

render(<App initialPrompt={initialPrompt} />, { exitOnCtrlC: false });

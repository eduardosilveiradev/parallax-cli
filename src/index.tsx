#!/usr/bin/env node
import './patch-console.js';
import React from 'react';
import { render } from 'ink';
import App from './app.js';

render(<App />, { exitOnCtrlC: false });

import os from 'os';
import path from 'path';

export type SessionMode = 'agent' | 'plan' | 'debug';

export const sessionModes = new Map<string, SessionMode>();

export function getHistoryPath(sessionId: string) {
  return path.join(os.homedir(), '.parallax', `${sessionId}.json`);
}


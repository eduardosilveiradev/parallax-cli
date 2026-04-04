let patched = false;

export function applyPatch() {
  if (patched) return;
  patched = true;
  
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleInfo = console.info;

function shouldIgnore(...args: any[]) {
  if (!args || args.length === 0) return false;
  const msg = typeof args[0] === 'string' ? args[0] : (args[0] && typeof args[0].message === 'string' ? args[0].message : String(args[0]));
  
  if (msg.includes('Warning:')) return true;
  if (msg.includes('Keychain initialization encountered an error:')) return true;
  if (msg.includes('Using FileKeychain fallback for secure storage.')) return true;
  if (msg.includes('Loaded cached credentials.')) return true;
  
  // Sometimes the error object's stack traces are printed. If it contains keytar.node error, we suppress it.
  if (msg.includes('Cannot find module') && msg.includes('keytar.node')) return true;

  return false;
}

  console.log = (...args: any[]) => {
    if (shouldIgnore(...args)) return;
    originalConsoleLog(...args);
  };

  console.error = (...args: any[]) => {
    if (shouldIgnore(...args)) return;
    originalConsoleError(...args);
  };

  console.warn = (...args: any[]) => {
    if (shouldIgnore(...args)) return;
    originalConsoleWarn(...args);
  };

  console.info = (...args: any[]) => {
    if (shouldIgnore(...args)) return;
    originalConsoleInfo(...args);
  };
}

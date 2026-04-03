const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('Warning:')) return;
  originalConsoleError(...args);
};
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('Warning:')) return;
  originalConsoleWarn(...args);
};

import React, { useState } from 'react';
import { render, Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';

function App() {
  const [val, setVal] = useState('');
  
  useInput((input, key) => {
    if (key.ctrl && input === 'o') {
      // Do something on Ctrl+O
      setVal(v => v + '[CTRL-O]');
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
       <TextInput value={val} onChange={setVal} />
       <Text>Val: {val}</Text>
    </Box>
  );
}

const { waitUntilExit } = render(<App />);
waitUntilExit();

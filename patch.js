import fs from 'fs';
const file = '../parallax-cli/src/agent/gemini-provider.ts';
let code = fs.readFileSync(file, 'utf8');
const searchString = `    let responseStream;
    try {
      responseStream = await client.generateContentStream(request, randomUUID());
    } catch (err: any) {
      yield { type: 'finish-step', reason: 'error' };
      throw err;
    }`;
const replaceString = `    let responseStream;
    let retries = 0;
    const MAX_RETRIES = 5;

    while (true) {
      try {
        responseStream = await client.generateContentStream(request, randomUUID());
        break; // Success
      } catch (err: any) {
        const is429 = err?.status === 429 || err?.status === 'RESOURCE_EXHAUSTED' || (typeof err?.message === 'string' && err.message.includes('429'));
        
        if (is429 && retries < MAX_RETRIES) {
          retries++;
          yield { type: 'text-delta', text: \`\\n\\n[Rate limit exceeded (429). Auto-retrying in 10 seconds... (Attempt \${retries}/\${MAX_RETRIES})]\\n\\n\` };
          await new Promise(resolve => setTimeout(resolve, 10000));
          continue;
        }

        yield { type: 'finish-step', reason: 'error' };
        throw err;
      }
    }`;

code = code.replace(searchString, replaceString);
fs.writeFileSync(file, code);
console.log('Successfully patched gemini-provider.ts in parallax-cli!');

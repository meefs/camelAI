// v2 - streaming enabled
import { query } from '@anthropic-ai/claude-code';

const prompt = process.env.CLAUDE_PROMPT;
const sessionId = process.env.SESSION_ID;

if (!prompt) {
  console.error('CLAUDE_PROMPT env var required');
  process.exit(1);
}

try {
  for await (const event of query({ prompt, options: { includePartialMessages: true } })) {
    console.log(JSON.stringify(event));
  }
} catch (e) {
  console.error(JSON.stringify({ type: 'error', error: String(e) }));
  process.exit(1);
}

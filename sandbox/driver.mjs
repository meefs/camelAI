import { query } from '@anthropic-ai/claude-agent-sdk';

const prompt = process.env.CLAUDE_PROMPT;
const resumeSessionId = process.env.RESUME_SESSION_ID;

if (!prompt) {
  console.error('CLAUDE_PROMPT env var required');
  process.exit(1);
}

try {
  const options = {
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowUnsandboxedCommands: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user'],
  };

  // Resume existing session if provided
  if (resumeSessionId) {
    options.resume = resumeSessionId;
  }

  for await (const event of query({ prompt, options })) {
    console.log(JSON.stringify(event));
  }
} catch (e) {
  console.error(JSON.stringify({ type: 'error', error: String(e) }));
  process.exit(1);
}

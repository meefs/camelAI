import { query } from '@anthropic-ai/claude-agent-sdk';

const prompt = process.env.CLAUDE_PROMPT;
const resumeSessionId = process.env.RESUME_SESSION_ID;
const tunnelPort = process.env.SANDBOX_TUNNEL_PORT;

if (!prompt) {
  console.error('CLAUDE_PROMPT env var required');
  process.exit(1);
}

async function emitTunnelEvent(event) {
  if (!tunnelPort) return;
  try {
    await fetch(`http://127.0.0.1:${tunnelPort}/emit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    });
  } catch (e) {
    console.error('[tunnel] emit failed:', e);
  }
}

try {
  await emitTunnelEvent({
    type: 'driver_start',
    prompt_length: prompt.length,
    resumed: Boolean(resumeSessionId),
  });

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
  await emitTunnelEvent({ type: 'driver_error', error: String(e) });
  console.error(JSON.stringify({ type: 'error', error: String(e) }));
  process.exit(1);
}

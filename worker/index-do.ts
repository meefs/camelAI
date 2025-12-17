// External DO worker - hosts all Durable Object classes for dev
// Run with: npm run dev:do

import { ChatIndexDO, ChatThreadDO } from "./durable-objects.js";
import { SessionDO, UserDO, OrgDO } from "./auth.js";
import { Sandbox } from '@cloudflare/sandbox';

// Export Sandbox as ThreadSandbox to match wrangler config
export { Sandbox as ThreadSandbox };

// Export all DO classes
export { ChatIndexDO, ChatThreadDO, SessionDO, UserDO, OrgDO };

// Minimal fetch handler (required, but DOs are accessed via RPC)
export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("DO worker running", { status: 200 });
  },
};

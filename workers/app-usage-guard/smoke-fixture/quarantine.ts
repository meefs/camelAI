import { DurableObject } from 'cloudflare:workers';

export class SmokeDurableObject extends DurableObject {
  async alarm(): Promise<void> {}

  async fetch(): Promise<Response> {
    return suspendedResponse();
  }
}

const NOTICE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App temporarily paused</title></head><body><main><h1>This app needs an update</h1><p>camelAI paused this app after unusually high database usage.</p><p>The app data has been preserved. Its owner can restore service by deploying a version that uses fewer database reads and writes.</p></main></body></html>';

function suspendedResponse(): Response {
  return new Response(NOTICE, {
    status: 503,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '300',
      'X-CamelAI-App-Status': 'suspended',
    },
  });
}

export default {
  async fetch(): Promise<Response> {
    return suspendedResponse();
  },
} satisfies ExportedHandler;

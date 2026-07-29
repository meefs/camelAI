import { describe, expect, it } from 'vitest';
import type { Browser, Page } from '@cloudflare/puppeteer';
import {
  AppBrowserSession,
  assertBrowserSessionCapacity,
  assertWorkspaceBrowserSessionCapacity,
  BROWSER_MAX_ACTIVE_SESSIONS,
  BROWSER_MAX_ACTIVE_SESSIONS_PER_WORKSPACE,
  BROWSER_SESSION_MAX_LOG_ENTRIES,
  BROWSER_SESSION_MAX_TEXT_CHARS,
  type AppBrowserSessionInit,
} from '../src/app-browser-binding';
import type { WorkspaceAppHostIndex } from '../src/workspace-app-fetcher';
import { headersRecord } from '../src/app-screenshot-capture';

type Listener = (...args: unknown[]) => void;

interface FakeCall {
  method: string;
  args: unknown[];
}

function createFakePage(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: FakeCall[] = [];
  const listeners = new Map<string, Listener[]>();
  let currentUrl = 'https://my-app-acme85.camelai.app/';
  const record = (method: string, ...args: unknown[]) => {
    calls.push({ method, args });
  };

  const page = {
    on(event: string, listener: Listener) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    async goto(url: string, options: unknown) {
      record('goto', url, options);
      currentUrl = url;
      return {
        status: () => 200,
        ok: () => true,
        statusText: () => 'OK',
      };
    },
    url: () => currentUrl,
    async title() {
      return 'Fake Title';
    },
    viewport: () => ({ width: 1280, height: 720, deviceScaleFactor: 1.5 }),
    async waitForSelector(selector: string, options: unknown) {
      record('waitForSelector', selector, options);
      return {};
    },
    async click(selector: string, options?: unknown) {
      record('click', selector, options);
    },
    keyboard: {
      async press(key: string) {
        record('keyboard.press', key);
      },
    },
    async type(selector: string, text: string) {
      record('type', selector, text);
    },
    async focus(selector: string) {
      record('focus', selector);
    },
    async select(selector: string, ...values: string[]) {
      record('select', selector, ...values);
      return values;
    },
    async hover(selector: string) {
      record('hover', selector);
    },
    async waitForFunction(expression: unknown, options: unknown, ...args: unknown[]) {
      record('waitForFunction', expression, options, ...args);
    },
    async evaluate(expression: unknown) {
      record('evaluate', expression);
      return undefined;
    },
    async $eval(selector: string, fn: (element: unknown, ...rest: unknown[]) => unknown, ...args: unknown[]) {
      record('$eval', selector);
      return fn({ textContent: '  hello world  ', getAttribute: () => 'value' }, ...args);
    },
    async $$eval(selector: string, fn: (elements: unknown[]) => unknown) {
      record('$$eval', selector);
      return fn([{}, {}, {}]);
    },
    async $(selector: string) {
      record('$', selector);
      return null;
    },
    async content() {
      record('content');
      return '<html>x</html>';
    },
    async screenshot(options: unknown) {
      record('screenshot', options);
      return Buffer.from('fake-image');
    },
    async close() {
      record('page.close');
    },
    ...overrides,
  };

  return { page: page as unknown as Page, calls, emit: page.emit.bind(page) };
}

function createFakeBrowser() {
  const calls: FakeCall[] = [];
  const browser = {
    async close() {
      calls.push({ method: 'browser.close', args: [] });
    },
    async disconnect() {
      calls.push({ method: 'browser.disconnect', args: [] });
    },
  };
  return { browser: browser as unknown as Browser, calls };
}

async function captureRejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected the promise to reject');
}

const HOST_INDEX: WorkspaceAppHostIndex = {
  routesByHostname: new Map(),
  hostnames: new Set(['other-app-beta99.camelai.app']),
};

function createSession(
  fakePage: ReturnType<typeof createFakePage>,
  fakeBrowser: ReturnType<typeof createFakeBrowser>,
  init: Partial<AppBrowserSessionInit> = {},
) {
  return new AppBrowserSession({
    browser: fakeBrowser.browser,
    page: fakePage.page,
    baseUrl: new URL('https://my-app-acme85.camelai.app/'),
    hostIndex: HOST_INDEX,
    logContext: { scriptName: 'my-app' },
    ...init,
  });
}

describe('AppBrowserSession', () => {
  it('resolves goto paths against the app base URL', async () => {
    const fakePage = createFakePage();
    const session = createSession(fakePage, createFakeBrowser());
    const result = await session.goto('/dashboard?tab=1');
    expect(result.status).toBe(200);
    expect(fakePage.calls[0]).toMatchObject({
      method: 'goto',
      args: ['https://my-app-acme85.camelai.app/dashboard?tab=1', expect.anything()],
    });
    // Single committed navigation (no networkidle wait / no re-navigation).
    expect(fakePage.calls.filter((call) => call.method === 'goto')).toHaveLength(1);
    expect(fakePage.calls[0].args[1]).toMatchObject({ waitUntil: 'domcontentloaded' });
    await session.close();
  });

  it('allows absolute URLs on workspace app hosts and rejects external hosts', async () => {
    const fakePage = createFakePage();
    const session = createSession(fakePage, createFakeBrowser());
    await session.goto('https://other-app-beta99.camelai.app/page');
    expect(await captureRejection(session.goto('https://evil.example.com/'))).toMatch(
      /workspace's app hosts/,
    );
    expect(await captureRejection(session.goto('relative-without-slash'))).toMatch(/starting with "\/"/);
    await session.close();
  });

  it('rejects protocol-relative paths that resolve to another host', async () => {
    const fakePage = createFakePage();
    const session = createSession(fakePage, createFakeBrowser());
    // Slips past a naive startsWith('/') check but resolves to evil.example.com.
    expect(await captureRejection(session.goto('//evil.example.com/'))).toMatch(
      /workspace's app hosts/,
    );
    // Backslashes are normalized to forward slashes by the URL parser.
    expect(await captureRejection(session.goto('/\\evil.example.com/'))).toMatch(
      /workspace's app hosts/,
    );
    // A protocol-relative path to an allowed workspace host is still fine.
    const ok = await session.goto('//other-app-beta99.camelai.app/page');
    expect(ok.status).toBe(200);
    await session.close();
  });

  it('waits for the selector to be visible before clicking', async () => {
    const fakePage = createFakePage();
    const session = createSession(fakePage, createFakeBrowser());
    await session.click('#submit');
    expect(fakePage.calls.map((call) => call.method)).toEqual(['waitForSelector', 'click']);
    expect(fakePage.calls[0].args[1]).toMatchObject({ visible: true });
    await session.close();
  });

  it('clears the field with key events before filling', async () => {
    const fakePage = createFakePage();
    const session = createSession(fakePage, createFakeBrowser());
    await session.fill('#email', 'a@b.com');
    expect(fakePage.calls.map((call) => call.method)).toEqual([
      'waitForSelector',
      'click',
      'keyboard.press',
      'type',
    ]);
    expect(fakePage.calls[1].args[1]).toMatchObject({ clickCount: 3 });
    expect(fakePage.calls[2].args[0]).toBe('Backspace');
    expect(fakePage.calls[3].args).toEqual(['#email', 'a@b.com']);
    await session.close();
  });

  it('returns JSON-safe values from evaluate', async () => {
    const fakePage = createFakePage({
      evaluate: async () => undefined,
    });
    const session = createSession(fakePage, createFakeBrowser());
    expect(await session.evaluate('void 0')).toBeNull();
    await session.close();

    const fakePage2 = createFakePage({
      evaluate: async () => ({ count: 3, label: 'ok' }),
    });
    const session2 = createSession(fakePage2, createFakeBrowser());
    expect(await session2.evaluate('x')).toEqual({ count: 3, label: 'ok' });
    await session2.close();
  });

  it('waitForTimeout sleeps for the floored duration and validates input', async () => {
    const session = createSession(createFakePage(), createFakeBrowser());
    const start = Date.now();
    expect(await session.waitForTimeout(20.9)).toEqual({ ok: true, waitedMs: 20 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
    expect(await captureRejection(session.waitForTimeout(-1))).toMatch(/non-negative number/);
    expect(await captureRejection(session.waitForTimeout(Number.NaN))).toMatch(/non-negative number/);
    expect(
      await captureRejection(session.waitForTimeout('500' as unknown as number)),
    ).toMatch(/non-negative number/);
    await session.close();
    expect(await captureRejection(session.waitForTimeout(10))).toMatch(/session is closed/);
  });

  it('trims and truncates textContent', async () => {
    const long = 'x'.repeat(BROWSER_SESSION_MAX_TEXT_CHARS + 10);
    const fakePage = createFakePage({
      $eval: async () => `  ${long}  `,
    });
    const session = createSession(fakePage, createFakeBrowser());
    const result = await session.textContent('h1');
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(BROWSER_SESSION_MAX_TEXT_CHARS);
    await session.close();
  });

  it('defaults textContent to visible body text when the selector is omitted', async () => {
    const selectors: string[] = [];
    const fakePage = createFakePage({
      $eval: async (selector: string) => {
        selectors.push(selector);
        return '  page body  ';
      },
    });
    const session = createSession(fakePage, createFakeBrowser());

    expect(await session.textContent()).toEqual({ text: 'page body', truncated: false });
    expect(selectors).toEqual(['body']);
    await session.close();
  });

  it('checks visible text immediately in the body or a selected element', async () => {
    const selectors: string[] = [];
    const fakePage = createFakePage({
      $: async () => ({}),
      $eval: async (selector: string, _fn: unknown, expected: string) => {
        selectors.push(selector);
        return `${selector} says Saved`.includes(expected);
      },
    });
    const session = createSession(fakePage, createFakeBrowser());

    expect(await session.hasText('Saved')).toBe(true);
    expect(await session.hasText('Missing')).toBe(false);
    expect(await session.hasText('Saved', { selector: '.toast' })).toBe(true);
    expect(selectors).toEqual(['body', 'body', '.toast']);
    expect(await captureRejection(session.hasText(''))).toMatch(/text must be a non-empty string/);
    expect(await captureRejection(session.hasText('Saved', { selector: ' ' }))).toMatch(
      /selector must be a non-empty string/,
    );
    await session.close();
  });

  it('returns false from hasText when the target does not exist', async () => {
    const session = createSession(createFakePage(), createFakeBrowser());
    expect(await session.hasText('Saved', { selector: '.missing' })).toBe(false);
    await session.close();
  });

  it('captures console messages, page errors, and failed responses in logs', async () => {
    const fakePage = createFakePage();
    const session = createSession(fakePage, createFakeBrowser());
    fakePage.emit('console', { type: () => 'error', text: () => 'boom' });
    fakePage.emit('pageerror', new Error('ReferenceError: x is not defined'));
    fakePage.emit('response', {
      status: () => 500,
      url: () => 'https://my-app-acme85.camelai.app/api/data',
      request: () => ({ method: () => 'GET' }),
    });
    fakePage.emit('response', {
      status: () => 200,
      url: () => 'https://my-app-acme85.camelai.app/ok',
      request: () => ({ method: () => 'GET' }),
    });
    fakePage.emit('requestfailed', {
      url: () => 'https://my-app-acme85.camelai.app/broken',
      method: () => 'POST',
      failure: () => ({ errorText: 'net::ERR_FAILED' }),
    });
    const logs = await session.logs();
    expect(logs.console).toEqual([{ type: 'error', text: 'boom' }]);
    expect(logs.pageErrors).toEqual(['ReferenceError: x is not defined']);
    expect(logs.requestFailures).toEqual([
      { url: 'https://my-app-acme85.camelai.app/api/data', method: 'GET', status: 500 },
      { url: 'https://my-app-acme85.camelai.app/broken', method: 'POST', error: 'net::ERR_FAILED' },
    ]);
    expect(logs.truncated).toBe(false);
    await session.close();
  });

  it('caps log entries and flags truncation', async () => {
    const fakePage = createFakePage();
    const session = createSession(fakePage, createFakeBrowser());
    for (let index = 0; index < BROWSER_SESSION_MAX_LOG_ENTRIES + 5; index += 1) {
      fakePage.emit('console', { type: () => 'log', text: () => `entry-${index}` });
    }
    const logs = await session.logs();
    expect(logs.console).toHaveLength(BROWSER_SESSION_MAX_LOG_ENTRIES);
    expect(logs.console[0].text).toBe('entry-5');
    expect(logs.truncated).toBe(true);
    await session.close();
  });

  it('returns a JPEG data URL from screenshot', async () => {
    const fakePage = createFakePage();
    const session = createSession(fakePage, createFakeBrowser());
    const result = await session.screenshot();
    expect(result.imageDataUrl.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
    await session.close();
  });

  it('closes idempotently and rejects further actions', async () => {
    const fakePage = createFakePage();
    const fakeBrowser = createFakeBrowser();
    const removed: string[] = [];
    const session = createSession(fakePage, fakeBrowser, {
      removeInterception: () => removed.push('yes'),
    });
    await session.close();
    await session.close();
    expect(removed).toEqual(['yes']);
    expect(fakePage.calls.filter((call) => call.method === 'page.close')).toHaveLength(1);
    expect(fakeBrowser.calls.filter((call) => call.method === 'browser.close')).toHaveLength(1);
    expect(await captureRejection(session.click('#x'))).toMatch(/session is closed/i);
  });

  it('disconnects without closing the remote browser session', async () => {
    const fakePage = createFakePage();
    const fakeBrowser = createFakeBrowser();
    const removed: string[] = [];
    const session = createSession(fakePage, fakeBrowser, {
      remoteSessionId: 'browser-session-1',
      removeInterception: () => removed.push('yes'),
    });

    expect(session.sessionId()).toBe('browser-session-1');
    await session.disconnect();
    await session.disconnect();

    expect(removed).toEqual(['yes']);
    expect(fakePage.calls.filter((call) => call.method === 'page.close')).toHaveLength(0);
    expect(fakeBrowser.calls.filter((call) => call.method === 'browser.close')).toHaveLength(0);
    expect(fakeBrowser.calls.filter((call) => call.method === 'browser.disconnect')).toHaveLength(1);
    expect(await captureRejection(session.click('#x'))).toMatch(/session is closed/i);
  });

  it('auto-closes after the lifetime limit with a clear error', async () => {
    const fakePage = createFakePage();
    const session = createSession(fakePage, createFakeBrowser(), { maxLifetimeMs: 20 });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(await captureRejection(session.click('#x'))).toMatch(/lifetime limit/);
  });

  it('wraps action failures with a compact message', async () => {
    const fakePage = createFakePage({
      waitForSelector: async () => {
        throw new Error('Waiting for selector `#missing` failed: timeout 10000ms exceeded');
      },
    });
    const session = createSession(fakePage, createFakeBrowser());
    expect(await captureRejection(session.click('#missing'))).toMatch(/click #missing failed:/);
    await session.close();
  });
});

describe('assertBrowserSessionCapacity', () => {
  const under = Array.from({ length: BROWSER_MAX_ACTIVE_SESSIONS - 1 }, (_, i) => ({ id: `s${i}` }));
  const at = Array.from({ length: BROWSER_MAX_ACTIVE_SESSIONS }, (_, i) => ({ id: `s${i}` }));

  it('returns the active count when below the cap', () => {
    expect(assertBrowserSessionCapacity([])).toBe(0);
    expect(assertBrowserSessionCapacity(under)).toBe(under.length);
  });

  it('throws at or above the cap with a retry hint', () => {
    expect(() => assertBrowserSessionCapacity(at)).toThrow(
      new RegExp(`${BROWSER_MAX_ACTIVE_SESSIONS}/${BROWSER_MAX_ACTIVE_SESSIONS}`),
    );
    expect(() => assertBrowserSessionCapacity([...at, { id: 'extra' }])).toThrow(/auto-close after 5 minutes/);
  });

  it('honors a custom cap', () => {
    expect(assertBrowserSessionCapacity([{ id: 'a' }], 2)).toBe(1);
    expect(() => assertBrowserSessionCapacity([{ id: 'a' }, { id: 'b' }], 2)).toThrow(/\(2\/2\)/);
  });

  it('treats a non-array (e.g. sessions() shape drift) as zero active sessions', () => {
    expect(assertBrowserSessionCapacity(undefined)).toBe(0);
    expect(assertBrowserSessionCapacity(null)).toBe(0);
    expect(assertBrowserSessionCapacity({ activeSessions: 5 })).toBe(0);
  });
});

describe('assertWorkspaceBrowserSessionCapacity', () => {
  it('returns the count when below the per-workspace cap', () => {
    expect(assertWorkspaceBrowserSessionCapacity(0)).toBe(0);
    expect(
      assertWorkspaceBrowserSessionCapacity(BROWSER_MAX_ACTIVE_SESSIONS_PER_WORKSPACE - 1),
    ).toBe(BROWSER_MAX_ACTIVE_SESSIONS_PER_WORKSPACE - 1);
  });

  it('throws at or above the per-workspace cap', () => {
    const cap = BROWSER_MAX_ACTIVE_SESSIONS_PER_WORKSPACE;
    expect(() => assertWorkspaceBrowserSessionCapacity(cap)).toThrow(
      new RegExp(`${cap}/${cap} browser sessions`),
    );
    expect(() => assertWorkspaceBrowserSessionCapacity(cap + 3)).toThrow(/This workspace already has/);
  });

  it('honors a custom cap and treats a non-finite count as zero', () => {
    expect(() => assertWorkspaceBrowserSessionCapacity(2, 2)).toThrow(/\b2\/2\b/);
    expect(assertWorkspaceBrowserSessionCapacity(Number.NaN)).toBe(0);
  });
});

describe('headersRecord', () => {
  it('preserves multiple Set-Cookie headers as an array', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'session=abc; Path=/; HttpOnly');
    headers.append('set-cookie', 'csrf=xyz; Path=/');
    headers.set('content-type', 'text/html');

    const record = headersRecord(headers);
    expect(Array.isArray(record['set-cookie'])).toBe(true);
    expect(record['set-cookie']).toEqual([
      'session=abc; Path=/; HttpOnly',
      'csrf=xyz; Path=/',
    ]);
    expect(record['content-type']).toBe('text/html');
  });

  it('leaves responses without Set-Cookie as plain string values', () => {
    const record = headersRecord(new Headers({ 'content-type': 'application/json' }));
    expect(record['content-type']).toBe('application/json');
    expect('set-cookie' in record).toBe(false);
  });
});

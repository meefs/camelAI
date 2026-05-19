import { expect, test, type Page } from '@playwright/test';

type StressMode = 'legacy' | 'optimized';

interface ChatStressMetrics {
  mode: StressMode;
  frameCount: number;
  maxFrameGapMs: number;
  p95FrameGapMs: number;
  longTaskCount: number;
  layoutShiftScore: number;
  layoutMeasurements: number;
  spacerMeasurements: number;
  spacerWrites: number;
  scrollWrites: number;
  renderWrites: number;
  finalScrollDistanceFromBottom: number;
}

async function runChatStress(page: Page, mode: StressMode): Promise<ChatStressMetrics> {
  await page.setViewportSize({ width: 1512, height: 900 });
  await page.setContent(`
    <!doctype html>
    <html>
      <head>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            color: #111827;
            background: #f8fafc;
          }
          .app {
            display: flex;
            height: 100vh;
          }
          .sidebar {
            width: 256px;
            flex: 0 0 auto;
            border-right: 1px solid #e5e7eb;
            background: #fff;
          }
          .chat {
            flex: 1 1 auto;
            min-width: 0;
            display: flex;
            flex-direction: column;
            background: #fff;
          }
          .header {
            height: 52px;
            flex: 0 0 auto;
            border-bottom: 1px solid #e5e7eb;
          }
          .scroll {
            flex: 1 1 auto;
            min-height: 0;
            overflow-y: auto;
            overflow-x: hidden;
          }
          .column {
            width: min(768px, 100%);
            margin: 0 auto;
            padding: 8px 24px 24px;
            display: flex;
            flex-direction: column;
          }
          .turn {
            display: flex;
            flex-direction: column;
            gap: 10px;
          }
          .message {
            max-width: 100%;
            overflow-wrap: anywhere;
          }
          .optimized .turn,
          .optimized .message {
            contain: layout paint style;
          }
          .user {
            align-self: flex-end;
            max-width: 78%;
            margin: 24px 0 4px;
            border-radius: 18px;
            background: #111827;
            color: #fff;
            padding: 10px 14px;
          }
          .assistant {
            align-self: stretch;
            padding: 0 4px;
          }
          .assistant p {
            margin: 0 0 10px;
          }
          .assistant pre {
            margin: 12px 0;
            padding: 12px;
            border-radius: 8px;
            overflow: auto;
            background: #f3f4f6;
          }
          .assistant table {
            width: 100%;
            border-collapse: collapse;
            margin: 12px 0;
          }
          .assistant td,
          .assistant th {
            border: 1px solid #e5e7eb;
            padding: 6px 8px;
          }
          .spacer {
            width: 100%;
            flex: 0 0 auto;
            pointer-events: none;
          }
          .composer {
            height: 92px;
            flex: 0 0 auto;
            border-top: 1px solid #e5e7eb;
          }
        </style>
      </head>
      <body>
        <main class="app ${mode}">
          <aside class="sidebar"></aside>
          <section class="chat">
            <div class="header"></div>
            <div class="scroll" aria-label="Chat messages">
              <div class="column"></div>
            </div>
            <div class="composer"></div>
          </section>
        </main>
      </body>
    </html>
  `);

  return page.evaluate(
    async ({ stressMode, percentileSource }) => {
      const mode = stressMode as StressMode;
      const column = document.querySelector<HTMLElement>('.column');
      const scroll = document.querySelector<HTMLElement>('.scroll');
      if (!column || !scroll) throw new Error('stress harness did not mount');

      const metrics = {
        frameGaps: [] as number[],
        longTaskCount: 0,
        layoutShiftScore: 0,
        layoutMeasurements: 0,
        spacerMeasurements: 0,
        spacerWrites: 0,
        scrollWrites: 0,
        renderWrites: 0,
      };

      const layoutShiftObserver =
        'PerformanceObserver' in window
          ? new PerformanceObserver((list) => {
              for (const entry of list.getEntries()) {
                const layoutShift = entry as PerformanceEntry & {
                  value?: number;
                  hadRecentInput?: boolean;
                };
                if (!layoutShift.hadRecentInput) {
                  metrics.layoutShiftScore += layoutShift.value ?? 0;
                }
              }
            })
          : null;
      const longTaskObserver =
        'PerformanceObserver' in window
          ? new PerformanceObserver((list) => {
              metrics.longTaskCount += list.getEntries().length;
            })
          : null;

      try {
        layoutShiftObserver?.observe({ type: 'layout-shift', buffered: true });
      } catch {}
      try {
        longTaskObserver?.observe({ type: 'longtask', buffered: true });
      } catch {}

      const sentence =
        'This is a long existing assistant response with enough text to create realistic wrapping and paint work across a tall transcript.';

      for (let index = 0; index < 220; index += 1) {
        const turn = document.createElement('div');
        turn.className = 'turn';

        const user = document.createElement('div');
        user.className = 'message user';
        user.dataset.messageId = `history-user-${index}`;
        user.textContent = `User request ${index}`;
        turn.appendChild(user);

        const assistant = document.createElement('div');
        assistant.className = 'message assistant';
        assistant.dataset.messageId = `history-assistant-${index}`;
        assistant.innerHTML = `
          <p>${sentence} ${sentence} ${index}</p>
          <ul>
            <li>Existing item ${index}.1</li>
            <li>Existing item ${index}.2</li>
          </ul>
          <pre><code>const value${index} = ${index};\\nconsole.log(value${index});</code></pre>
        `;
        turn.appendChild(assistant);
        column.appendChild(turn);
      }

      const liveTurn = document.createElement('div');
      liveTurn.className = 'turn';
      const liveUser = document.createElement('div');
      liveUser.className = 'message user';
      liveUser.dataset.messageId = 'live-user';
      liveUser.textContent = 'Generate a long report';
      liveTurn.appendChild(liveUser);
      const liveAssistant = document.createElement('div');
      liveAssistant.className = 'message assistant';
      liveAssistant.dataset.messageId = 'live-assistant';
      liveAssistant.textContent = '# Streaming report\\n';
      liveTurn.appendChild(liveAssistant);
      column.appendChild(liveTurn);

      const spacer = document.createElement('div');
      spacer.className = 'spacer';
      column.appendChild(spacer);
      const end = document.createElement('div');
      column.appendChild(end);

      let scheduledSpacerFrame = 0;
      const measureAndWriteSpacer = () => {
        metrics.layoutMeasurements += 3;
        metrics.spacerMeasurements += 3;
        scroll.getBoundingClientRect();
        const userRect = liveUser.getBoundingClientRect();
        const assistantRect = liveAssistant.getBoundingClientRect();
        const availableHeight = scroll.clientHeight;
        const exchangeHeight = Math.max(assistantRect.bottom - userRect.top, 0);
        const nextHeight = Math.max(Math.round(availableHeight - exchangeHeight - 24), 0);
        if (spacer.style.height !== `${nextHeight}px`) {
          spacer.style.height = `${nextHeight}px`;
          metrics.spacerWrites += 1;
        }
      };
      const scheduleSpacer = () => {
        if (mode === 'legacy') {
          measureAndWriteSpacer();
          return;
        }
        if (scheduledSpacerFrame) return;
        scheduledSpacerFrame = requestAnimationFrame(() => {
          scheduledSpacerFrame = 0;
          measureAndWriteSpacer();
        });
      };

      measureAndWriteSpacer();
      scroll.scrollTop = scroll.scrollHeight;
      metrics.scrollWrites += 1;

      let animationFrame = 0;
      let lastFrameAt = performance.now();
      let running = true;
      const sampleFrames = () => {
        const now = performance.now();
        metrics.frameGaps.push(now - lastFrameAt);
        lastFrameAt = now;
        if (running) {
          animationFrame = requestAnimationFrame(sampleFrames);
        }
      };
      animationFrame = requestAnimationFrame(sampleFrames);

      let pendingDelta = '';
      let renderTimer = 0;
      const commitDelta = (delta: string) => {
        const wasStuckToBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 180;
        liveAssistant.textContent += delta;
        metrics.renderWrites += 1;
        scheduleSpacer();
        if (wasStuckToBottom) {
          scroll.scrollTop = scroll.scrollHeight;
          metrics.scrollWrites += 1;
        }
      };
      const queueDelta = (delta: string) => {
        if (mode === 'legacy') {
          commitDelta(delta);
          return;
        }
        pendingDelta += delta;
        if (renderTimer) return;
        renderTimer = window.setTimeout(() => {
          renderTimer = 0;
          const nextDelta = pendingDelta;
          pendingDelta = '';
          commitDelta(nextDelta);
        }, 50);
      };

      const makeDelta = (index: number) => `
## Section ${index}

Paragraph ${index} with **bold**, _italic_, inline code, and a link.

- Bullet ${index}.1
- Bullet ${index}.2
  - Nested bullet

| Name | Value |
| --- | ---: |
| alpha-${index} | ${index} |

\`\`\`tsx
export function Example${index}() {
  return <button>Run ${index}</button>;
}
\`\`\`
`;

      for (let index = 0; index < 120; index += 1) {
        queueDelta(makeDelta(index));
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      if (renderTimer) {
        clearTimeout(renderTimer);
        renderTimer = 0;
      }
      if (pendingDelta) {
        const nextDelta = pendingDelta;
        pendingDelta = '';
        commitDelta(nextDelta);
      }

      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      running = false;
      cancelAnimationFrame(animationFrame);
      if (scheduledSpacerFrame) cancelAnimationFrame(scheduledSpacerFrame);
      layoutShiftObserver?.disconnect();
      longTaskObserver?.disconnect();

      const frameGaps = metrics.frameGaps.slice(1);
      const sortedFrameGaps = [...frameGaps].sort((left, right) => left - right);
      const p95Index = Math.min(
        sortedFrameGaps.length - 1,
        Math.floor((percentileSource / 100) * sortedFrameGaps.length),
      );
      const finalScrollDistanceFromBottom =
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;

      return {
        mode,
        frameCount: frameGaps.length,
        maxFrameGapMs: Math.max(0, ...frameGaps),
        p95FrameGapMs: sortedFrameGaps[p95Index] ?? 0,
        longTaskCount: metrics.longTaskCount,
        layoutShiftScore: metrics.layoutShiftScore,
        layoutMeasurements: metrics.layoutMeasurements,
        spacerMeasurements: metrics.spacerMeasurements,
        spacerWrites: metrics.spacerWrites,
        scrollWrites: metrics.scrollWrites,
        renderWrites: metrics.renderWrites,
        finalScrollDistanceFromBottom,
      };
    },
    { stressMode: mode, percentileSource: 95 },
  );
}

test.describe('chat rendering performance stress harness', () => {
  test('reproduces the layout-thrash root cause and verifies the optimized path reduces it', async ({ page }) => {
    const legacy = await runChatStress(page, 'legacy');
    const optimized = await runChatStress(page, 'optimized');

    console.info('chat rendering stress metrics', { legacy, optimized });

    expect(legacy.renderWrites).toBeGreaterThan(optimized.renderWrites * 4);
    expect(legacy.spacerMeasurements).toBeGreaterThan(optimized.spacerMeasurements * 3);
    expect(legacy.spacerWrites).toBeGreaterThan(optimized.spacerWrites);
  });

  test('keeps the optimized long-transcript streaming path within a local frame budget', async ({ page }) => {
    const metrics = await runChatStress(page, 'optimized');

    console.info('optimized chat rendering stress metrics', metrics);

    expect(metrics.frameCount).toBeGreaterThan(10);
    expect(metrics.p95FrameGapMs).toBeLessThan(50);
    expect(metrics.maxFrameGapMs).toBeLessThan(160);
    expect(metrics.longTaskCount).toBeLessThanOrEqual(3);
    expect(metrics.layoutShiftScore).toBeLessThan(0.02);
    expect(metrics.renderWrites).toBeLessThanOrEqual(16);
  });
});

import type { Route } from './+types/dev.sent-emails';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import {
  isDevEmailOutboxEnabled,
  listDevEmailOutboxEntries,
  type DevEmailOutboxEntry,
} from '@/lib/dev-email-outbox';

function parseLimit(searchParams: URLSearchParams): number {
  const raw = searchParams.get('limit');
  if (!raw) return 20;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return 20;
  return parsed;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderHtmlList(
  requestUrl: URL,
  entries: DevEmailOutboxEntry[],
  nextCursor: string | null
): string {
  const listItems = entries
    .map((entry) => {
      const detailUrl = `/api/dev/sent-emails/${encodeURIComponent(entry.id)}`;
      const previewUrl = `${detailUrl}?format=html`;
      return `<li style="margin: 0 0 18px; padding: 12px; border: 1px solid #d4d4d8; border-radius: 8px;">
        <div><strong>${escapeHtml(entry.subject)}</strong></div>
        <div style="color: #52525b; margin-top: 4px;">${escapeHtml(entry.to)} | ${escapeHtml(entry.status)} via ${escapeHtml(entry.transport)}</div>
        <div style="color: #52525b; margin-top: 2px;">${escapeHtml(entry.createdAt)}</div>
        <div style="margin-top: 8px;">
          <a href="${previewUrl}" target="_blank" rel="noreferrer">Open HTML preview</a>
          &nbsp;|&nbsp;
          <a href="${detailUrl}" target="_blank" rel="noreferrer">Open JSON</a>
        </div>
      </li>`;
    })
    .join('');

  const cursorLink = nextCursor
    ? `<a href="/api/dev/sent-emails?format=html&cursor=${encodeURIComponent(nextCursor)}&limit=20">Next page</a>`
    : '<span style="color: #71717a;">No more entries</span>';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Dev Sent Emails</title>
  </head>
  <body style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; margin: 24px; color: #18181b;">
    <h1 style="margin: 0 0 6px;">Dev Sent Emails</h1>
    <p style="margin: 0 0 16px; color: #52525b;">
      Captured from <code>${escapeHtml(requestUrl.origin)}</code> while <code>NEXTJS_ENV=development</code>.
    </p>
    <p style="margin: 0 0 16px;">
      ${cursorLink}
    </p>
    <ul style="list-style: none; margin: 0; padding: 0;">
      ${listItems || '<li style="color: #71717a;">No captured emails yet.</li>'}
    </ul>
  </body>
</html>`;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  if (!isDevEmailOutboxEnabled(env)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  let authContext: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    authContext = await requireAuthContext(request, context);
  } catch (error) {
    if (error instanceof Response && error.status >= 300 && error.status < 400) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }

  if (!authContext.user.is_superuser) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams);
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const format = url.searchParams.get('format');

  const { entries, cursor: nextCursor, listComplete } = await listDevEmailOutboxEntries(env, {
    limit,
    cursor,
  });

  if (format === 'html') {
    return new Response(renderHtmlList(url, entries, listComplete ? null : (nextCursor ?? null)), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return Response.json({
    entries: entries.map((entry) => ({
      id: entry.id,
      createdAt: entry.createdAt,
      to: entry.to,
      cc: entry.cc ?? null,
      replyTo: entry.replyTo ?? null,
      subject: entry.subject,
      status: entry.status,
      reason: entry.reason ?? null,
      transport: entry.transport,
      previewUrl: `/api/dev/sent-emails/${encodeURIComponent(entry.id)}?format=html`,
      detailUrl: `/api/dev/sent-emails/${encodeURIComponent(entry.id)}`,
    })),
    nextCursor: listComplete ? null : (nextCursor ?? null),
    listComplete,
  }, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

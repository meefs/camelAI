import { describe, expect, it } from 'vitest';
import { formatCopyFilePath } from '@/lib/file-path-copy';
import {
  buildSlugMap,
  type MentionableConnection,
  type MentionableProject,
} from '@/lib/mentions';

function connection(
  fields: Partial<MentionableConnection> & { id: string; name: string },
): MentionableConnection {
  return {
    kind: 'connection',
    integration_type: 'stripe',
    created_at: 0,
    ...fields,
  };
}

function project(
  fields: Partial<MentionableProject> & { id: string; name: string },
): MentionableProject {
  return {
    kind: 'project',
    description: 'Project description',
    created_at: 0,
    ...fields,
  };
}

describe('formatCopyFilePath', () => {
  it('returns workspace paths without a project prefix', () => {
    expect(formatCopyFilePath({
      path: '  /plans/notes.md  ',
      source: 'workspace',
      project: 'Thread Review Dashboard',
    })).toBe('/plans/notes.md');
  });

  it('returns upload and output paths without a project prefix', () => {
    expect(formatCopyFilePath({
      path: 'uploads/report.csv',
      source: 'upload',
      project: 'Thread Review Dashboard',
    })).toBe('uploads/report.csv');

    expect(formatCopyFilePath({
      path: 'outputs/report.html',
      source: 'output',
      project: 'Thread Review Dashboard',
    })).toBe('outputs/report.html');
  });

  it('uses the matching project slug from the mention map for project paths', () => {
    const mentionSlugMap = buildSlugMap([
      project({ id: 'project', name: 'Thread Review Dashboard' }),
    ]);

    expect(formatCopyFilePath({
      path: '/plans/phase-2-automation.md',
      source: 'project',
      project: 'Thread Review Dashboard',
    }, { mentionSlugMap })).toBe(
      '@thread_review_dashboard - /plans/phase-2-automation.md',
    );
  });

  it('matches project handles against display names by normalized key', () => {
    const mentionSlugMap = buildSlugMap([
      project({ id: 'project', name: 'Thread Review Dashboard' }),
    ]);

    expect(formatCopyFilePath({
      path: '/src/App.tsx',
      source: 'project',
      project: 'thread-review-dashboard',
    }, { mentionSlugMap })).toBe(
      '@thread_review_dashboard - /src/App.tsx',
    );
  });

  it('uses the suffixed project slug when a connection and project collide', () => {
    const mentionSlugMap = buildSlugMap([
      project({ id: 'project', name: 'Stripe', created_at: 1 }),
      connection({ id: 'connection', name: 'Stripe', created_at: 2 }),
    ]);

    expect(formatCopyFilePath({
      path: '/src/App.tsx',
      source: 'project',
      project: 'Stripe',
    }, { mentionSlugMap })).toBe('@stripe-2 - /src/App.tsx');
  });

  it('matches normalized project handles while preserving collision suffixes', () => {
    const mentionSlugMap = buildSlugMap([
      project({ id: 'project', name: 'Thread Review Dashboard', created_at: 1 }),
      connection({
        id: 'connection',
        name: 'Thread Review Dashboard',
        created_at: 2,
      }),
    ]);

    expect(formatCopyFilePath({
      path: '/src/App.tsx',
      source: 'project',
      project: 'thread-review-dashboard',
    }, { mentionSlugMap })).toBe(
      '@thread_review_dashboard-2 - /src/App.tsx',
    );
  });

  it('uses exact project names before normalized fallback when project names collide', () => {
    const mentionSlugMap = buildSlugMap([
      project({ id: 'project-a', name: 'My App', created_at: 1 }),
      project({ id: 'project-b', name: 'my-app', created_at: 2 }),
    ]);

    expect(formatCopyFilePath({
      path: '/src/App.tsx',
      source: 'project',
      project: 'my-app',
    }, { mentionSlugMap })).toBe('@my_app-2 - /src/App.tsx');
  });

  it('uses project ids before exact names when resolving project mentions', () => {
    const mentionSlugMap = buildSlugMap([
      project({ id: 'project-a', name: 'My App', created_at: 1 }),
      project({ id: 'project-b', name: 'my-app', created_at: 2 }),
    ]);

    expect(formatCopyFilePath({
      path: '/src/App.tsx',
      source: 'project',
      project: 'My App',
      projectId: 'project-b',
    }, { mentionSlugMap })).toBe('@my_app-2 - /src/App.tsx');
  });

  it('does not emit a normalized project mention when the fallback is ambiguous', () => {
    const mentionSlugMap = buildSlugMap([
      project({ id: 'project-a', name: 'My App', created_at: 1 }),
      project({ id: 'project-b', name: 'my-app', created_at: 2 }),
    ]);

    expect(formatCopyFilePath({
      path: '/src/App.tsx',
      source: 'project',
      project: 'my_app',
    }, { mentionSlugMap })).toBe('/src/App.tsx');
  });

  it('does not emit a guessed mention when a provided map has no project match', () => {
    const mentionSlugMap = buildSlugMap([
      project({ id: 'other-project', name: 'Other Project' }),
    ]);

    expect(formatCopyFilePath({
      path: '/src/App.tsx',
      source: 'project',
      project: 'Thread Review Dashboard',
    }, { mentionSlugMap })).toBe('/src/App.tsx');
  });

  it('uses a best-effort slug fallback when requested without a mention map', () => {
    expect(formatCopyFilePath({
      path: '/src/App.tsx',
      source: 'project',
      project: 'Thread Review Dashboard',
    }, { fallbackProjectMention: true })).toBe(
      '@thread_review_dashboard - /src/App.tsx',
    );
  });

  it('returns an empty string for an empty path', () => {
    expect(formatCopyFilePath({
      path: '  ',
      source: 'project',
      project: 'Thread Review Dashboard',
    }, { fallbackProjectMention: true })).toBe('');
  });
});

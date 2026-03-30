import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  buildActivityByDate,
  computeDashboardSummary,
  computeGrowthThresholds,
  computeRetentionData,
  filterDashboardEntitySnapshot,
  wasActiveInRange,
  type DashboardEntitySnapshot,
} from '../src/admin-dashboard-metrics';

function createSnapshot(overrides: Partial<DashboardEntitySnapshot> = {}): DashboardEntitySnapshot {
  return {
    users: [],
    threads: [],
    apps: [],
    orgs: [],
    workspaces: [],
    totalWorkspaces: 0,
    ...overrides,
  };
}

describe('admin dashboard metrics helpers', () => {
  it('filters internal domains and spam creators consistently', () => {
    const snapshot = filterDashboardEntitySnapshot(
      {
        users: [
          {
            id: 'user-external',
            email: 'external@customer.test',
            name: 'External',
            avatar: { color: '#111', content: 'E' },
            created_at: 1,
            org_count: 1,
            is_superuser: false,
            is_orphaned: false,
          },
          {
            id: 'user-internal',
            email: 'staff@camelai.com',
            name: 'Internal',
            avatar: { color: '#222', content: 'I' },
            created_at: 2,
            org_count: 1,
            is_superuser: false,
            is_orphaned: false,
          },
          {
            id: 'user-spam-owner',
            email: 'spam@spam.test',
            name: 'Spam Owner',
            avatar: { color: '#333', content: 'S' },
            created_at: 3,
            org_count: 1,
            is_superuser: false,
            is_orphaned: false,
          },
          {
            id: 'user-spam-member',
            email: 'member@spam.test',
            name: 'Spam Member',
            avatar: { color: '#444', content: 'M' },
            created_at: 4,
            org_count: 1,
            is_superuser: false,
            is_orphaned: false,
          },
        ],
        orgs: [
          {
            id: 'org-external',
            name: 'External Org',
            slug: 'external-org',
            created_at: 10,
            archived: false,
            billing_status: null,
            created_by: 'user-external',
            member_count: 1,
            workspace_count: 99,
            creator_email: 'external@customer.test',
            creator_name: 'External',
          },
          {
            id: 'org-internal',
            name: 'Internal Org',
            slug: 'internal-org',
            created_at: 11,
            archived: false,
            billing_status: null,
            created_by: 'user-internal',
            member_count: 1,
            workspace_count: 2,
            creator_email: 'staff@camelai.com',
            creator_name: 'Internal',
          },
          {
            id: 'org-spam',
            name: 'Spam Org',
            slug: 'spam-org',
            created_at: 12,
            archived: false,
            billing_status: 'paying',
            created_by: 'user-spam-owner',
            member_count: 2,
            workspace_count: 3,
            creator_email: 'spam@spam.test',
            creator_name: 'Spam Owner',
          },
        ],
        workspaces: [
          {
            id: 'ws-external',
            org_id: 'org-external',
          },
          {
            id: 'ws-internal',
            org_id: 'org-internal',
          },
          {
            id: 'ws-spam',
            org_id: 'org-spam',
          },
        ],
        threads: [
          {
            id: 'thread-external',
            title: 'External',
            workspace_id: 'ws-external',
            created_at: 20,
            updated_at: 20,
            created_by: 'user-external',
            org_id: 'org-external',
            org_name: 'External Org',
            workspace_name: 'External Workspace',
          },
          {
            id: 'thread-internal',
            title: 'Internal',
            workspace_id: 'ws-internal',
            created_at: 21,
            updated_at: 21,
            created_by: 'user-internal',
            org_id: 'org-internal',
            org_name: 'Internal Org',
            workspace_name: 'Internal Workspace',
          },
          {
            id: 'thread-spam-member',
            title: 'Spam Member Thread',
            workspace_id: 'ws-spam',
            created_at: 22,
            updated_at: 22,
            created_by: 'user-spam-member',
            org_id: 'org-spam',
            org_name: 'Spam Org',
            workspace_name: 'Spam Workspace',
          },
          {
            id: 'thread-spam-owner-nonspam-org',
            title: 'Spam Owner Elsewhere',
            workspace_id: 'ws-external',
            created_at: 23,
            updated_at: 23,
            created_by: 'user-spam-owner',
            org_id: 'org-external',
            org_name: 'External Org',
            workspace_name: 'External Workspace',
          },
        ],
        apps: [
          {
            app_id: 'app-external',
            script_name: 'external-app',
            org_id: 'org-external',
            workspace_id: 'ws-external',
            org_name: 'External Org',
            org_slug: 'external-org',
            workspace_name: 'External Workspace',
            created_by: 'user-external',
            created_by_name: 'External',
            created_by_email: 'external@customer.test',
            created_at: 24,
            updated_at: 24,
            is_public: true,
            preview_status: null,
            preview_error: null,
          },
          {
            app_id: 'app-internal',
            script_name: 'internal-app',
            org_id: 'org-internal',
            workspace_id: 'ws-internal',
            org_name: 'Internal Org',
            org_slug: 'internal-org',
            workspace_name: 'Internal Workspace',
            created_by: 'user-internal',
            created_by_name: 'Internal',
            created_by_email: 'staff@camelai.com',
            created_at: 25,
            updated_at: 25,
            is_public: false,
            preview_status: null,
            preview_error: null,
          },
          {
            app_id: 'app-spam-org',
            script_name: 'spam-app',
            org_id: 'org-spam',
            workspace_id: 'ws-spam',
            org_name: 'Spam Org',
            org_slug: 'spam-org',
            workspace_name: 'Spam Workspace',
            created_by: 'user-spam-member',
            created_by_name: 'Spam Member',
            created_by_email: 'member@spam.test',
            created_at: 26,
            updated_at: 26,
            is_public: true,
            preview_status: null,
            preview_error: null,
          },
        ],
      },
      {
        internalDomains: ['camelai.com'],
        spamOrgIds: ['org-spam'],
      },
    );

    expect(snapshot.users.map((user) => user.id)).toEqual(['user-external', 'user-spam-member']);
    expect(snapshot.orgs.map((org) => org.id)).toEqual(['org-external']);
    expect(snapshot.threads.map((thread) => thread.id)).toEqual(['thread-external']);
    expect(snapshot.apps.map((app) => app.app_id)).toEqual(['app-external']);
    expect(snapshot.totalWorkspaces).toBe(1);
  });

  it('computes growth thresholds from pre-today history and current-day visibility', () => {
    expect(computeGrowthThresholds([1, 2, 3, 4, 5, 6, 7, 8])).toEqual({
      flat: 4,
      linear: 8,
      exponential: 10.5,
      show_exponential: true,
    });
  });

  it('treats activity range boundaries inclusively', () => {
    const activityByDate = new Map<string, Set<string>>([
      ['2026-03-01', new Set(['user-1'])],
      ['2026-03-03', new Set(['user-1'])],
    ]);

    expect(
      wasActiveInRange(
        activityByDate,
        'user-1',
        Date.UTC(2026, 2, 1, 12),
        Date.UTC(2026, 2, 1, 12),
      ),
    ).toBe(true);
    expect(
      wasActiveInRange(
        activityByDate,
        'user-1',
        Date.UTC(2026, 2, 2, 0),
        Date.UTC(2026, 2, 2, 23, 59, 59, 999),
      ),
    ).toBe(false);
    expect(
      wasActiveInRange(
        activityByDate,
        'user-1',
        Date.UTC(2026, 2, 2, 12),
        Date.UTC(2026, 2, 3, 0),
      ),
    ).toBe(true);
  });

  it('distinguishes signup-day activity from later-day retention', () => {
    const now = Date.UTC(2026, 2, 30, 12);
    const user1CreatedAt = Date.UTC(2026, 2, 20, 9);
    const user2CreatedAt = Date.UTC(2026, 2, 20, 10);
    const user3CreatedAt = Date.UTC(2026, 2, 29, 11);

    const snapshot = createSnapshot({
      users: [
        {
          id: 'user-1',
          email: 'one@retention.test',
          name: 'One',
          avatar: { color: '#111', content: '1' },
          created_at: user1CreatedAt,
          org_count: 1,
          is_superuser: false,
          is_orphaned: false,
        },
        {
          id: 'user-2',
          email: 'two@retention.test',
          name: 'Two',
          avatar: { color: '#222', content: '2' },
          created_at: user2CreatedAt,
          org_count: 1,
          is_superuser: false,
          is_orphaned: false,
        },
        {
          id: 'user-3',
          email: 'three@retention.test',
          name: 'Three',
          avatar: { color: '#333', content: '3' },
          created_at: user3CreatedAt,
          org_count: 1,
          is_superuser: false,
          is_orphaned: false,
        },
      ],
      threads: [
        {
          id: 'thread-user-1-signup',
          title: 'signup',
          workspace_id: 'ws-1',
          created_at: user1CreatedAt + 5_000,
          updated_at: user1CreatedAt + 5_000,
          created_by: 'user-1',
          org_id: 'org-1',
          org_name: 'Org 1',
          workspace_name: 'WS 1',
        },
        {
          id: 'thread-user-1-day1',
          title: 'day1',
          workspace_id: 'ws-1',
          created_at: user1CreatedAt + DAY_MS + 5_000,
          updated_at: user1CreatedAt + DAY_MS + 5_000,
          created_by: 'user-1',
          org_id: 'org-1',
          org_name: 'Org 1',
          workspace_name: 'WS 1',
        },
        {
          id: 'thread-user-2-signup',
          title: 'signup',
          workspace_id: 'ws-2',
          created_at: user2CreatedAt + 5_000,
          updated_at: user2CreatedAt + 5_000,
          created_by: 'user-2',
          org_id: 'org-2',
          org_name: 'Org 2',
          workspace_name: 'WS 2',
        },
        {
          id: 'thread-user-3-signup',
          title: 'signup',
          workspace_id: 'ws-3',
          created_at: user3CreatedAt + 5_000,
          updated_at: user3CreatedAt + 5_000,
          created_by: 'user-3',
          org_id: 'org-3',
          org_name: 'Org 3',
          workspace_name: 'WS 3',
        },
      ],
      totalWorkspaces: 3,
      workspaces: [
        { id: 'ws-1', org_id: 'org-1' },
        { id: 'ws-2', org_id: 'org-2' },
        { id: 'ws-3', org_id: 'org-3' },
      ],
    });

    const retention = computeRetentionData(snapshot, { now });
    const retentionByDay = new Map(retention.retention_curve.map((entry) => [entry.day, entry]));
    expect(retentionByDay.get(0)).toEqual({
      day: 0,
      retention_pct: 100,
      users_eligible: 3,
    });
    expect(retentionByDay.get(1)).toEqual({
      day: 1,
      retention_pct: 33,
      users_eligible: 3,
    });
    expect(retentionByDay.get(7)).toEqual({
      day: 7,
      retention_pct: 50,
      users_eligible: 2,
    });

    const summary = computeDashboardSummary(snapshot, {
      now,
      selectedDate: '2026-03-29',
    });
    expect(summary.retention_snapshot).toEqual({
      rate_pct: 50,
      cohort_size: 2,
      retained_count: 1,
    });

    const activityByDate = buildActivityByDate(snapshot);
    expect(
      wasActiveInRange(
        activityByDate,
        'user-1',
        user1CreatedAt + DAY_MS,
        user1CreatedAt + 7 * DAY_MS,
      ),
    ).toBe(true);
    expect(
      wasActiveInRange(
        activityByDate,
        'user-2',
        user2CreatedAt + DAY_MS,
        user2CreatedAt + 7 * DAY_MS,
      ),
    ).toBe(false);
  });
});

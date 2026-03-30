import type {
  AdminAppListRow,
  AdminOrgDirectoryRow,
  AdminThreadListRow,
  AdminUserSummaryRow,
} from './admin-index-do.js';

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RETENTION_MILESTONES = [0, 1, 3, 7, 14, 21, 28] as const;

export interface DashboardMetricsFilterOptions {
  spamOrgIds?: string[];
  internalDomains?: string[];
}

export interface DashboardSummaryOptions extends DashboardMetricsFilterOptions {
  selectedDate: string;
  now?: number;
}

export interface DashboardRetentionOptions extends DashboardMetricsFilterOptions {
  now?: number;
}

export interface DashboardWorkspaceMetricsRow {
  id: string;
  org_id: string;
}

export interface DashboardEntitySnapshot {
  users: AdminUserSummaryRow[];
  threads: AdminThreadListRow[];
  apps: AdminAppListRow[];
  orgs: AdminOrgDirectoryRow[];
  workspaces: DashboardWorkspaceMetricsRow[];
  totalWorkspaces: number;
}

export interface DashboardSummaryResponse {
  kpis: {
    total_users: number;
    total_orgs: number;
    total_threads: number;
    total_apps: number;
    total_workspaces: number;
  };
  daily_series: Array<{
    date: string;
    new_users: number;
    new_threads: number;
    new_apps: number;
    returning_users: number;
    new_active_users: number;
    rolling_avg_signups: number;
  }>;
  weekly_series: Array<{
    week_start: string;
    label: string;
    new_users: number;
    returning_users: number;
    projected_new_users: number;
    projected_returning_users: number;
  }>;
  growth_thresholds: {
    signups: DashboardGrowthThresholds;
    returning: DashboardGrowthThresholds;
    total_active: DashboardGrowthThresholds;
  };
  selected_day: {
    date: string;
    new_users: number;
    new_threads: number;
    new_apps: number;
    new_orgs: number;
    top_users_by_threads: Array<{
      id: string;
      name: string | null;
      email: string;
      avatar: { color: string; content: string };
      thread_count: number;
    }>;
    top_orgs_by_activity: Array<{
      name: string;
      thread_count: number;
    }>;
    latest_threads: AdminThreadListRow[];
    latest_apps: AdminAppListRow[];
    latest_orgs: Array<{
      id: string;
      name: string;
      slug: string | null;
      created_by: string;
      created_at: number;
      archived: boolean;
      billing_status: string | null;
      member_count: number;
      workspace_count: number;
    }>;
    recent_users: AdminUserSummaryRow[];
  };
  billing_breakdown: Array<{
    status: 'active' | 'free';
    count: number;
  }>;
  app_visibility: {
    public: number;
    private: number;
  };
  retention_snapshot: {
    rate_pct: number;
    cohort_size: number;
    retained_count: number;
  };
}

export interface DashboardRetentionResponse {
  cohort_table: Array<{
    cohort_label: string;
    cohort_start_date: string;
    cohort_size: number;
    weeks: Array<{
      pct: number;
      count: number;
    } | null>;
  }>;
  max_week_columns: number;
  retention_curve: Array<{
    day: number;
    retention_pct: number;
    users_eligible: number;
  }>;
  wau_time_series: Array<{
    week_label: string;
    week_start: string;
    wau: number;
    new_users: number;
    returning_users: number;
  }>;
  stickiness_series: Array<{
    date: string;
    label: string;
    dau_wau_ratio: number;
    dau: number;
    wau: number;
  }>;
  kpis: {
    day1_retention: number;
    day7_retention: number;
    day14_retention: number;
    day30_retention: number;
    current_wau: number;
    previous_wau: number;
    wau_growth_pct: number;
    avg_stickiness: number;
  };
}

export interface DashboardGrowthThresholds {
  flat: number;
  linear: number;
  exponential: number;
  show_exponential: boolean;
}

type RawDashboardEntitySnapshot = Omit<DashboardEntitySnapshot, 'totalWorkspaces'>;

export function parseDateOnlyUtc(date: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    return null;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const value = Date.UTC(year, month - 1, day);
  const parsed = new Date(value);

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return value;
}

export function formatDateUtc(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function startOfUtcDay(timestampMs: number): number {
  const date = new Date(timestampMs);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function weekStartMondayUtc(timestampMs: number): number {
  const dayStart = startOfUtcDay(timestampMs);
  const date = new Date(dayStart);
  const dayOfWeek = (date.getUTCDay() + 6) % 7;
  return dayStart - dayOfWeek * DAY_MS;
}

export function buildActivityByDate(snapshot: Pick<DashboardEntitySnapshot, 'threads' | 'apps'>) {
  const activityByDate = new Map<string, Set<string>>();

  const append = (timestampMs: number, userId: string | null | undefined) => {
    if (!userId) {
      return;
    }
    const date = formatDateUtc(timestampMs);
    const set = activityByDate.get(date) ?? new Set<string>();
    set.add(userId);
    activityByDate.set(date, set);
  };

  for (const thread of snapshot.threads) {
    append(thread.created_at, thread.created_by);
  }
  for (const app of snapshot.apps) {
    append(app.created_at, app.created_by);
  }

  return activityByDate;
}

export function wasActiveInRange(
  activityByDate: Map<string, Set<string>>,
  userId: string,
  startMs: number,
  endMs: number,
): boolean {
  if (endMs < startMs) {
    return false;
  }

  const firstDay = startOfUtcDay(startMs);
  const lastDay = startOfUtcDay(endMs);

  for (let day = firstDay; day <= lastDay; day += DAY_MS) {
    if (activityByDate.get(formatDateUtc(day))?.has(userId)) {
      return true;
    }
  }

  return false;
}

export function filterDashboardEntitySnapshot(
  snapshot: RawDashboardEntitySnapshot,
  options: DashboardMetricsFilterOptions = {},
): DashboardEntitySnapshot {
  const normalizedInternalDomains = new Set(
    (options.internalDomains ?? [])
      .map((domain) => domain.trim().toLowerCase())
      .map((domain) => domain.replace(/^@+/, '').replace(/\.+$/, ''))
      .filter((domain) => domain.length > 0),
  );
  const spamOrgIds = new Set(
    (options.spamOrgIds ?? []).map((orgId) => orgId.trim()).filter((orgId) => orgId.length > 0),
  );

  const internalUserIds = new Set(
    snapshot.users
      .filter((user) => {
        const domain = getEmailDomain(user.email);
        return domain ? normalizedInternalDomains.has(domain) : false;
      })
      .map((user) => user.id),
  );
  const internalOrgIds = new Set(
    snapshot.orgs
      .filter((org) => {
        const domain = getEmailDomain(org.creator_email);
        return domain ? normalizedInternalDomains.has(domain) : false;
      })
      .map((org) => org.id),
  );
  const spamUserIds = new Set(
    snapshot.orgs
      .filter((org) => spamOrgIds.has(org.id))
      .map((org) => org.created_by),
  );
  const excludedUserIds = new Set<string>([...internalUserIds, ...spamUserIds]);

  const users = snapshot.users.filter((user) => !excludedUserIds.has(user.id));
  const orgs = snapshot.orgs.filter((org) => !spamOrgIds.has(org.id) && !internalOrgIds.has(org.id));
  const filteredOrgIds = new Set(orgs.map((org) => org.id));
  const threads = snapshot.threads.filter(
    (thread) => !spamOrgIds.has(thread.org_id) && !excludedUserIds.has(thread.created_by ?? ''),
  );
  const apps = snapshot.apps.filter(
    (app) => !spamOrgIds.has(app.org_id) && !excludedUserIds.has(app.created_by),
  );
  const workspaces = snapshot.workspaces.filter((workspace) => filteredOrgIds.has(workspace.org_id));

  return {
    users,
    orgs,
    threads,
    apps,
    workspaces,
    totalWorkspaces: workspaces.length,
  };
}

export function computeGrowthThresholds(series: number[]): DashboardGrowthThresholds {
  const today = series.at(-1) ?? 0;
  const history = series.slice(0, -1);
  const window = history.slice(-7);

  if (window.length === 0) {
    return {
      flat: 0,
      linear: 0,
      exponential: 0,
      show_exponential: false,
    };
  }

  const flatRaw = Math.max(0, mean(window));
  const slopes = window.slice(1).map((value, index) => value - window[index]);
  const linearRaw = Math.max(0, (window.at(-1) ?? 0) + mean(slopes));
  // `window.at(-1)` is yesterday: `series[-2]` in the original spec.
  const exponentialRaw = Math.max(linearRaw, Math.max(0, (window.at(-1) ?? 0) * 1.5));
  const flat = roundTo(flatRaw, 1);
  const linear = roundTo(linearRaw, 1);
  const exponential = roundTo(exponentialRaw, 1);

  return {
    flat,
    linear,
    exponential,
    show_exponential: exponential > 0 && today >= exponential * 0.6,
  };
}

export function computeDashboardSummary(
  snapshot: DashboardEntitySnapshot,
  options: DashboardSummaryOptions,
): DashboardSummaryResponse {
  const now = options.now ?? Date.now();
  const selectedDayStart = parseDateOnlyUtc(options.selectedDate);
  if (selectedDayStart === null) {
    throw new Error('Invalid selected date');
  }

  const activityByDate = buildActivityByDate(snapshot);
  const todayStart = startOfUtcDay(now);
  const seriesStart = todayStart - 29 * DAY_MS;
  const userCreatedAtById = new Map(snapshot.users.map((user) => [user.id, user.created_at]));
  const userById = new Map(snapshot.users.map((user) => [user.id, user]));
  const orgById = new Map(snapshot.orgs.map((org) => [org.id, org]));

  const days = Array.from({ length: 30 }, (_, index) => {
    const dayStart = seriesStart + index * DAY_MS;
    return {
      date: formatDateUtc(dayStart),
      new_users: 0,
      new_threads: 0,
      new_apps: 0,
      returning_users: new Set<string>(),
      new_active_users: new Set<string>(),
    };
  });
  const dayIndexByDate = new Map(days.map((day, index) => [day.date, index]));

  for (const user of snapshot.users) {
    const index = dayIndexByDate.get(formatDateUtc(user.created_at));
    if (index !== undefined) {
      days[index].new_users += 1;
    }
  }

  const classifyActivity = (createdAt: number, createdBy: string | null | undefined) => {
    if (!createdBy) {
      return;
    }
    const index = dayIndexByDate.get(formatDateUtc(createdAt));
    if (index === undefined) {
      return;
    }

    const signupAt = userCreatedAtById.get(createdBy);
    if (signupAt === undefined) {
      return;
    }

    const activityDay = days[index].date;
    const signupDay = formatDateUtc(signupAt);
    if (signupDay < activityDay) {
      days[index].returning_users.add(createdBy);
    } else if (signupDay === activityDay) {
      days[index].new_active_users.add(createdBy);
    }
  };

  for (const thread of snapshot.threads) {
    const index = dayIndexByDate.get(formatDateUtc(thread.created_at));
    if (index !== undefined) {
      days[index].new_threads += 1;
    }
    classifyActivity(thread.created_at, thread.created_by);
  }

  for (const app of snapshot.apps) {
    const index = dayIndexByDate.get(formatDateUtc(app.created_at));
    if (index !== undefined) {
      days[index].new_apps += 1;
    }
    classifyActivity(app.created_at, app.created_by);
  }

  const dailySeries = days.map((day, index) => {
    const rollingWindow = days.slice(Math.max(0, index - 6), index + 1);
    return {
      date: day.date,
      new_users: day.new_users,
      new_threads: day.new_threads,
      new_apps: day.new_apps,
      returning_users: day.returning_users.size,
      new_active_users: day.new_active_users.size,
      rolling_avg_signups: roundTo(mean(rollingWindow.map((entry) => entry.new_users)), 1),
    };
  });

  const signupsSeries = dailySeries.map((entry) => entry.new_users);
  const returningSeries = dailySeries.map((entry) => entry.returning_users);
  const totalActiveSeries = dailySeries.map((entry) => entry.returning_users + entry.new_active_users);

  const selectedDayEnd = selectedDayStart + DAY_MS - 1;
  const dayUsers = snapshot.users
    .filter((user) => user.created_at >= selectedDayStart && user.created_at <= selectedDayEnd)
    .sort((left, right) => compareNumbersDesc(left.created_at, right.created_at) || left.id.localeCompare(right.id));
  const dayThreads = snapshot.threads
    .filter((thread) => thread.created_at >= selectedDayStart && thread.created_at <= selectedDayEnd)
    .sort((left, right) => compareNumbersDesc(left.created_at, right.created_at) || left.id.localeCompare(right.id));
  const dayApps = snapshot.apps
    .filter((app) => app.created_at >= selectedDayStart && app.created_at <= selectedDayEnd)
    .sort((left, right) => compareNumbersDesc(left.created_at, right.created_at) || left.app_id.localeCompare(right.app_id));
  const dayOrgs = snapshot.orgs
    .filter((org) => org.created_at >= selectedDayStart && org.created_at <= selectedDayEnd)
    .sort((left, right) => compareNumbersDesc(left.created_at, right.created_at) || left.id.localeCompare(right.id));

  const topUsersByThreads = Array.from(
    dayThreads.reduce((accumulator, thread) => {
      if (!thread.created_by) {
        return accumulator;
      }
      const user = userById.get(thread.created_by);
      if (!user) {
        return accumulator;
      }

      const current = accumulator.get(thread.created_by) ?? {
        user,
        thread_count: 0,
        latest_activity_at: 0,
      };
      current.thread_count += 1;
      current.latest_activity_at = Math.max(current.latest_activity_at, thread.created_at);
      accumulator.set(thread.created_by, current);
      return accumulator;
    }, new Map<string, { user: AdminUserSummaryRow; thread_count: number; latest_activity_at: number }>()),
  )
    .sort((left, right) =>
      compareNumbersDesc(left[1].thread_count, right[1].thread_count)
      || compareNumbersDesc(left[1].latest_activity_at, right[1].latest_activity_at)
      || left[0].localeCompare(right[0]))
    .slice(0, 10)
    .map(([, entry]) => ({
      id: entry.user.id,
      name: entry.user.name,
      email: entry.user.email,
      avatar: entry.user.avatar,
      thread_count: entry.thread_count,
    }));

  const topOrgsByActivity = Array.from(
    dayThreads.reduce((accumulator, thread) => {
      const orgName =
        thread.org_name
        ?? orgById.get(thread.org_id)?.name
        ?? thread.org_id;
      const current = accumulator.get(thread.org_id) ?? {
        name: orgName,
        thread_count: 0,
        latest_activity_at: 0,
      };
      current.thread_count += 1;
      current.latest_activity_at = Math.max(current.latest_activity_at, thread.created_at);
      accumulator.set(thread.org_id, current);
      return accumulator;
    }, new Map<string, { name: string; thread_count: number; latest_activity_at: number }>()),
  )
    .sort((left, right) =>
      compareNumbersDesc(left[1].thread_count, right[1].thread_count)
      || compareNumbersDesc(left[1].latest_activity_at, right[1].latest_activity_at)
      || left[1].name.localeCompare(right[1].name))
    .slice(0, 10)
    .map(([, entry]) => ({
      name: entry.name,
      thread_count: entry.thread_count,
    }));

  const activeOrgCount = snapshot.orgs.reduce(
    (count, org) => count + (normalizeBillingStatus(org.billing_status) === 'active' ? 1 : 0),
    0,
  );
  const publicApps = snapshot.apps.reduce((count, app) => count + (app.is_public ? 1 : 0), 0);
  const retentionSnapshot = computeRetentionPoint(snapshot.users, activityByDate, now, 7);

  return {
    kpis: {
      total_users: snapshot.users.length,
      total_orgs: snapshot.orgs.length,
      total_threads: snapshot.threads.length,
      total_apps: snapshot.apps.length,
      total_workspaces: snapshot.totalWorkspaces,
    },
    daily_series: dailySeries,
    weekly_series: computeWeeklySeries(dailySeries, now),
    growth_thresholds: {
      signups: computeGrowthThresholds(signupsSeries),
      returning: computeGrowthThresholds(returningSeries),
      total_active: computeGrowthThresholds(totalActiveSeries),
    },
    selected_day: {
      date: options.selectedDate,
      new_users: dayUsers.length,
      new_threads: dayThreads.length,
      new_apps: dayApps.length,
      new_orgs: dayOrgs.length,
      top_users_by_threads: topUsersByThreads,
      top_orgs_by_activity: topOrgsByActivity,
      latest_threads: dayThreads.slice(0, 10),
      latest_apps: dayApps.slice(0, 10),
      latest_orgs: dayOrgs.slice(0, 10).map((org) => ({
        id: org.id,
        name: org.name,
        slug: org.slug ?? null,
        created_by: org.created_by,
        created_at: org.created_at,
        archived: org.archived,
        billing_status: normalizeBillingStatus(org.billing_status),
        member_count: org.member_count,
        workspace_count: org.workspace_count,
      })),
      recent_users: dayUsers.slice(0, 10),
    },
    billing_breakdown: [
      { status: 'active', count: activeOrgCount },
      { status: 'free', count: snapshot.orgs.length - activeOrgCount },
    ],
    app_visibility: {
      public: publicApps,
      private: snapshot.apps.length - publicApps,
    },
    retention_snapshot: {
      rate_pct: retentionSnapshot.retention_pct,
      cohort_size: retentionSnapshot.users_eligible,
      retained_count: retentionSnapshot.retained_count,
    },
  };
}

export function computeRetentionData(
  snapshot: DashboardEntitySnapshot,
  options: DashboardRetentionOptions = {},
): DashboardRetentionResponse {
  const now = options.now ?? Date.now();
  const activityByDate = buildActivityByDate(snapshot);
  const usersByCohortStart = new Map<number, AdminUserSummaryRow[]>();

  for (const user of snapshot.users) {
    const cohortStart = weekStartMondayUtc(user.created_at);
    const cohort = usersByCohortStart.get(cohortStart) ?? [];
    cohort.push(user);
    usersByCohortStart.set(cohortStart, cohort);
  }

  const cohortStarts = Array.from(usersByCohortStart.keys()).sort((left, right) => left - right).slice(-10);
  const earliestCohortStart = cohortStarts[0] ?? weekStartMondayUtc(now);
  const maxWeekColumns = cohortStarts.length > 0
    ? Math.min(8, Math.max(0, Math.floor((now - earliestCohortStart) / WEEK_MS)))
    : 0;

  const cohortTable = cohortStarts.map((cohortStart) => {
    const users = usersByCohortStart.get(cohortStart) ?? [];
    const weeks = Array.from({ length: maxWeekColumns + 1 }, (_, weekIndex) => {
      const weekStart = cohortStart + weekIndex * WEEK_MS;
      const weekEnd = weekStart + WEEK_MS - 1;

      if (weekStart > now) {
        return null;
      }
      if (weekEnd > now && weekIndex > 0) {
        return null;
      }

      const activeCount = users.reduce(
        (count, user) => count + (wasActiveInRange(activityByDate, user.id, weekStart, Math.min(weekEnd, now)) ? 1 : 0),
        0,
      );

      return {
        pct: users.length > 0 ? Math.round((activeCount / users.length) * 100) : 0,
        count: activeCount,
      };
    });

    return {
      cohort_label: formatMonthDay(cohortStart),
      cohort_start_date: formatDateUtc(cohortStart),
      cohort_size: users.length,
      weeks,
    };
  });

  const retentionCurve = RETENTION_MILESTONES.map((day) => {
    const point = computeRetentionPoint(snapshot.users, activityByDate, now, day);
    return {
      day,
      retention_pct: point.retention_pct,
      users_eligible: point.users_eligible,
    };
  });

  const wauTimeSeries = computeWauTimeSeries(snapshot.users, activityByDate, now);
  const stickinessSeries = computeStickinessSeries(activityByDate, now);
  const retentionByDay = new Map(retentionCurve.map((entry) => [entry.day, entry.retention_pct]));
  const currentWau = wauTimeSeries.at(-1)?.wau ?? 0;
  const previousWau = wauTimeSeries.at(-2)?.wau ?? 0;
  const avgStickiness = roundTo(
    mean(stickinessSeries.slice(-28).map((entry) => entry.dau_wau_ratio)),
    2,
  );

  return {
    cohort_table: cohortTable,
    max_week_columns: maxWeekColumns,
    retention_curve: retentionCurve,
    wau_time_series: wauTimeSeries,
    stickiness_series: stickinessSeries,
    kpis: {
      day1_retention: retentionByDay.get(1) ?? 0,
      day7_retention: retentionByDay.get(7) ?? 0,
      day14_retention: retentionByDay.get(14) ?? 0,
      day30_retention: retentionByDay.get(28) ?? 0,
      current_wau: currentWau,
      previous_wau: previousWau,
      wau_growth_pct: previousWau > 0 ? Math.round(((currentWau - previousWau) / previousWau) * 100) : 0,
      avg_stickiness: avgStickiness,
    },
  };
}

function computeWeeklySeries(
  dailySeries: DashboardSummaryResponse['daily_series'],
  now: number,
): DashboardSummaryResponse['weekly_series'] {
  if (dailySeries.length === 0) {
    return [];
  }

  const currentWeekStart = weekStartMondayUtc(now);
  const firstDayStart = parseDateOnlyUtc(dailySeries[0].date);
  if (firstDayStart === null) {
    return [];
  }

  const weekBuckets = new Map<number, {
    new_users: number;
    returning_users: number;
    days_present: Set<number>;
  }>();
  const newByDowTotals = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }));
  const returningByDowTotals = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }));

  for (const entry of dailySeries) {
    const dayStart = parseDateOnlyUtc(entry.date);
    if (dayStart === null) {
      continue;
    }
    const weekStart = weekStartMondayUtc(dayStart);
    const dayOfWeek = (new Date(dayStart).getUTCDay() + 6) % 7;
    const bucket = weekBuckets.get(weekStart) ?? {
      new_users: 0,
      returning_users: 0,
      days_present: new Set<number>(),
    };
    bucket.new_users += entry.new_users;
    bucket.returning_users += entry.returning_users;
    bucket.days_present.add(dayOfWeek);
    weekBuckets.set(weekStart, bucket);

    if (weekStart !== currentWeekStart) {
      newByDowTotals[dayOfWeek].sum += entry.new_users;
      newByDowTotals[dayOfWeek].count += 1;
      returningByDowTotals[dayOfWeek].sum += entry.returning_users;
      returningByDowTotals[dayOfWeek].count += 1;
    }
  }

  const startWeek = weekStartMondayUtc(firstDayStart);
  const items: DashboardSummaryResponse['weekly_series'] = [];

  for (let weekStart = startWeek; weekStart <= currentWeekStart; weekStart += WEEK_MS) {
    const bucket = weekBuckets.get(weekStart) ?? {
      new_users: 0,
      returning_users: 0,
      days_present: new Set<number>(),
    };

    let projectedNewUsers = 0;
    let projectedReturningUsers = 0;

    if (weekStart === currentWeekStart) {
      const missingDays = Array.from({ length: 7 }, (_, dayOfWeek) => dayOfWeek)
        .filter((dayOfWeek) => !bucket.days_present.has(dayOfWeek));

      projectedNewUsers = Math.round(
        missingDays.reduce((sum, dayOfWeek) => {
          const totals = newByDowTotals[dayOfWeek];
          return sum + (totals.count > 0 ? totals.sum / totals.count : 0);
        }, 0),
      );
      projectedReturningUsers = Math.round(
        missingDays.reduce((sum, dayOfWeek) => {
          const totals = returningByDowTotals[dayOfWeek];
          return sum + (totals.count > 0 ? totals.sum / totals.count : 0);
        }, 0),
      );
    }

    items.push({
      week_start: formatDateUtc(weekStart),
      label: `Week of ${formatMonthDay(weekStart)}`,
      new_users: bucket.new_users,
      returning_users: bucket.returning_users,
      projected_new_users: projectedNewUsers,
      projected_returning_users: projectedReturningUsers,
    });
  }

  return items;
}

function computeWauTimeSeries(
  users: AdminUserSummaryRow[],
  activityByDate: Map<string, Set<string>>,
  now: number,
): DashboardRetentionResponse['wau_time_series'] {
  const userCreatedAtById = new Map(users.map((user) => [user.id, user.created_at]));
  const startWeek = weekStartMondayUtc(now - 30 * DAY_MS);
  const currentWeek = weekStartMondayUtc(now);
  const items: DashboardRetentionResponse['wau_time_series'] = [];

  for (let weekStart = startWeek; weekStart <= currentWeek; weekStart += WEEK_MS) {
    const weekEnd = Math.min(weekStart + WEEK_MS - 1, now);
    const activeUsers = new Set<string>();

    for (let day = weekStart; day <= weekEnd; day += DAY_MS) {
      for (const userId of activityByDate.get(formatDateUtc(day)) ?? []) {
        activeUsers.add(userId);
      }
    }

    let newUsers = 0;
    for (const userId of activeUsers) {
      const createdAt = userCreatedAtById.get(userId);
      if (createdAt !== undefined && createdAt >= weekStart && createdAt <= weekStart + WEEK_MS - 1) {
        newUsers += 1;
      }
    }

    items.push({
      week_label: formatMonthDay(weekStart),
      week_start: formatDateUtc(weekStart),
      wau: activeUsers.size,
      new_users: newUsers,
      returning_users: activeUsers.size - newUsers,
    });
  }

  return items;
}

function computeStickinessSeries(
  activityByDate: Map<string, Set<string>>,
  now: number,
): DashboardRetentionResponse['stickiness_series'] {
  const todayStart = startOfUtcDay(now);
  const startDay = todayStart - 29 * DAY_MS;

  return Array.from({ length: 30 }, (_, index) => {
    const dayStart = startDay + index * DAY_MS;
    const dau = activityByDate.get(formatDateUtc(dayStart))?.size ?? 0;
    const wauUsers = new Set<string>();

    for (let cursor = dayStart - 6 * DAY_MS; cursor <= dayStart; cursor += DAY_MS) {
      for (const userId of activityByDate.get(formatDateUtc(cursor)) ?? []) {
        wauUsers.add(userId);
      }
    }

    return {
      date: formatDateUtc(dayStart),
      label: formatMonthDay(dayStart),
      dau_wau_ratio: wauUsers.size > 0 ? roundTo(dau / wauUsers.size, 2) : 0,
      dau,
      wau: wauUsers.size,
    };
  });
}

function computeRetentionPoint(
  users: AdminUserSummaryRow[],
  activityByDate: Map<string, Set<string>>,
  now: number,
  milestoneDay: number,
) {
  const eligibleUsers = users.filter((user) => now - user.created_at >= milestoneDay * DAY_MS);
  const retainedCount = eligibleUsers.reduce((count, user) => {
    const isRetained = milestoneDay === 0
      ? wasActiveInRange(activityByDate, user.id, user.created_at, user.created_at + DAY_MS - 1)
      : wasActiveInRange(activityByDate, user.id, user.created_at + DAY_MS, user.created_at + milestoneDay * DAY_MS);
    return count + (isRetained ? 1 : 0);
  }, 0);

  return {
    users_eligible: eligibleUsers.length,
    retained_count: retainedCount,
    retention_pct: eligibleUsers.length > 0 ? Math.round((retainedCount / eligibleUsers.length) * 100) : 0,
  };
}

function getEmailDomain(email: string | null | undefined): string | null {
  if (!email) {
    return null;
  }
  const atIndex = email.lastIndexOf('@');
  if (atIndex < 0 || atIndex === email.length - 1) {
    return null;
  }
  return email.slice(atIndex + 1).trim().toLowerCase();
}

function normalizeBillingStatus(status: string | null | undefined): 'active' | 'free' {
  return status === 'paying' ? 'active' : 'free';
}

function formatMonthDay(timestampMs: number): string {
  const date = new Date(timestampMs);
  return `${MONTH_LABELS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function compareNumbersDesc(left: number, right: number): number {
  return right - left;
}

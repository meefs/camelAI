import { describe, expect, it } from 'vitest';
import { formatAutomationRun } from '../src/code-mode-deterministic-automations';
import type { AutomationRunRecord } from '../src/workspace-cron';

describe('formatAutomationRun', () => {
  const base: AutomationRunRecord = {
    id: 'run1',
    kind: 'deterministic_automation',
    automation_id: 'wf1',
    trigger: 'manual',
    status: 'success',
    started_at: 1_000,
    completed_at: 3_500,
    message: null,
    thread_id: null,
    instance_id: 'inst-1',
    created_at: 1_000,
  };

  it('computes duration and ISO timestamps for a completed run', () => {
    expect(formatAutomationRun(base)).toEqual({
      instance_id: 'inst-1',
      status: 'success',
      trigger: 'manual',
      started_at: new Date(1_000).toISOString(),
      completed_at: new Date(3_500).toISOString(),
      duration_ms: 2_500,
      error: null,
    });
  });

  it('surfaces the error message on a failed run', () => {
    const out = formatAutomationRun({ ...base, status: 'error', message: 'step 2 threw' });
    expect(out.status).toBe('error');
    expect(out.error).toBe('step 2 threw');
  });

  it('leaves duration null while a run is still in progress', () => {
    const out = formatAutomationRun({ ...base, status: 'started', completed_at: null, message: null });
    expect(out.completed_at).toBeNull();
    expect(out.duration_ms).toBeNull();
    expect(out.error).toBeNull();
  });
});

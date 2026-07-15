export type ThreadProjectActivityType = 'created' | 'deployed';

export interface ThreadProjectActivity {
  projectId: string;
  activityType: ThreadProjectActivityType;
  lastUsedAt: number;
}

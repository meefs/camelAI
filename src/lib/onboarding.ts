import type {
  OnboardingAiFamiliarity,
  OnboardingDesignStyle,
  OnboardingFileType,
  OnboardingIterationStyle,
  OnboardingPreferences,
  OnboardingStarterProject,
  OnboardingStakes,
} from '@/types';
import { logoRegistry } from '@/lib/integration-logo-registry';
import { INTEGRATION_REGISTRY } from '@/lib/integration-registry';

export const ONBOARDING_PROGRESS_STORAGE_KEY_PREFIX = 'chiridion:onboarding:progress';

export function getOnboardingProgressStorageKey(userId: string): string {
  const normalizedUserId = userId.trim();
  if (!normalizedUserId) {
    return `${ONBOARDING_PROGRESS_STORAGE_KEY_PREFIX}:anonymous`;
  }
  return `${ONBOARDING_PROGRESS_STORAGE_KEY_PREFIX}:${normalizedUserId}`;
}

export type OnboardingStepId =
  | 'welcome'
  | 'orgSlug'
  | 'q1'
  | 'q2'
  | 'q4'
  | 'q5'
  | 'q6';

export type OnboardingTransitionDirection = 'forward' | 'backward' | 'none';

export interface OnboardingProgressState {
  currentStep: OnboardingStepId;
  answers: Partial<OnboardingPreferences>;
  startedAt: number;
  pendingOrgSlug?: string | null;
  showOrgSlugStep?: boolean;
}

export interface OnboardingOption<TValue extends string> {
  value: TValue;
  title: string;
  description?: string;
}

export interface DesignStyleOption {
  value: OnboardingDesignStyle;
  label: string;
}

export interface StarterProjectOption {
  value: OnboardingStarterProject;
  title: string;
  description: string;
}

export interface IntegrationInterestOption {
  id: string;
  label: string;
}

function toTitleCaseLabel(value: string): string {
  if (value === 'x') return 'X';
  return value
    .split(/[-_]/g)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function getIntegrationInterestLabel(type: string): string {
  const registryDefinition = INTEGRATION_REGISTRY[type];
  if (registryDefinition?.displayName) {
    return registryDefinition.displayName;
  }
  return toTitleCaseLabel(type);
}

export const DEFAULT_ONBOARDING_PREFERENCES: OnboardingPreferences = {
  ai_familiarity: null,
  iteration_style: null,
  stakes: null,
  design_style: null,
  starter_project: null,
  data_interests: {
    files: [],
    integrations: [],
  },
  completed_at: null,
};

export const STEP_PATHS: Record<OnboardingStepId, string> = {
  welcome: '/onboarding',
  orgSlug: '/onboarding/org-slug',
  q1: '/onboarding/ai-familiarity',
  q2: '/onboarding/iteration-style',
  q4: '/onboarding/design-style',
  q5: '/onboarding/starter-project',
  q6: '/onboarding/data-interests',
};

export const AI_FAMILIARITY_OPTIONS: OnboardingOption<OnboardingAiFamiliarity>[] = [
  {
    value: 'extensive',
    title: 'Yes, extensively',
    description: 'I use Claude Code, Cursor, Copilot regularly',
  },
  {
    value: 'occasional',
    title: 'Yes, occasionally',
    description: "I've vibe-coded a few things",
  },
  {
    value: 'a_little',
    title: 'A little',
    description: "I've chatted with AI but haven't built much",
  },
  {
    value: 'new',
    title: 'This is new to me',
    description: 'First time trying something like this',
  },
];

export const ITERATION_STYLE_OPTIONS: OnboardingOption<OnboardingIterationStyle>[] = [
  {
    value: 'show_quick',
    title: 'Show me something quick',
    description: "I'll react and we'll iterate from there",
  },
  {
    value: 'ask_first',
    title: 'Ask me questions first',
    description: 'I want to make sure we are aligned before you build',
  },
  {
    value: 'depends',
    title: 'Depends on the project',
    description: "I'll tell you each time",
  },
];

export const STAKES_OPTIONS: OnboardingOption<OnboardingStakes>[] = [
  {
    value: 'trying_out',
    title: 'Something quick to try this out',
    description: 'Just experimenting, no pressure',
  },
  {
    value: 'for_myself',
    title: 'A tool for myself',
    description: 'Should work reliably, but just for me',
  },
  {
    value: 'for_team',
    title: 'Something for my team',
    description: 'Others on my team will use this',
  },
  {
    value: 'for_public',
    title: 'Something for customers / the public',
    description: 'Needs to handle real users',
  },
  {
    value: 'for_money',
    title: 'Something I could charge for',
    description: 'Production-grade and polished',
  },
];

export const DESIGN_STYLE_OPTIONS: DesignStyleOption[] = [
  {
    value: 'colorful',
    label: 'Colorful & Playful',
  },
  {
    value: 'sleek',
    label: 'Sleek & Modern',
  },
  {
    value: 'minimal',
    label: 'Minimal & Clean',
  },
  {
    value: 'warm',
    label: 'Warm & Friendly',
  },
  {
    value: 'bold',
    label: 'Bold & Dramatic',
  },
  {
    value: 'per_project',
    label: "I'll tell you each time",
  },
];

export const STARTER_PROJECT_OPTIONS: StarterProjectOption[] = [
  {
    value: 'data_analytics',
    title: 'Data analytics',
    description: 'Upload a spreadsheets or connect a database for insights',
  },
  {
    value: 'personal_site',
    title: 'Personal site',
    description: 'Your corner of the internet',
  },
  {
    value: 'ai_agent',
    title: 'AI Agent',
    description: 'Create your own chat or make an agent',
  },
  {
    value: 'business_tool',
    title: 'Business tool',
    description: 'Internal tools, dashboards, and admin panels',
  },
  {
    value: 'something_fun',
    title: 'Something fun',
    description: 'Games, experiments, and creative projects',
  },
];

export const DATA_FILE_OPTIONS: Array<{ id: OnboardingFileType; label: string }> = [
  { id: 'csv', label: 'CSV' },
  { id: 'excel', label: 'Excel' },
  { id: 'sqlite', label: 'SQLite' },
  { id: 'json', label: 'JSON' },
];

export const DEFAULT_INTEGRATION_INTERESTS: IntegrationInterestOption[] = [
  ...Object.keys(logoRegistry)
    .sort((left, right) =>
      getIntegrationInterestLabel(left).localeCompare(
        getIntegrationInterestLabel(right)
      )
    )
    .map((id) => ({
      id,
      label: getIntegrationInterestLabel(id),
    })),
];

const AI_FAMILIARITY_LABELS: Record<OnboardingAiFamiliarity, string> = {
  extensive: 'Extensive (uses AI coding tools regularly)',
  occasional: 'Occasional (has vibe-coded a few things)',
  a_little: "A little (has chatted with AI but hasn't built much)",
  new: 'New to AI (first time)',
};

const ITERATION_STYLE_LABELS: Record<OnboardingIterationStyle, string> = {
  show_quick: 'Show me something quick, then iterate',
  ask_first: 'Ask questions first before building',
  depends: 'Depends on the project',
};

const STAKES_LABELS: Record<OnboardingStakes, string> = {
  trying_out: 'Just trying this out, experimenting',
  for_myself: 'A tool for myself',
  for_team: 'Something for my team',
  for_public: 'Something for customers/public',
  for_money: 'Production-grade and potentially monetized',
};

const DESIGN_STYLE_LABELS: Record<OnboardingDesignStyle, string> = {
  colorful: 'Colorful & playful',
  sleek: 'Sleek & modern',
  minimal: 'Minimal & clean',
  warm: 'Warm & friendly',
  bold: 'Bold & dramatic',
  per_project: 'Will specify per project',
};

const STARTER_PROJECT_LABELS: Record<OnboardingStarterProject, string> = {
  data_analytics: 'Data analytics',
  personal_site: 'Personal site',
  business_tool: 'Business tool',
  ai_agent: 'AI Agent',
  something_fun: 'Something fun',
};

const STARTER_PROJECT_GUIDANCE: Record<OnboardingStarterProject, string> = {
  data_analytics:
    'They chose "Data analytics". Welcome them warmly and invite them to drag and drop a CSV, Excel file, or other data file to get started.',
  personal_site:
    'They chose "Personal site". Ask about the vibe they want and what they want to showcase.',
  business_tool:
    'They chose "Business tool". Ask what workflow is painful and what data they need to manage.',
  ai_agent:
    'They chose "AI Agent". Ask what kind of agent or chat experience they want to build and what it should do.',
  something_fun:
    'They chose "Something fun". Offer a few playful project ideas and jump right in.',
};

function dedupeStrings(items: string[] | undefined): string[] {
  if (!Array.isArray(items)) return [];
  const normalized = items
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

export function normalizePreferences(
  input: Partial<OnboardingPreferences> | OnboardingPreferences | null | undefined
): OnboardingPreferences {
  const next = input ?? {};
  return {
    ai_familiarity: next.ai_familiarity ?? null,
    iteration_style: next.iteration_style ?? null,
    stakes: next.stakes ?? null,
    design_style: next.design_style ?? null,
    starter_project: next.starter_project ?? null,
    data_interests: {
      files: dedupeStrings(next.data_interests?.files) as OnboardingFileType[],
      integrations: dedupeStrings(next.data_interests?.integrations),
    },
    completed_at: next.completed_at ?? null,
  };
}

export function stepIdFromPath(pathname: string): OnboardingStepId {
  const normalized = pathname.replace(/\/+$/, '') || '/onboarding';
  const entry = Object.entries(STEP_PATHS).find(([, path]) => path === normalized);
  return (entry?.[0] as OnboardingStepId | undefined) ?? 'welcome';
}

export function getStepSequence(options: {
  showOrgSlugStep: boolean;
  aiFamiliarity: OnboardingAiFamiliarity | null;
  teamWelcomeOnly?: boolean;
}): OnboardingStepId[] {
  const sequence: OnboardingStepId[] = ['welcome'];

  if (options.teamWelcomeOnly) {
    return sequence;
  }

  if (options.showOrgSlugStep) {
    sequence.push('orgSlug');
  }
  sequence.push('q1');

  if (options.aiFamiliarity === 'extensive') {
    sequence.push('q4', 'q6');
  } else {
    sequence.push('q2', 'q4', 'q5', 'q6');
  }

  return sequence;
}

const ONBOARDING_STEP_ORDER: OnboardingStepId[] = [
  'welcome',
  'orgSlug',
  'q1',
  'q2',
  'q4',
  'q5',
  'q6',
];

export function getNearestValidStep(
  current: OnboardingStepId,
  sequence: OnboardingStepId[]
): OnboardingStepId | null {
  if (sequence.includes(current)) {
    return current;
  }
  if (sequence.length === 0) {
    return null;
  }

  const currentIndex = ONBOARDING_STEP_ORDER.indexOf(current);
  if (currentIndex < 0) {
    return sequence[0];
  }

  for (let index = currentIndex + 1; index < ONBOARDING_STEP_ORDER.length; index += 1) {
    const candidate = ONBOARDING_STEP_ORDER[index];
    if (sequence.includes(candidate)) {
      return candidate;
    }
  }

  return sequence[0];
}

export function getStepIndex(step: OnboardingStepId, sequence: OnboardingStepId[]): number {
  return sequence.indexOf(step);
}

export function getNextStep(
  current: OnboardingStepId,
  sequence: OnboardingStepId[]
): OnboardingStepId | null {
  const index = sequence.indexOf(current);
  if (index < 0) return null;
  return sequence[index + 1] ?? null;
}

export function getPreviousStep(
  current: OnboardingStepId,
  sequence: OnboardingStepId[]
): OnboardingStepId | null {
  const index = sequence.indexOf(current);
  if (index <= 0) return null;
  return sequence[index - 1] ?? null;
}

export function hasCompletedOnboarding(
  onboarding: OnboardingPreferences | null | undefined
): boolean {
  return Boolean(onboarding?.completed_at);
}

export function buildOnboardingSystemContext(
  prefsInput: OnboardingPreferences,
  integrationNames?: Map<string, string>
): string {
  const prefs = normalizePreferences(prefsInput);
  const lines: string[] = [
    'New user completed onboarding. Here is what we know:',
  ];

  if (prefs.ai_familiarity) {
    lines.push(`- AI familiarity: ${AI_FAMILIARITY_LABELS[prefs.ai_familiarity]}`);
  }
  if (prefs.iteration_style) {
    lines.push(`- Iteration style: ${ITERATION_STYLE_LABELS[prefs.iteration_style]}`);
  }
  if (prefs.stakes) {
    lines.push(`- Stakes: ${STAKES_LABELS[prefs.stakes]}`);
  }
  if (prefs.design_style) {
    lines.push(`- Design preference: ${DESIGN_STYLE_LABELS[prefs.design_style]}`);
  }
  if (prefs.starter_project) {
    lines.push(`- Starter project: ${STARTER_PROJECT_LABELS[prefs.starter_project]}`);
  }
  if (prefs.data_interests.files.length > 0) {
    lines.push(`- Interested file types: ${prefs.data_interests.files.join(', ').toUpperCase()}`);
  }
  if (prefs.data_interests.integrations.length > 0) {
    const named = prefs.data_interests.integrations.map((id) => {
      const resolved = integrationNames?.get(id);
      return resolved ?? id;
    });
    lines.push(`- Interested integrations: ${named.join(', ')}`);
  }

  if (prefs.starter_project) {
    lines.push('');
    lines.push('This is their first conversation after onboarding.');
    lines.push(STARTER_PROJECT_GUIDANCE[prefs.starter_project]);
  } else {
    lines.push('');
    lines.push(
      'This is their first conversation after onboarding. Welcome them and ask what they want to build first.'
    );
  }

  return lines.join('\n');
}

export function buildOnboardingProfileMarkdown(
  prefsInput: OnboardingPreferences,
  integrationNames?: Map<string, string>
): string {
  const prefs = normalizePreferences(prefsInput);
  const lines = ['## Preferences'];

  if (prefs.ai_familiarity) {
    lines.push(`- AI familiarity: ${AI_FAMILIARITY_LABELS[prefs.ai_familiarity]}`);
  }
  if (prefs.iteration_style) {
    lines.push(`- Iteration style: ${ITERATION_STYLE_LABELS[prefs.iteration_style]}`);
  }
  if (prefs.stakes) {
    lines.push(`- Stakes: ${STAKES_LABELS[prefs.stakes]}`);
  }
  if (prefs.design_style) {
    lines.push(`- Design preference: ${DESIGN_STYLE_LABELS[prefs.design_style]}`);
  }
  if (prefs.starter_project) {
    lines.push(`- Starter project: ${STARTER_PROJECT_LABELS[prefs.starter_project]}`);
  }

  const dataInterests: string[] = [];
  if (prefs.data_interests.files.length > 0) {
    dataInterests.push(...prefs.data_interests.files.map((file) => file.toUpperCase()));
  }
  if (prefs.data_interests.integrations.length > 0) {
    dataInterests.push(
      ...prefs.data_interests.integrations.map((id) => integrationNames?.get(id) ?? id)
    );
  }
  if (dataInterests.length > 0) {
    lines.push(`- Data interests: ${dataInterests.join(', ')}`);
  }

  return lines.join('\n');
}

import { z } from 'zod';

export const SUPPORT_EMAIL = 'support@camelai.com';

export const HELP_CATEGORY_VALUES = [
  'bug',
  'feature',
  'question',
  'billing',
  'other',
] as const;

export const HELP_SEVERITY_VALUES = ['low', 'medium', 'high'] as const;

export type HelpCategory = (typeof HELP_CATEGORY_VALUES)[number];
export type HelpSeverity = (typeof HELP_SEVERITY_VALUES)[number];

export const HELP_CATEGORY_LABELS: Record<HelpCategory, string> = {
  bug: 'Bug report',
  feature: 'Feature request',
  question: 'Question',
  billing: 'Account & billing',
  other: 'Other',
};

export const HELP_CATEGORY_SUBJECT_LABELS: Record<HelpCategory, string> = {
  bug: 'Bug',
  feature: 'Feature',
  question: 'Question',
  billing: 'Billing',
  other: 'Other',
};

export const HELP_SEVERITY_LABELS: Record<HelpSeverity, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

export const getHelpFormSchema = z.object({
  category: z.enum(HELP_CATEGORY_VALUES),
  severity: z.enum(HELP_SEVERITY_VALUES).default('low'),
  description: z.string().trim().min(1, 'Please describe your issue'),
  pageUrl: z.string().optional(),
  screenSize: z.string().optional(),
});

export type GetHelpFormValues = z.infer<typeof getHelpFormSchema>;

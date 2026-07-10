import { slug } from '@/lib/mentions';
import type { Message, PreviewTab, ToolUseBlock } from '@/types';

export interface CopyFilePathTarget {
  path: string;
  source?: 'workspace' | 'project' | 'upload' | 'output' | string | null;
  project?: string | null;
  projectId?: string | null;
}

export interface FormatCopyFilePathOptions<
  T extends { kind?: string; id?: string; name?: string },
> {
  mentionSlugMap?: ReadonlyMap<string, T> | null;
  fallbackProjectMention?: boolean;
}

export interface ProjectReference {
  project: string;
  projectId?: string | null;
  source: 'preview' | 'tool';
}

const COPY_FILE_TOOL_NAMES = new Set([
  'read',
  'write',
  'edit',
  'notebookedit',
  'grep',
  'glob',
]);

export function normalizeProjectCopyLookupKey(value: string): string {
  return slug(value);
}

export function resolveProjectMentionSlug<
  T extends { kind?: string; id?: string; name?: string },
>(
  projectName: string,
  mentionSlugMap?: ReadonlyMap<string, T> | null,
  options: { projectId?: string | null } = {},
): string | null {
  const projectKey = normalizeProjectCopyLookupKey(projectName);
  if (!projectKey || !mentionSlugMap) return null;

  const exactProjectId = options.projectId?.trim();
  if (exactProjectId) {
    for (const [projectSlug, mentionTarget] of mentionSlugMap) {
      if (
        mentionTarget.kind === 'project' &&
        mentionTarget.id === exactProjectId
      ) {
        return projectSlug;
      }
    }
  }

  const exactProjectName = projectName.trim();
  for (const [projectSlug, mentionTarget] of mentionSlugMap) {
    if (
      mentionTarget.kind === 'project' &&
      (mentionTarget.name ?? '').trim() === exactProjectName
    ) {
      return projectSlug;
    }
  }

  const normalizedMatches: string[] = [];
  for (const [projectSlug, mentionTarget] of mentionSlugMap) {
    if (
      mentionTarget.kind === 'project' &&
      normalizeProjectCopyLookupKey(mentionTarget.name ?? '') === projectKey
    ) {
      normalizedMatches.push(projectSlug);
    }
  }

  return normalizedMatches.length === 1 ? normalizedMatches[0] : null;
}

function getProjectReferenceFromToolInput(
  tool: Pick<ToolUseBlock, 'name' | 'input'>,
): ProjectReference | null {
  if (!COPY_FILE_TOOL_NAMES.has(tool.name.toLowerCase())) return null;
  const input = tool.input;
  if (input.location !== 'project') return null;
  const project = typeof input.project === 'string' ? input.project.trim() : '';
  const projectId =
    typeof input.projectId === 'string'
      ? input.projectId
      : typeof input.project_id === 'string'
        ? input.project_id
        : undefined;
  if (!project) return null;
  return {
    project,
    projectId,
    source: 'tool',
  };
}

export function collectProjectReferencesFromPreviewTabs(
  tabs: readonly PreviewTab[],
): ProjectReference[] {
  return tabs.flatMap((tab) => {
    const target = tab.target;
    const project = target.kind === 'file' && target.source === 'project'
      ? target.project?.trim()
      : '';
    return project ? [{ project, source: 'preview' as const }] : [];
  });
}

export function collectProjectReferencesFromMessages(
  messages: readonly Message[],
): ProjectReference[] {
  const references: ProjectReference[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const reference = getProjectReferenceFromToolInput(block);
      if (reference) references.push(reference);
    }
  }
  return references;
}

export function formatCopyFilePath<
  T extends { kind?: string; id?: string; name?: string },
>(
  target: CopyFilePathTarget,
  options: FormatCopyFilePathOptions<T> = {},
): string {
  const path = target.path.trim();
  if (!path) return '';

  const projectName = target.project?.trim();
  if (target.source !== 'project' || !projectName) return path;

  const mentionSlugMap = options.mentionSlugMap;
  if (mentionSlugMap) {
    const projectSlug = resolveProjectMentionSlug(
      projectName,
      mentionSlugMap,
      { projectId: target.projectId },
    );
    if (projectSlug) return `@${projectSlug} - ${path}`;
    return path;
  }

  if (options.fallbackProjectMention) {
    const fallbackSlug = slug(projectName);
    if (fallbackSlug) return `@${fallbackSlug} - ${path}`;
  }

  return path;
}

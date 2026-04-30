import { getIntegrationDefinition } from './integration-registry';

/**
 * Shared utilities for connection (@-mention) parsing, slugging, and expansion.
 *
 * This module is intentionally framework-agnostic so it can be imported from
 * the React app (mention menu, message bubble) and from worker / sandbox code
 * (server-side mention expansion).
 */

export interface MentionableIntegration {
  id: string;
  integration_type: string;
  name: string;
  /** Insertion order tiebreaker for slug collisions; lower = earlier. */
  created_at?: number;
}

export interface MentionMatch {
  /** The slug as it appeared in the text, without the leading "@". */
  slug: string;
  /** Resolved integration, or null when no integration matched the slug. */
  integration: MentionableIntegration | null;
  /** Index of the leading "@" in the source string. */
  index: number;
  /** Length of the matched substring including the "@". */
  length: number;
}

const SLUG_CHARSET = /[a-z0-9_]/;
const MENTION_ANNOTATION_REGEX = /\s*⟦ref:[^⟧]*⟧/g;

/**
 * Convert a connection name to its slug form. Stable on both client and server
 * so the slug a user inserts in the textarea is the same one the server can
 * resolve back to an integration.
 *
 *   slug("My Prod DB")     → "my_prod_db"
 *   slug("Stripe (Live)")  → "stripe_live"
 *   slug("123 Main")       → "123_main"
 */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Rank connections for the live @-mention menu. Empty queries are alphabetic;
 * typed queries prefer name prefixes, then integration/display-name prefixes,
 * then substring matches across all three fields.
 */
export function rankMentionableConnections<T extends MentionableIntegration>(
  connections: ReadonlyArray<T>,
  query: string,
): T[] {
  const q = query.toLowerCase();
  if (!q) {
    return [...connections].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  const tiers: [T[], T[], T[]] = [[], [], []];

  for (const connection of connections) {
    const name = connection.name.toLowerCase();
    const type = connection.integration_type.toLowerCase();
    const displayName = getIntegrationDefinition(connection.integration_type)
      ?.displayName.toLowerCase() ?? '';

    if (name.startsWith(q)) {
      tiers[0].push(connection);
    } else if (type.startsWith(q) || displayName.startsWith(q)) {
      tiers[1].push(connection);
    } else if (
      name.includes(q) ||
      type.includes(q) ||
      displayName.includes(q)
    ) {
      tiers[2].push(connection);
    }
  }

  for (const tier of tiers) {
    tier.sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    );
  }

  return [...tiers[0], ...tiers[1], ...tiers[2]];
}

/**
 * Produce a slug → integration map for the given list. Collisions get
 * deterministic `-2`, `-3`, … suffixes, ordered by `created_at` ascending
 * (and stable for unsorted input via the secondary index ordering).
 */
export function buildSlugMap(
  integrations: ReadonlyArray<MentionableIntegration>,
): Map<string, MentionableIntegration> {
  const ordered = [...integrations].sort((a, b) => {
    const aCreated = a.created_at ?? 0;
    const bCreated = b.created_at ?? 0;
    if (aCreated !== bCreated) return aCreated - bCreated;
    return a.id.localeCompare(b.id);
  });

  const result = new Map<string, MentionableIntegration>();
  const baseCounts = new Map<string, number>();

  for (const integration of ordered) {
    const base = slug(integration.name);
    if (!base) continue;

    const count = (baseCounts.get(base) ?? 0) + 1;
    baseCounts.set(base, count);
    const finalSlug = count === 1 ? base : `${base}-${count}`;
    result.set(finalSlug, integration);
  }

  return result;
}

/**
 * Get the slug an integration will be assigned in the given list. Useful for
 * components that want to render a chip without rebuilding the whole map by
 * hand. Returns null when the integration's name slugs to an empty string.
 */
export function slugForIntegration(
  integration: MentionableIntegration,
  slugMap: Map<string, MentionableIntegration>,
): string | null {
  for (const [s, found] of slugMap) {
    if (found.id === integration.id) return s;
  }
  return null;
}

function isWordBoundaryChar(ch: string | undefined): boolean {
  return ch === undefined || /\s/.test(ch);
}

function isSlugChar(ch: string): boolean {
  return SLUG_CHARSET.test(ch) || ch === '-';
}

function mentionSlugBefore(body: string, index: number): string | null {
  let end = index;
  while (end > 0 && /\s/.test(body[end - 1] ?? '')) {
    end--;
  }

  let start = end;
  while (start > 0 && isSlugChar(body[start - 1] ?? '')) {
    start--;
  }

  if (start === end || body[start - 1] !== '@') {
    return null;
  }

  if (!isWordBoundaryChar(body[start - 2])) {
    return null;
  }

  return body.slice(start, end).toLowerCase();
}

export interface AnnotatedMentionRef {
  slug: string;
  id: string | null;
}

export interface MentionAnnotationDisplay {
  displayText: string;
  annotatedMentions: AnnotatedMentionRef[];
}

function annotationConnectionId(annotation: string): string | null {
  const idMatch = annotation.match(/\sid=([^⟧\s]+)/);
  return idMatch?.[1] ?? null;
}

export function stripMentionAnnotationsWithMetadata(
  body: string,
): MentionAnnotationDisplay {
  const annotatedMentions: AnnotatedMentionRef[] = [];
  let displayText = '';
  let cursor = 0;

  for (const match of body.matchAll(MENTION_ANNOTATION_REGEX)) {
    const annotation = match[0];
    const index = match.index ?? 0;
    const slug = mentionSlugBefore(body, index);
    if (slug) {
      annotatedMentions.push({
        slug,
        id: annotationConnectionId(annotation),
      });
    }

    displayText += body.slice(cursor, index);
    cursor = index + annotation.length;
  }

  displayText += body.slice(cursor);
  return { displayText, annotatedMentions };
}

export function stripMentionAnnotations(body: string): string {
  return stripMentionAnnotationsWithMetadata(body).displayText;
}

/**
 * Walk every `@<slug>` token in `body` whose `@` is preceded by whitespace or
 * the start of the string. Returns one entry per match — including those whose
 * slug isn't in `slugMap` (so callers can decide whether to render them as
 * plain text). Mid-word `@` (e.g. inside an email address) is ignored.
 */
export function parseMentions(
  body: string,
  slugMap: Map<string, MentionableIntegration>,
): MentionMatch[] {
  const matches: MentionMatch[] = [];

  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '@') continue;
    if (!isWordBoundaryChar(body[i - 1])) continue;

    let end = i + 1;
    while (end < body.length && isSlugChar(body[end])) {
      end++;
    }

    if (end === i + 1) continue;

    const candidate = body.slice(i + 1, end).toLowerCase();
    matches.push({
      slug: candidate,
      integration: slugMap.get(candidate) ?? null,
      index: i,
      length: end - i,
    });
  }

  return matches;
}

/**
 * Annotate every known `@<slug>` mention in `body` with a stable
 * `⟦ref: <type> "<name>" id=<id>⟧` marker. Unknown slugs are left untouched so
 * stale references in old transcripts don't crash. Mentions are processed
 * right-to-left so earlier indices remain valid after each splice.
 */
export function expandMentions(
  body: string,
  slugMap: Map<string, MentionableIntegration>,
): string {
  if (!body || slugMap.size === 0) return body;

  const matches = parseMentions(body, slugMap);
  if (matches.length === 0) return body;

  let result = body;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    if (!match.integration) continue;
    const annotation = ` ⟦ref: ${match.integration.integration_type} "${match.integration.name}" id=${match.integration.id}⟧`;
    const insertAt = match.index + match.length;
    result = result.slice(0, insertAt) + annotation + result.slice(insertAt);
  }

  return result;
}

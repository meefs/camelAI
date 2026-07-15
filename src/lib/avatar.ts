import type { Avatar } from '@/types';
import emojiRegex from 'emoji-regex';
import {
  DEFAULT_CHAT_GROUP_ICON,
  normalizeChatGroupIconName,
} from '@/lib/chat-group-icons';

export const AVATAR_COLORS = [
  '#5C63A6', // indigo
  '#8E7CC0', // lavender
  '#B0617F', // rose
  '#BE924F', // amber
  '#4F9B81', // green
  '#5A82AD', // blue
  '#B86A5F', // clay
  '#8B5B86', // plum
];

export const DEFAULT_CHAT_GROUP_EMOJI = '💬';
const HEX_COLOR_REGEX = /^#[0-9A-F]{6}$/i;

function getGraphemeClusters(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
  if (!segmenter) {
    return Array.from(trimmed);
  }
  return Array.from(segmenter.segment(trimmed), segment => segment.segment);
}

export function isEmoji(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  const matches = Array.from(trimmed.matchAll(emojiRegex()), (match) => match[0]);
  return matches.length === 1 && matches[0] === trimmed;
}

export function validateAvatarContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  const clusters = getGraphemeClusters(trimmed);
  if (clusters.length === 1) return isEmoji(trimmed);
  if (clusters.length !== 2) return false;
  return !clusters.some((cluster) => isEmoji(cluster));
}

export function normalizeAvatarColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_REGEX.test(trimmed)) return null;
  return trimmed.toUpperCase();
}

export function normalizeChatGroupAvatar(input: unknown): Avatar | null {
  if (!input || typeof input !== 'object') return null;
  const keys = Object.keys(input as Record<string, unknown>);
  if (keys.some((key) => key !== 'color' && key !== 'content')) return null;
  const candidate = input as { color?: unknown; content?: unknown };
  // Chat group avatars now store a Lucide icon name in `content`. `color` is
  // vestigial (ignored when rendering) but kept on the shape; default it rather
  // than reject so callers that omit it still validate.
  const content = normalizeChatGroupIconName(candidate.content);
  if (!content) return null;
  const color = normalizeAvatarColor(candidate.color) ?? AVATAR_COLORS[0];
  return { color, content };
}

export function generateDefaultChatGroupAvatar(options: {
  groupIndex?: number;
  content?: string | null;
} = {}): Avatar {
  const groupIndex = Number.isFinite(options.groupIndex)
    ? Math.max(0, Math.floor(options.groupIndex ?? 0))
    : 0;
  return {
    // Color is retained for storage compatibility only; the renderer ignores it.
    color: AVATAR_COLORS[groupIndex % AVATAR_COLORS.length],
    content: normalizeChatGroupIconName(options.content) ?? DEFAULT_CHAT_GROUP_ICON,
  };
}

export function generateDefaultAvatar(source: string): Avatar {
  const fallback = source?.trim() || 'user';
  const initials = Array.from(fallback).slice(0, 2).join('').toUpperCase() || '??';
  let hash = 0;
  for (const char of fallback) {
    const codePoint = char.codePointAt(0) ?? 0;
    hash = (hash + codePoint) % AVATAR_COLORS.length;
  }
  return {
    color: AVATAR_COLORS[hash % AVATAR_COLORS.length],
    content: initials,
  };
}

export function getContrastTextColor(hexColor: string): string {
  if (!hexColor || !hexColor.startsWith('#') || hexColor.length < 7) {
    return '#FFFFFF';
  }
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return '#FFFFFF';
  }
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? '#000000' : '#FFFFFF';
}

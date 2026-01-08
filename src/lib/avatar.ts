import type { Avatar } from '@/types';

export const AVATAR_COLORS = [
  '#4F46E5',
  '#7C3AED',
  '#EC4899',
  '#F59E0B',
  '#10B981',
  '#3B82F6',
  '#EF4444',
  '#8B5CF6',
];

const EMOJI_REGEX = /^(?:\p{Extended_Pictographic}|\p{Emoji_Presentation}|\p{Emoji}\uFE0F)$/u;
const FLAG_REGEX = /^[\p{Regional_Indicator}]{2}$/u;

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
  const clusters = getGraphemeClusters(value);
  if (clusters.length !== 1) return false;
  const cluster = clusters[0];
  return EMOJI_REGEX.test(cluster) || FLAG_REGEX.test(cluster);
}

export function validateAvatarContent(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed) return false;
  const clusters = getGraphemeClusters(trimmed);
  if (clusters.length === 1) return isEmoji(trimmed);
  if (clusters.length !== 2) return false;
  return !clusters.some((cluster) => isEmoji(cluster));
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

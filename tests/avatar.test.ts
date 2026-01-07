import { describe, it, expect } from 'vitest';
import { generateDefaultAvatar, isEmoji, validateAvatarContent } from '@/lib/avatar';

describe('avatar utilities', () => {
  it('detects emoji content', () => {
    expect(isEmoji('😀')).toBe(true);
    expect(isEmoji('🇺🇸')).toBe(true);
    expect(isEmoji('AA')).toBe(false);
    expect(isEmoji('😀😀')).toBe(false);
  });

  it('validates avatar content', () => {
    expect(validateAvatarContent('JD')).toBe(true);
    expect(validateAvatarContent('😀')).toBe(true);
    expect(validateAvatarContent('ABC')).toBe(false);
    expect(validateAvatarContent('')).toBe(false);
  });

  it('generates consistent defaults', () => {
    const avatar = generateDefaultAvatar('Jane Doe');
    expect(avatar.content.length).toBe(2);
    expect(avatar.content).toBe('JA');
    expect(avatar.color).toMatch(/^#/);
  });

  it('generates consistent color for same input', () => {
    const first = generateDefaultAvatar('Jane Doe');
    const second = generateDefaultAvatar('Jane Doe');
    expect(second.color).toBe(first.color);
    expect(second.content).toBe(first.content);
  });

  it('handles empty string input', () => {
    const avatar = generateDefaultAvatar('');
    expect(avatar.content).toBe('US');
    expect(avatar.color).toMatch(/^#/);
  });

  it('handles Unicode names correctly', () => {
    const avatar = generateDefaultAvatar('Åke');
    expect(avatar.content.length).toBe(2);
    expect(avatar.color).toMatch(/^#/);
  });

  it('detects flag emoji as single emoji', () => {
    expect(isEmoji('🇺🇸')).toBe(true);
  });

  it('rejects multi-emoji strings', () => {
    expect(validateAvatarContent('😀😀')).toBe(false);
  });
});

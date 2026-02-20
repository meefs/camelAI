import type { BundledLanguage, BundledTheme } from 'shiki';

// Common languages to preload for syntax highlighting
export const PRELOAD_LANGUAGES: BundledLanguage[] = [
  'javascript',
  'typescript',
  'jsx',
  'tsx',
  'python',
  'bash',
  'shell',
  'json',
  'html',
  'css',
  'markdown',
  'sql',
  'yaml',
  'toml',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
];

// Theme configuration - uses built-in themes that work well with light/dark modes
export const SHIKI_LIGHT_THEME: BundledTheme = 'github-light';
export const SHIKI_DARK_THEME: BundledTheme = 'github-dark';

// Default theme to use (we'll detect dark mode in the component)
export const SHIKI_DEFAULT_THEMES = {
  light: SHIKI_LIGHT_THEME,
  dark: SHIKI_DARK_THEME,
};

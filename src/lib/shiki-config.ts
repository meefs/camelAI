import { createHighlighterCoreSync } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';

// Individual language imports — only what we actually use
import langJavascript from 'shiki/langs/javascript.mjs';
import langTypescript from 'shiki/langs/typescript.mjs';
import langJsx from 'shiki/langs/jsx.mjs';
import langTsx from 'shiki/langs/tsx.mjs';
import langPython from 'shiki/langs/python.mjs';
import langBash from 'shiki/langs/bash.mjs';
import langShell from 'shiki/langs/shellscript.mjs';
import langJson from 'shiki/langs/json.mjs';
import langHtml from 'shiki/langs/html.mjs';
import langCss from 'shiki/langs/css.mjs';
import langMarkdown from 'shiki/langs/markdown.mjs';
import langSql from 'shiki/langs/sql.mjs';
import langYaml from 'shiki/langs/yaml.mjs';
import langToml from 'shiki/langs/toml.mjs';
import langRust from 'shiki/langs/rust.mjs';
import langGo from 'shiki/langs/go.mjs';
import langJava from 'shiki/langs/java.mjs';
import langC from 'shiki/langs/c.mjs';
import langCpp from 'shiki/langs/cpp.mjs';

// Only the two themes we use
import themeGithubLight from 'shiki/themes/github-light.mjs';
import themeGithubDark from 'shiki/themes/github-dark.mjs';

const LANGS = [
  langJavascript,
  langTypescript,
  langJsx,
  langTsx,
  langPython,
  langBash,
  langShell,
  langJson,
  langHtml,
  langCss,
  langMarkdown,
  langSql,
  langYaml,
  langToml,
  langRust,
  langGo,
  langJava,
  langC,
  langCpp,
];

const THEMES = [themeGithubLight, themeGithubDark];

// Language names that our highlighter supports (used for runtime checks)
export const SUPPORTED_LANGUAGES = new Set([
  'javascript', 'typescript', 'jsx', 'tsx', 'python',
  'bash', 'shell', 'shellscript', 'json', 'html', 'css',
  'markdown', 'sql', 'yaml', 'toml', 'rust', 'go',
  'java', 'c', 'cpp',
]);

export const SHIKI_DEFAULT_THEMES = {
  light: 'github-light' as const,
  dark: 'github-dark' as const,
};

// Singleton highlighter — created once with only our languages/themes
let _highlighter: ReturnType<typeof createHighlighterCoreSync> | null = null;

function getHighlighter() {
  if (!_highlighter) {
    _highlighter = createHighlighterCoreSync({
      themes: THEMES,
      langs: LANGS,
      engine: createJavaScriptRegexEngine(),
    });
  }
  return _highlighter;
}

/**
 * Highlight code to HTML using only our bundled languages/themes.
 * Drop-in replacement for `codeToHtml` from 'shiki'.
 */
export function codeToHtml(
  code: string,
  options: {
    lang: string;
    themes: typeof SHIKI_DEFAULT_THEMES;
    defaultColor: false;
  },
): string {
  const highlighter = getHighlighter();
  return highlighter.codeToHtml(code, {
    lang: options.lang,
    themes: options.themes,
    defaultColor: options.defaultColor,
  });
}

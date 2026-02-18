import type { ReactNode } from 'react';

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break',
  'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for',
  'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case',
]);

const PYTHON_BUILTINS = new Set([
  'abs', 'all', 'any', 'bool', 'dict', 'enumerate', 'filter', 'float', 'int',
  'len', 'list', 'map', 'max', 'min', 'print', 'range', 'reversed', 'set', 'sorted',
  'str', 'sum', 'tuple', 'type', 'zip',
]);

interface Token {
  text: string;
  className: string;
}

function splitComment(line: string): { code: string; comment: string | null } {
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if ((inSingle || inDouble) && char === '\\') {
      escaped = true;
      continue;
    }

    if (!inDouble && char === '\'') {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && char === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && char === '#') {
      return {
        code: line.slice(0, i),
        comment: line.slice(i),
      };
    }
  }

  return { code: line, comment: null };
}

function tokenizeCode(code: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /(@[A-Za-z_][A-Za-z0-9_]*|\b\d+(?:\.\d+)?\b|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\b[A-Za-z_][A-Za-z0-9_]*\b|\s+|.)/g;

  const matches = code.match(pattern);
  if (!matches) return tokens;

  for (const token of matches) {
    if (/^\s+$/.test(token)) {
      tokens.push({ text: token, className: '' });
      continue;
    }

    if (token.startsWith('"') || token.startsWith('\'')) {
      tokens.push({ text: token, className: 'text-emerald-300' });
      continue;
    }

    if (/^@[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
      tokens.push({ text: token, className: 'text-fuchsia-300' });
      continue;
    }

    if (/^\d+(\.\d+)?$/.test(token)) {
      tokens.push({ text: token, className: 'text-amber-300' });
      continue;
    }

    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) {
      if (PYTHON_KEYWORDS.has(token)) {
        tokens.push({ text: token, className: 'text-sky-300' });
        continue;
      }
      if (PYTHON_BUILTINS.has(token)) {
        tokens.push({ text: token, className: 'text-cyan-300' });
        continue;
      }
    }

    tokens.push({ text: token, className: '' });
  }

  return tokens;
}

function renderLine(line: string): ReactNode {
  const { code, comment } = splitComment(line);
  const tokens = tokenizeCode(code);
  if (comment) {
    tokens.push({ text: comment, className: 'text-zinc-500 italic' });
  }

  if (tokens.length === 0) {
    return '\u00A0';
  }

  return tokens.map((token, index) => (
    <span key={`${token.text}-${index}`} className={token.className}>
      {token.text}
    </span>
  ));
}

interface PythonSyntaxHighlighterProps {
  code: string;
}

export function PythonSyntaxHighlighter({ code }: PythonSyntaxHighlighterProps) {
  const lines = code.split('\n');

  return (
    <pre className="font-mono text-[13px] leading-relaxed text-zinc-100">
      {lines.map((line, lineIndex) => (
        <div key={`line-${lineIndex}`} className="flex min-w-max">
          <span className="inline-block w-8 shrink-0 select-none pr-4 text-right text-xs text-zinc-500">
            {lineIndex + 1}
          </span>
          <code className="min-w-0 flex-1 whitespace-pre-wrap break-words">
            {renderLine(line)}
          </code>
        </div>
      ))}
    </pre>
  );
}

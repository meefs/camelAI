import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

type MarkdownNode = {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  url?: string;
  ordered?: boolean;
  start?: number;
  lang?: string;
  checked?: boolean | null;
};

export interface TelegramFormattedText {
  text: string;
  parseMode: 'HTML';
}

const markdownParser = unified().use(remarkParse).use(remarkGfm);

function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeTelegramHtmlAttribute(value: string): string {
  return escapeTelegramHtml(value).replace(/"/g, '&quot;');
}

function safeTelegramLink(url: string | undefined): string | null {
  const trimmed = url?.trim();
  if (!trimmed) return null;
  if (/^(https?:\/\/|tg:\/\/)/i.test(trimmed)) return trimmed;
  return null;
}

function renderInlineNodes(nodes: MarkdownNode[] | undefined): string {
  return (nodes || []).map((node) => renderTelegramMarkdownNode(node, 'inline')).join('');
}

function renderBlockChildren(nodes: MarkdownNode[] | undefined): string {
  return (nodes || [])
    .map((node) => renderTelegramMarkdownNode(node, 'block'))
    .filter((part) => part.trim().length > 0)
    .join('\n\n');
}

function renderListItem(node: MarkdownNode, marker: string): string {
  const children = node.children || [];
  const rendered = children
    .map((child) => {
      if (child.type === 'paragraph') return renderInlineNodes(child.children);
      return renderTelegramMarkdownNode(child, 'block');
    })
    .filter((part) => part.trim().length > 0)
    .join('\n');
  const checkbox = typeof node.checked === 'boolean'
    ? `${node.checked ? '[x]' : '[ ]'} `
    : '';
  return `${marker} ${checkbox}${rendered}`.trimEnd();
}

function renderTelegramMarkdownNode(node: MarkdownNode, context: 'block' | 'inline'): string {
  switch (node.type) {
    case 'root':
      return renderBlockChildren(node.children);
    case 'paragraph':
      return renderInlineNodes(node.children);
    case 'text':
      return escapeTelegramHtml(node.value || '');
    case 'strong':
      return `<b>${renderInlineNodes(node.children)}</b>`;
    case 'emphasis':
      return `<i>${renderInlineNodes(node.children)}</i>`;
    case 'delete':
      return `<s>${renderInlineNodes(node.children)}</s>`;
    case 'inlineCode':
      return `<code>${escapeTelegramHtml(node.value || '')}</code>`;
    case 'code': {
      const code = escapeTelegramHtml(node.value || '');
      const lang = node.lang?.trim();
      const className = lang ? ` class="language-${escapeTelegramHtmlAttribute(lang)}"` : '';
      return `<pre><code${className}>${code}</code></pre>`;
    }
    case 'break':
      return '\n';
    case 'thematicBreak':
      return '---';
    case 'heading':
      return `<b>${renderInlineNodes(node.children)}</b>`;
    case 'blockquote': {
      const body = renderBlockChildren(node.children);
      return body ? `<blockquote>${body}</blockquote>` : '';
    }
    case 'link': {
      const href = safeTelegramLink(node.url);
      const label = renderInlineNodes(node.children) || escapeTelegramHtml(node.url || '');
      return href ? `<a href="${escapeTelegramHtmlAttribute(href)}">${label}</a>` : label;
    }
    case 'image':
      return escapeTelegramHtml(node.value || node.url || '');
    case 'list': {
      let index = node.start || 1;
      return (node.children || [])
        .map((child) => {
          const marker = node.ordered ? `${index++}.` : '-';
          return renderListItem(child, marker);
        })
        .join('\n');
    }
    case 'listItem':
      return renderListItem(node, context === 'inline' ? '-' : '-');
    case 'html':
      return escapeTelegramHtml(node.value || '');
    default:
      if (node.children) {
        return context === 'inline'
          ? renderInlineNodes(node.children)
          : renderBlockChildren(node.children);
      }
      return escapeTelegramHtml(node.value || '');
  }
}

export function formatMarkdownForTelegram(markdown: string): TelegramFormattedText {
  const tree = markdownParser.parse(markdown) as MarkdownNode;
  return {
    text: renderTelegramMarkdownNode(tree, 'block') || escapeTelegramHtml(markdown),
    parseMode: 'HTML',
  };
}

import type { ReactNode } from 'react';
import { Image, Link, StyleSheet, Text, View } from '@react-pdf/renderer';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import type { PdfImageAsset } from './chart-runtime';
import { PdfTable } from './pdf-table';
import type { ParsedTable } from './types';

interface MdastNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number;
  url?: string;
  alt?: string;
  lang?: string;
  children?: MdastNode[];
}

const markdownProcessor = unified().use(remarkParse).use(remarkGfm);
const IMAGE_FAILURE_COPY = 'Image could not be rendered for PDF export.';

export interface PdfMarkdownImageAssets {
  [src: string]: PdfImageAsset | null;
}

interface RenderMarkdownToPdfOptions {
  imageAssets?: PdfMarkdownImageAssets;
}

const styles = StyleSheet.create({
  paragraph: {
    fontFamily: 'Figtree',
    fontSize: 11,
    lineHeight: 1.55,
    color: '#1f2937',
    marginBottom: 10,
  },
  heading1: {
    fontFamily: 'Source Serif 4',
    fontSize: 20,
    lineHeight: 1.2,
    color: '#111827',
    marginBottom: 10,
  },
  heading2: {
    fontFamily: 'Source Serif 4',
    fontSize: 16,
    lineHeight: 1.25,
    color: '#111827',
    marginTop: 24,
    marginBottom: 8,
  },
  heading3: {
    fontFamily: 'Source Serif 4',
    fontSize: 13,
    lineHeight: 1.3,
    color: '#111827',
    marginTop: 16,
    marginBottom: 6,
  },
  strong: {
    fontFamily: 'Figtree',
    fontWeight: 700,
  },
  emphasis: {
    fontStyle: 'italic',
  },
  deleted: {
    textDecoration: 'line-through',
  },
  inlineCode: {
    fontFamily: 'Geist Mono',
    fontSize: 10,
    backgroundColor: '#eef2f7',
    color: '#0f172a',
  },
  link: {
    color: '#0f62fe',
    textDecoration: 'underline',
  },
  blockquote: {
    borderLeftWidth: 3,
    borderLeftColor: '#cbd5e1',
    paddingLeft: 10,
    marginBottom: 10,
    gap: 4,
  },
  list: {
    gap: 6,
    marginBottom: 10,
  },
  nestedList: {
    marginTop: 6,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
  },
  listMarker: {
    width: 18,
    fontFamily: 'Figtree',
    fontWeight: 700,
    fontSize: 10,
    color: '#475569',
  },
  listBody: {
    flex: 1,
    gap: 4,
  },
  listParagraph: {
    fontFamily: 'Figtree',
    fontSize: 11,
    lineHeight: 1.5,
    color: '#1f2937',
  },
  codeBlock: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#d7dde7',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  codeBlockText: {
    fontFamily: 'Geist Mono',
    fontSize: 9,
    lineHeight: 1.45,
    color: '#0f172a',
  },
  rule: {
    height: 1,
    backgroundColor: '#c0c8d4',
    marginBottom: 12,
  },
  htmlFallback: {
    borderWidth: 1,
    borderColor: '#d7dde7',
    borderRadius: 6,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 10,
  },
  htmlFallbackText: {
    fontFamily: 'Figtree',
    fontSize: 9,
    color: '#64748b',
  },
  imageBlock: {
    alignItems: 'center',
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#d7dde7',
    borderRadius: 8,
    padding: 8,
    gap: 6,
    marginBottom: 10,
  },
  image: {
    maxWidth: 488,
    maxHeight: 320,
    objectFit: 'contain',
  },
  imageCaption: {
    fontFamily: 'Figtree',
    fontSize: 9,
    color: '#64748b',
  },
});

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function extractText(node: MdastNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
    return asText(node.value);
  }
  return (node.children ?? []).map(extractText).join('');
}

function nodeChildren(node: MdastNode): MdastNode[] {
  return Array.isArray(node.children) ? node.children : [];
}

function canRenderPdfImage(url: unknown): url is string {
  return typeof url === 'string' && /^(data:|https?:\/\/)/i.test(url);
}

function visitMarkdownNodes(node: MdastNode, visit: (current: MdastNode) => void): void {
  visit(node);
  for (const child of nodeChildren(node)) {
    visitMarkdownNodes(child, visit);
  }
}

export function extractMarkdownImageUrls(markdown: string): string[] {
  const tree = markdownProcessor.parse(markdown) as MdastNode;
  const urls = new Set<string>();

  visitMarkdownNodes(tree, (node) => {
    if (node.type === 'image' && canRenderPdfImage(node.url)) {
      urls.add(node.url);
    }
  });

  return Array.from(urls);
}

function markdownTableToParsedTable(node: MdastNode): ParsedTable {
  const rows = nodeChildren(node);
  const headerCells = rows[0] ? nodeChildren(rows[0]).map(extractText) : [];
  const bodyRows = rows.slice(1).map((row) => nodeChildren(row).map(extractText));

  return {
    headers: headerCells,
    rows: bodyRows,
    indexColumns: 0,
    caption: null,
    sourceRowCount: null,
  };
}

function renderInlineNodes(nodes: MdastNode[], keyPrefix: string): ReactNode[] {
  return nodes.flatMap((node, index) => {
    const key = `${keyPrefix}-${index}`;

    switch (node.type) {
      case 'text':
        return asText(node.value);
      case 'strong':
        return (
          <Text key={key} style={styles.strong}>
            {renderInlineNodes(nodeChildren(node), key)}
          </Text>
        );
      case 'emphasis':
        return (
          <Text key={key} style={styles.emphasis}>
            {renderInlineNodes(nodeChildren(node), key)}
          </Text>
        );
      case 'delete':
        return (
          <Text key={key} style={styles.deleted}>
            {renderInlineNodes(nodeChildren(node), key)}
          </Text>
        );
      case 'inlineCode':
        return (
          <Text key={key} style={styles.inlineCode}>
            {asText(node.value)}
          </Text>
        );
      case 'link':
        return (
          <Link key={key} src={node.url} style={styles.link}>
            {renderInlineNodes(nodeChildren(node), key)}
          </Link>
        );
      case 'break':
        return '\n';
      case 'image':
        return `[Image: ${node.alt ?? 'untitled'}]`;
      default:
        return extractText(node);
    }
  });
}

function renderMarkdownImageFallback(alt: string, key: string): ReactNode {
  return (
    <View key={key} style={styles.htmlFallback}>
      <Text style={styles.htmlFallbackText}>{IMAGE_FAILURE_COPY}</Text>
      {alt ? <Text style={styles.imageCaption}>{alt}</Text> : null}
    </View>
  );
}

function renderMarkdownImage(
  node: MdastNode,
  key: string,
  imageAssets?: PdfMarkdownImageAssets
): ReactNode {
  const alt = node.alt?.trim() || 'untitled';
  if (!canRenderPdfImage(node.url)) {
    return (
      <Text key={key} style={styles.paragraph}>
        {`[Image: ${alt}]`}
      </Text>
    );
  }

  if (imageAssets) {
    const asset = imageAssets[node.url];
    if (!asset) {
      return renderMarkdownImageFallback(alt, key);
    }

    return (
      <View key={key} style={styles.imageBlock} wrap={false}>
        <Image src={asset.src} cache={false} style={styles.image} />
        {node.alt ? <Text style={styles.imageCaption}>{node.alt}</Text> : null}
      </View>
    );
  }

  return (
    <View key={key} style={styles.imageBlock} wrap={false}>
      <Image src={node.url} cache={false} style={styles.image} />
      {node.alt ? <Text style={styles.imageCaption}>{node.alt}</Text> : null}
    </View>
  );
}

function renderList(
  node: MdastNode,
  key: string,
  depth: number,
  imageAssets?: PdfMarkdownImageAssets
): ReactNode {
  const ordered = Boolean(node.ordered);
  const start = node.start ?? 1;
  const listStyles = depth > 0 ? [styles.list, styles.nestedList] : [styles.list];

  return (
    <View key={key} style={listStyles}>
      {nodeChildren(node).map((item, index) => {
        const marker = ordered ? `${start + index}.` : '\u2022';
        return (
          <View key={`${key}-item-${index}`} style={styles.listItem}>
            <Text style={styles.listMarker}>{marker}</Text>
            <View style={styles.listBody}>
              {nodeChildren(item).map((child, childIndex) => {
                if (child.type === 'paragraph') {
                  return (
                    <Text key={`${key}-paragraph-${index}-${childIndex}`} style={styles.listParagraph}>
                      {renderInlineNodes(nodeChildren(child), `${key}-paragraph-${index}-${childIndex}`)}
                    </Text>
                  );
                }

                return renderBlockNode(
                  child,
                  `${key}-child-${index}-${childIndex}`,
                  depth + 1,
                  imageAssets
                );
              })}
            </View>
          </View>
        );
      })}
    </View>
  );
}

function renderBlockNode(
  node: MdastNode,
  key: string,
  depth = 0,
  imageAssets?: PdfMarkdownImageAssets
): ReactNode {
  switch (node.type) {
    case 'paragraph':
      if (nodeChildren(node).length === 1 && nodeChildren(node)[0]?.type === 'image') {
        return renderMarkdownImage(nodeChildren(node)[0] as MdastNode, key, imageAssets);
      }
      return (
        <Text key={key} style={styles.paragraph}>
          {renderInlineNodes(nodeChildren(node), key)}
        </Text>
      );
    case 'heading': {
      const headingStyle = node.depth === 1
        ? styles.heading1
        : node.depth === 2
          ? styles.heading2
          : styles.heading3;

      return (
        <Text key={key} style={headingStyle}>
          {renderInlineNodes(nodeChildren(node), key)}
        </Text>
      );
    }
    case 'blockquote':
      return (
        <View key={key} style={styles.blockquote}>
          {nodeChildren(node).map((child, index) => renderBlockNode(child, `${key}-${index}`, depth, imageAssets))}
        </View>
      );
    case 'list':
      return renderList(node, key, depth, imageAssets);
    case 'code':
      return (
        <View key={key} style={styles.codeBlock}>
          <Text style={styles.codeBlockText}>{asText(node.value)}</Text>
        </View>
      );
    case 'image':
      return renderMarkdownImage(node, key, imageAssets);
    case 'table':
      return <PdfTable key={key} table={markdownTableToParsedTable(node)} />;
    case 'thematicBreak':
      return <View key={key} style={styles.rule} />;
    case 'html':
      return (
        <View key={key} style={styles.htmlFallback}>
          <Text style={styles.htmlFallbackText}>
            Inline HTML content is not included in PDF export.
          </Text>
        </View>
      );
    default:
      if (nodeChildren(node).length > 0) {
        return (
          <View key={key}>
            {nodeChildren(node).map((child, index) => renderBlockNode(child, `${key}-${index}`, depth, imageAssets))}
          </View>
        );
      }
      return null;
  }
}

export function renderMarkdownToPdfNodes(
  markdown: string,
  options: RenderMarkdownToPdfOptions = {}
): ReactNode[] {
  const tree = markdownProcessor.parse(markdown) as MdastNode;
  return nodeChildren(tree)
    .map((node, index) => renderBlockNode(node, `markdown-${index}`, 0, options.imageAssets))
    .filter(Boolean);
}

export function PdfMarkdown({ markdown, imageAssets }: { markdown: string; imageAssets?: PdfMarkdownImageAssets }) {
  return <View>{renderMarkdownToPdfNodes(markdown, { imageAssets })}</View>;
}

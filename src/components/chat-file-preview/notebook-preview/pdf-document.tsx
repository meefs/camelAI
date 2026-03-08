import { Document, Image, Page, StyleSheet, Text, View } from '@react-pdf/renderer';
import { PdfMarkdown, type PdfMarkdownImageAssets } from './pdf-markdown';
import { PdfTable } from './pdf-table';
import type { NotebookReportExportModel } from './report-export-model';
import type { TableDisplayModel } from './table-display';
import type { ParsedTable } from './types';
import { formatNotebookDate } from './utils';
import type { PdfImageAsset } from './chart-runtime';

export type NotebookPdfRenderableBlock =
  | { id: string; kind: 'markdown'; markdown: string; imageAssets?: PdfMarkdownImageAssets }
  | { id: string; kind: 'figure'; title: string; asset: PdfImageAsset }
  | { id: string; kind: 'table'; table: ParsedTable; display: TableDisplayModel; title: string }
  | { id: string; kind: 'text'; text: string }
  | { id: string; kind: 'error'; text: string }
  | { id: string; kind: 'callout'; tone: 'muted' | 'error'; text: string; title?: string };

interface NotebookPdfDocumentProps {
  model: NotebookReportExportModel;
  blocks: NotebookPdfRenderableBlock[];
  pdfTitle: string;
}

const PAGE_HORIZONTAL_PADDING = 54;
const PAGE_TOP_PADDING = 54;
const PAGE_BOTTOM_PADDING = 72;
const LETTER_PAGE_WIDTH = 612;
const PAGE_CONTENT_WIDTH = LETTER_PAGE_WIDTH - PAGE_HORIZONTAL_PADDING * 2;
const FIGURE_FRAME_PADDING = 4;

const styles = StyleSheet.create({
  page: {
    paddingTop: PAGE_TOP_PADDING,
    paddingRight: PAGE_HORIZONTAL_PADDING,
    paddingBottom: PAGE_BOTTOM_PADDING,
    paddingLeft: PAGE_HORIZONTAL_PADDING,
    backgroundColor: '#ffffff',
    fontFamily: 'Figtree',
  },
  eyebrow: {
    fontFamily: 'Geist Mono',
    fontSize: 9,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    color: '#64748b',
    marginBottom: 12,
  },
  title: {
    fontFamily: 'Source Serif 4',
    fontSize: 28,
    lineHeight: 1.15,
    color: '#111827',
    marginBottom: 10,
  },
  subtitle: {
    fontFamily: 'Figtree',
    fontSize: 13,
    lineHeight: 1.5,
    color: '#475569',
    marginBottom: 12,
    maxWidth: 420,
  },
  metadata: {
    fontFamily: 'Geist Mono',
    fontSize: 9,
    color: '#64748b',
    marginBottom: 18,
  },
  separator: {
    height: 1,
    backgroundColor: '#c0c8d4',
    marginBottom: 18,
  },
  body: {
    gap: 24,
  },
  block: {
    marginBottom: 0,
  },
  figure: {
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#d7dde7',
    borderRadius: 10,
    backgroundColor: '#f8fafc',
    padding: FIGURE_FRAME_PADDING,
    gap: 8,
  },
  textBlock: {
    backgroundColor: '#f8fafc',
    borderWidth: 1,
    borderColor: '#d7dde7',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  textBlockText: {
    fontFamily: 'Geist Mono',
    fontSize: 9.5,
    lineHeight: 1.45,
    color: '#0f172a',
  },
  errorBlock: {
    backgroundColor: '#fff5f5',
    borderWidth: 1,
    borderColor: '#fecaca',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  errorBlockText: {
    fontFamily: 'Geist Mono',
    fontSize: 9.5,
    lineHeight: 1.45,
    color: '#b91c1c',
  },
  callout: {
    borderWidth: 1,
    borderColor: '#d7dde7',
    borderRadius: 8,
    backgroundColor: '#f8fafc',
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 4,
  },
  calloutError: {
    borderColor: '#fecaca',
    backgroundColor: '#fff5f5',
  },
  calloutTitle: {
    fontFamily: 'Figtree',
    fontWeight: 700,
    fontSize: 10,
    color: '#111827',
  },
  calloutText: {
    fontFamily: 'Figtree',
    fontSize: 9.5,
    lineHeight: 1.4,
    color: '#475569',
  },
  footer: {
    marginTop: 18,
    gap: 8,
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 12,
  },
  footerText: {
    fontFamily: 'Geist Mono',
    fontSize: 8,
    color: '#94a3b8',
  },
  pageNumber: {
    position: 'absolute',
    right: PAGE_HORIZONTAL_PADDING,
    bottom: 26,
    fontFamily: 'Geist Mono',
    fontSize: 8,
    color: '#64748b',
  },
});

function getFigureSize(asset: PdfImageAsset): { width: number; height: number } {
  const maxWidth = PAGE_CONTENT_WIDTH - FIGURE_FRAME_PADDING * 2;
  const maxHeight = 360;
  const scale = Math.min(1, maxWidth / asset.width, maxHeight / asset.height);

  return {
    width: Math.max(1, Math.round(asset.width * scale)),
    height: Math.max(1, Math.round(asset.height * scale)),
  };
}

function buildMetadata(model: NotebookReportExportModel): string {
  const metadataItems: string[] = [];
  if (model.header.executionTimestamp) {
    metadataItems.push(formatNotebookDate(model.header.executionTimestamp));
  }
  metadataItems.push(`${model.header.cellCount} ${model.header.cellCount === 1 ? 'cell' : 'cells'}`);
  if (model.header.visualizationCount > 0) {
    metadataItems.push(
      `${model.header.visualizationCount} ${model.header.visualizationCount === 1 ? 'visualization' : 'visualizations'}`
    );
  }
  return metadataItems.join('  ·  ');
}

function buildFooterRightText(model: NotebookReportExportModel): string {
  return [
    `${model.codeCellCount} code ${model.codeCellCount === 1 ? 'cell' : 'cells'}`,
    model.languageVersion ? `Python ${model.languageVersion}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');
}

function renderBlock(block: NotebookPdfRenderableBlock) {
  switch (block.kind) {
    case 'markdown':
      return <PdfMarkdown markdown={block.markdown} imageAssets={block.imageAssets} />;
    case 'figure': {
      const size = getFigureSize(block.asset);
      return (
        <View style={styles.figure} wrap={false}>
          <Image
            src={block.asset.src}
            cache={false}
            style={{ width: size.width, height: size.height }}
          />
        </View>
      );
    }
    case 'table':
      return <PdfTable table={block.table} display={block.display} />;
    case 'text':
      return (
        <View style={styles.textBlock}>
          <Text style={styles.textBlockText}>{block.text}</Text>
        </View>
      );
    case 'error':
      return (
        <View style={styles.errorBlock}>
          <Text style={styles.errorBlockText}>{block.text}</Text>
        </View>
      );
    case 'callout': {
      const calloutStyles = block.tone === 'error'
        ? [styles.callout, styles.calloutError]
        : [styles.callout];
      return (
        <View style={calloutStyles}>
          {block.title ? <Text style={styles.calloutTitle}>{block.title}</Text> : null}
          <Text style={styles.calloutText}>{block.text}</Text>
        </View>
      );
    }
  }
}

export function NotebookPdfDocument({
  model,
  blocks,
  pdfTitle,
}: NotebookPdfDocumentProps) {
  const footerRightText = buildFooterRightText(model);

  return (
    <Document
      title={pdfTitle}
      author="camelAI"
      creator="camelAI"
      subject="Notebook report export"
      language="en-US"
    >
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.eyebrow}>Python Notebook  ·  Analysis</Text>
        {model.header.title ? <Text style={styles.title}>{model.header.title}</Text> : null}
        {model.header.subtitle ? <Text style={styles.subtitle}>{model.header.subtitle}</Text> : null}
        <Text style={styles.metadata}>{buildMetadata(model)}</Text>
        <View style={styles.separator} />

        <View style={styles.body}>
          {blocks.map((block) => (
            <View key={block.id} style={styles.block}>
              {renderBlock(block)}
            </View>
          ))}
        </View>

        <View style={styles.footer} wrap={false}>
          <View style={styles.separator} />
          <View style={styles.footerRow}>
            <Text style={styles.footerText}>Rendered by camelAI</Text>
            <Text style={styles.footerText}>{footerRightText}</Text>
          </View>
        </View>

        <Text
          style={styles.pageNumber}
          render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`}
          fixed
        />
      </Page>
    </Document>
  );
}

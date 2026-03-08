'use client';

import { createElement } from 'react';
import {
  blobToDataUrl,
  type PdfImageAsset,
  renderPlotlyPngForPdf,
  renderVegaLitePngForPdf,
  triggerBlobDownload,
} from './chart-runtime';
import { NotebookPdfDocument, type NotebookPdfRenderableBlock } from './pdf-document';
import {
  buildNotebookReportExportModel,
  type NotebookReportExportBlock,
} from './report-export-model';
import type { NotebookFile } from './types';

const EXPORT_TIMEOUT_MS = 30_000;
const CHART_RENDER_TIMEOUT_MS = 5_000;
const IMAGE_FETCH_TIMEOUT_MS = 5_000;

const CHART_FAILURE_COPY = 'Chart could not be rendered for PDF export.';
const GENERIC_HTML_FALLBACK_COPY = 'This interactive HTML output is not included in PDF export.';
const IMAGE_FAILURE_COPY = 'Image could not be rendered for PDF export.';

let pdfFontsRegistered = false;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}

function toPdfFilename(filename: string): string {
  if (/\.ipynb$/i.test(filename)) {
    return filename.replace(/\.ipynb$/i, '.pdf');
  }
  return `${filename}.pdf`;
}

function resolvePdfFontSrc(path: string): string {
  if (typeof window === 'undefined') {
    return path;
  }
  return new URL(path, window.location.origin).toString();
}

function registerPdfFonts(font: typeof import('@react-pdf/renderer').Font): void {
  if (pdfFontsRegistered) return;

  // react-pdf resolves fonts by family + weight + style and throws if an
  // italic face is requested without a registered variant.
  font.register({
    family: 'Figtree',
    fonts: [
      { src: resolvePdfFontSrc('/fonts/Figtree-Regular.ttf'), fontWeight: 400, fontStyle: 'normal' },
      { src: resolvePdfFontSrc('/fonts/Figtree-Regular.ttf'), fontWeight: 400, fontStyle: 'italic' },
      { src: resolvePdfFontSrc('/fonts/Figtree-Bold.ttf'), fontWeight: 700, fontStyle: 'normal' },
      { src: resolvePdfFontSrc('/fonts/Figtree-Bold.ttf'), fontWeight: 700, fontStyle: 'italic' },
    ],
  });
  font.register({
    family: 'Source Serif 4',
    fonts: [{ src: resolvePdfFontSrc('/fonts/SourceSerif4-Regular.ttf'), fontWeight: 400 }],
  });
  font.register({
    family: 'Geist Mono',
    fonts: [
      { src: resolvePdfFontSrc('/fonts/GeistMono-Regular.ttf'), fontWeight: 400 },
      { src: resolvePdfFontSrc('/fonts/GeistMono-Bold.ttf'), fontWeight: 700 },
    ],
  });

  pdfFontsRegistered = true;
}

async function normalizeImageSrcForPdf(src: string): Promise<string> {
  if (src.startsWith('data:')) {
    return src;
  }

  const response = await withTimeout(
    fetch(src),
    IMAGE_FETCH_TIMEOUT_MS,
    'Image fetch timed out during PDF export.'
  );
  if (!response.ok) {
    throw new Error(`Image fetch failed with status ${response.status}.`);
  }

  const blob = await response.blob();
  return await blobToDataUrl(blob);
}

async function getImageDimensions(src: string): Promise<{ width: number; height: number }> {
  const image = new Image();
  return await withTimeout(
    new Promise<{ width: number; height: number }>((resolve, reject) => {
      image.onload = () => {
        resolve({
          width: image.naturalWidth || 1200,
          height: image.naturalHeight || 800,
        });
      };
      image.onerror = () => reject(new Error('Image dimensions could not be read.'));
      image.src = src;
    }),
    IMAGE_FETCH_TIMEOUT_MS,
    'Image load timed out during PDF export.'
  );
}

async function buildPdfImageAsset(src: string): Promise<PdfImageAsset> {
  const normalizedSrc = await normalizeImageSrcForPdf(src);
  const dimensions = await getImageDimensions(normalizedSrc);
  return {
    src: normalizedSrc,
    ...dimensions,
  };
}

async function preparePdfBlock(
  block: NotebookReportExportBlock
): Promise<NotebookPdfRenderableBlock | null> {
  switch (block.kind) {
    case 'markdown':
      return block;
    case 'table':
      return block;
    case 'text':
      return block;
    case 'error':
      return block;
    case 'html':
      return {
        id: block.id,
        kind: 'callout',
        tone: 'muted',
        text: GENERIC_HTML_FALLBACK_COPY,
        title: block.title,
      };
    case 'image':
      try {
        const asset = await buildPdfImageAsset(block.src);
        return {
          id: block.id,
          kind: 'figure',
          title: block.title,
          asset,
        };
      } catch (error) {
        console.error('Notebook PDF image export failed:', error);
        return {
          id: block.id,
          kind: 'callout',
          tone: 'muted',
          text: IMAGE_FAILURE_COPY,
          title: block.title,
        };
      }
    case 'chart':
      try {
        const asset = await withTimeout(
          block.chartKind === 'plotly'
            ? renderPlotlyPngForPdf(block.spec)
            : renderVegaLitePngForPdf(block.spec),
          CHART_RENDER_TIMEOUT_MS,
          'Chart render timed out during PDF export.'
        );
        return {
          id: block.id,
          kind: 'figure',
          title: block.title,
          asset,
        };
      } catch (error) {
        console.error('Notebook PDF chart export failed:', error);
        return {
          id: block.id,
          kind: 'callout',
          tone: 'muted',
          text: CHART_FAILURE_COPY,
          title: block.title,
        };
      }
  }
}

export async function prepareNotebookPdfBlocks(
  blocks: NotebookReportExportBlock[]
): Promise<NotebookPdfRenderableBlock[]> {
  const preparedBlocks: NotebookPdfRenderableBlock[] = [];

  for (const block of blocks) {
    const prepared = await preparePdfBlock(block);
    if (prepared) {
      preparedBlocks.push(prepared);
    }
  }

  return preparedBlocks;
}

export async function exportNotebookReportAsPdf(options: {
  notebook: NotebookFile;
  filename: string;
}): Promise<void> {
  if (typeof document === 'undefined') {
    throw new Error('Notebook PDF export is only available in the browser.');
  }

  await withTimeout(
    (async () => {
      const reactPdfModule = await import('@react-pdf/renderer');
      registerPdfFonts(reactPdfModule.Font);
      const model = buildNotebookReportExportModel(options.notebook);
      const blocks = await prepareNotebookPdfBlocks(model.blocks);
      const pdfTitle = model.header.title ?? options.filename.replace(/\.ipynb$/i, '');
      // `react-pdf` expects a renderer-specific document element here, and
      // `createElement` is the narrowest cast surface for that handoff.
      const documentElement = createElement(NotebookPdfDocument, {
        model,
        blocks,
        pdfTitle,
      }) as unknown as Parameters<typeof reactPdfModule.pdf>[0];

      const blob = await reactPdfModule.pdf(documentElement).toBlob();
      triggerBlobDownload(blob, toPdfFilename(options.filename));
    })(),
    EXPORT_TIMEOUT_MS,
    'Notebook PDF export timed out. Please try again.'
  );
}

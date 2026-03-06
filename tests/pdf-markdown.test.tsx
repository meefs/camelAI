import React from 'react';
import { describe, expect, it } from 'vitest';
import { renderMarkdownToPdfNodes } from '@/components/chat-file-preview/notebook-preview/pdf-markdown';

function collectElementTypeNames(node: React.ReactNode): string[] {
  const names: string[] = [];

  const visit = (value: React.ReactNode) => {
    if (!React.isValidElement(value)) return;

    const type = value.type as { name?: string };
    if (typeof value.type === 'string') {
      names.push(value.type);
    } else if (type?.name) {
      names.push(type.name);
    }

    React.Children.forEach(value.props.children, visit);
  };

  visit(node);
  return names;
}

describe('pdf markdown renderer', () => {
  it('renders inline formatting, links, and nested lists into react-pdf primitives', () => {
    const nodes = renderMarkdownToPdfNodes([
      'Paragraph with **bold** and `code` and [link](https://example.com).',
      '',
      '1. Outer item',
      '   - Inner item',
    ].join('\n'));

    const typeNames = nodes.flatMap((node) => collectElementTypeNames(node));

    expect(typeNames).toContain('TEXT');
    expect(typeNames).toContain('LINK');
    expect(typeNames).toContain('VIEW');
  });

  it('routes markdown tables through the shared PDF table renderer', () => {
    const nodes = renderMarkdownToPdfNodes([
      '| Name | Value |',
      '| --- | --- |',
      '| A | 1 |',
    ].join('\n'));

    const typeNames = nodes.flatMap((node) => collectElementTypeNames(node));

    expect(typeNames).toContain('PdfTable');
  });

  it('renders standalone markdown images as PDF images', () => {
    const nodes = renderMarkdownToPdfNodes('![Chart](https://example.com/chart.png)');

    const typeNames = nodes.flatMap((node) => collectElementTypeNames(node));

    expect(typeNames).toContain('IMAGE');
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { VegaLiteChart } from '@/components/chat-file-preview/notebook-preview/vega-lite-chart';

const VEGA_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega@6';
const VEGA_LITE_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega-lite@6';
const VEGA_EMBED_CDN_URL = 'https://cdn.jsdelivr.net/npm/vega-embed@7';

const BASE_SPEC = {
  $schema: 'https://vega.github.io/schema/vega-lite/v5.json',
  mark: 'bar',
  data: { values: [{ x: 'A', y: 1 }] },
  encoding: {
    x: { field: 'x', type: 'nominal' },
    y: { field: 'y', type: 'quantitative' },
  },
} as const;

describe('VegaLiteChart script loading', () => {
  beforeEach(() => {
    delete (window as { vega?: unknown }).vega;
    delete (window as { vegaLite?: unknown }).vegaLite;
    delete (window as { vegaEmbed?: unknown }).vegaEmbed;

    for (const src of [VEGA_CDN_URL, VEGA_LITE_CDN_URL, VEGA_EMBED_CDN_URL]) {
      for (const script of Array.from(
        document.querySelectorAll<HTMLScriptElement>(
          `script[data-chiridion-notebook-script="${src}"]`
        )
      )) {
        script.remove();
      }
    }
  });

  it('replaces a previously failed vega script tag on retry', async () => {
    const { rerender } = render(<VegaLiteChart spec={BASE_SPEC} title="Example chart" />);

    await waitFor(() => {
      const firstScript = document.querySelector<HTMLScriptElement>(
        `script[data-chiridion-notebook-script="${VEGA_CDN_URL}"]`
      );
      expect(firstScript).not.toBeNull();
    });
    const initialScript = document.querySelector<HTMLScriptElement>(
      `script[data-chiridion-notebook-script="${VEGA_CDN_URL}"]`
    );
    if (!initialScript) {
      throw new Error(`Expected script tag for ${VEGA_CDN_URL}`);
    }
    initialScript.dispatchEvent(new Event('error'));

    await waitFor(() => {
      expect(screen.getByText(`Failed to load ${VEGA_CDN_URL}.`)).toBeInTheDocument();
    });

    rerender(
      <VegaLiteChart
        spec={{ ...BASE_SPEC, mark: 'line' }}
        title="Example chart"
      />
    );

    await waitFor(() => {
      const scripts = Array.from(
        document.querySelectorAll<HTMLScriptElement>(
          `script[data-chiridion-notebook-script="${VEGA_CDN_URL}"]`
        )
      );
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).not.toBe(initialScript);
    });
  });
});

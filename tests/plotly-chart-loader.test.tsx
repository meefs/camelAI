import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PlotlyChart } from '@/components/chat-file-preview/notebook-preview/plotly-chart';

const PLOTLY_CDN_URL = 'https://cdn.plot.ly/plotly-2.35.2.min.js';

describe('PlotlyChart script loading', () => {
  beforeEach(() => {
    delete (window as { Plotly?: unknown }).Plotly;
    for (const script of Array.from(
      document.querySelectorAll<HTMLScriptElement>(
        `script[data-chiridion-notebook-script="${PLOTLY_CDN_URL}"]`
      )
    )) {
      script.remove();
    }
  });

  it('replaces a previously failed script tag on retry', async () => {
    const { rerender } = render(
      <PlotlyChart payload={{ data: [], layout: {}, config: {} }} title="Example chart" />
    );

    await waitFor(() => {
      const firstScript = document.querySelector<HTMLScriptElement>(
        `script[data-chiridion-notebook-script="${PLOTLY_CDN_URL}"]`
      );
      expect(firstScript).not.toBeNull();
    });
    const initialScript = document.querySelector<HTMLScriptElement>(
      `script[data-chiridion-notebook-script="${PLOTLY_CDN_URL}"]`
    );
    if (!initialScript) {
      throw new Error(`Expected script tag for ${PLOTLY_CDN_URL}`);
    }
    initialScript.dispatchEvent(new Event('error'));

    await waitFor(() => {
      expect(screen.getByText(`Failed to load ${PLOTLY_CDN_URL}.`)).toBeInTheDocument();
    });

    rerender(
      <PlotlyChart
        payload={{ data: [], layout: {}, config: {}, refresh: true }}
        title="Example chart"
      />
    );

    await waitFor(() => {
      const scripts = Array.from(
        document.querySelectorAll<HTMLScriptElement>(
          `script[data-chiridion-notebook-script="${PLOTLY_CDN_URL}"]`
        )
      );
      expect(scripts).toHaveLength(1);
      expect(scripts[0]).not.toBe(initialScript);
    });
  });
});


'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CHART_COLORS } from './constants';
import type { ChartHoverState, SpreadsheetChart } from './types';
import { clamp } from './utils';

function formatChartValue(value: number) {
  const absoluteValue = Math.abs(value);
  if (absoluteValue >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }
  if (absoluteValue >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (absoluteValue >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }
  if (absoluteValue >= 100) {
    return value.toFixed(0);
  }
  if (absoluteValue >= 10) {
    return value.toFixed(1);
  }
  return value.toFixed(2).replace(/\.00$/, '');
}

function truncateChartLabel(label: string, maxLength = 12) {
  return label.length > maxLength ? `${label.slice(0, maxLength - 3)}...` : label;
}

function getChartDomain(chart: SpreadsheetChart) {
  const values = chart.series.flatMap((series) =>
    series.values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value)),
  );
  if (values.length === 0) {
    return { min: 0, max: 1 };
  }
  const min = Math.min(0, ...values);
  const max = Math.max(...values);
  if (max === min) {
    return { min: min - 1, max: max + 1 };
  }
  const padding = (max - min) * 0.12;
  return { min: min - padding, max: max + padding };
}

function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
  const angleInRadians = (angleInDegrees - 90) * (Math.PI / 180);
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians),
  };
}

const CHART_PADDING = { top: 18, right: 20, bottom: 44, left: 52 };

export function SpreadsheetChartGraphic({ chart, compact = false }: { chart: SpreadsheetChart; compact?: boolean }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const [hoveredDatum, setHoveredDatum] = useState<ChartHoverState | null>(null);
  const width = 640;
  const height = compact ? 260 : 360;
  const padding = CHART_PADDING;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const domain = getChartDomain(chart);
  const yScale = (value: number) =>
    padding.top + ((domain.max - value) / (domain.max - domain.min)) * plotHeight;
  const zeroY = yScale(0);
  const tickValues = Array.from({ length: 4 }, (_, index) => {
    const ratio = index / 3;
    return domain.max - (domain.max - domain.min) * ratio;
  });
  const isCircularChart = chart.kind === 'pie' || chart.kind === 'doughnut';
  const categoryColors = chart.categories.map(
    (_, index) => CHART_COLORS[index % CHART_COLORS.length] ?? CHART_COLORS[0],
  );
  const circularSeries = chart.series[0];
  const circularValues = circularSeries?.values.map((value) => Math.max(value ?? 0, 0)) ?? [];
  const circularTotal = circularValues.reduce((sum, value) => sum + value, 0);
  let currentAngle = 0;

  const positionTooltip = (left: number, top: number) => {
    if (!tooltipRef.current) return;
    tooltipRef.current.style.left = `${left}px`;
    tooltipRef.current.style.top = `${top}px`;
  };

  const showHover = (
    event: ReactMouseEvent<SVGElement>,
    payload: Omit<ChartHoverState, 'left' | 'top'>,
  ) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const localX = event.clientX - rect.left;
    const localY = event.clientY - rect.top;
    const left = clamp(localX, 20, Math.max(20, rect.width - 20));
    const top = clamp(localY, 16, Math.max(16, rect.height - 16));

    if (
      hoveredDatum &&
      hoveredDatum.key === payload.key &&
      hoveredDatum.category === payload.category &&
      hoveredDatum.seriesName === payload.seriesName &&
      hoveredDatum.value === payload.value &&
      hoveredDatum.color === payload.color
    ) {
      positionTooltip(left, top);
      return;
    }

    setHoveredDatum({
      ...payload,
      left,
      top,
    });
  };

  useEffect(() => {
    if (!hoveredDatum) return;
    positionTooltip(hoveredDatum.left, hoveredDatum.top);
  }, [hoveredDatum]);

  const renderBarChart = () => {
    const slotWidth = plotWidth / chart.categories.length;
    const seriesCount = Math.max(chart.series.length, 1);
    const groupGap = Math.min(16, slotWidth * 0.22);
    const availableGroupWidth = Math.max(slotWidth - groupGap, 4);
    const barGap = seriesCount > 1 ? Math.min(4, availableGroupWidth * 0.08) : 0;
    const barWidth = Math.max(
      2,
      Math.min(36, (availableGroupWidth - barGap * (seriesCount - 1)) / seriesCount),
    );
    const groupWidth = barWidth * seriesCount + barGap * (seriesCount - 1);

    return (
      <>
        {chart.categories.flatMap((category, categoryIndex) =>
          chart.series.map((series, seriesIndex) => {
            const value = series.values[categoryIndex];
            if (typeof value !== 'number' || !Number.isFinite(value)) return null;
            const barHeight = Math.abs(yScale(value) - zeroY);
            const x =
              padding.left +
              slotWidth * categoryIndex +
              (slotWidth - groupWidth) / 2 +
              seriesIndex * (barWidth + barGap);
            const y = value >= 0 ? zeroY - barHeight : zeroY;

            return (
              <rect
                data-testid="spreadsheet-chart-datum"
                key={`${series.name}-${category}-${categoryIndex}`}
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barHeight, 2)}
                rx="6"
                fill={series.color}
                fillOpacity={
                  hoveredDatum?.key === `${series.name}:${categoryIndex}:${category}` ? '1' : '0.88'
                }
                onMouseMove={(event) =>
                  showHover(event, {
                    key: `${series.name}:${categoryIndex}:${category}`,
                    category,
                    seriesName: series.name,
                    value,
                    color: series.color,
                  })
                }
              />
            );
          }),
        )}
        {chart.categories.map((category, index) => (
          <text
            key={`${category}-${index}-axis`}
            x={padding.left + slotWidth * index + slotWidth / 2}
            y={height - 16}
            textAnchor="middle"
            fontSize="11"
            fill="var(--muted-foreground)"
          >
            {truncateChartLabel(category)}
          </text>
        ))}
      </>
    );
  };

  const renderLineChart = () => {
    const slotWidth = plotWidth / Math.max(chart.categories.length - 1, 1);

    return (
      <>
        {chart.series.map((series) => {
          let path = '';
          let isSegmentOpen = false;

          series.values.forEach((value, index) => {
            if (typeof value !== 'number' || !Number.isFinite(value)) {
              isSegmentOpen = false;
              return;
            }
            const x = padding.left + slotWidth * index;
            const y = yScale(value);
            path += `${path ? ' ' : ''}${isSegmentOpen ? 'L' : 'M'} ${x} ${y}`;
            isSegmentOpen = true;
          });

          return (
            <g key={series.name}>
              <path
                d={path}
                fill="none"
                stroke={series.color}
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              {series.values.map((value, index) => {
                if (typeof value !== 'number' || !Number.isFinite(value)) return null;
                const category = chart.categories[index] ?? `Point ${index + 1}`;
                const x = padding.left + slotWidth * index;
                const y = yScale(value);
                return (
                  <circle
                    data-testid="spreadsheet-chart-datum"
                    key={`${series.name}-${index}`}
                    cx={x}
                    cy={y}
                    r={hoveredDatum?.key === `${series.name}:${index}:${category}` ? '6' : '4.5'}
                    fill={series.color}
                    stroke="var(--card)"
                    strokeWidth="2"
                    onMouseMove={(event) =>
                      showHover(event, {
                        key: `${series.name}:${index}:${category}`,
                        category,
                        seriesName: series.name,
                        value,
                        color: series.color,
                      })
                    }
                  />
                );
              })}
            </g>
          );
        })}
        {chart.categories.map((category, index) => (
          <text
            key={`${category}-${index}-axis`}
            x={padding.left + slotWidth * index}
            y={height - 16}
            textAnchor="middle"
            fontSize="11"
            fill="var(--muted-foreground)"
          >
            {truncateChartLabel(category)}
          </text>
        ))}
      </>
    );
  };

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full"
      onMouseLeave={() => {
        setHoveredDatum(null);
      }}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-full w-full"
        role="img"
        aria-label={chart.title}
      >
        <rect x="0" y="0" width={width} height={height} rx="18" fill="var(--card)" />

      {isCircularChart ? (
        <>
          <g transform={`translate(${width * 0.34}, ${height / 2})`}>
            <circle cx="0" cy="0" r="84" fill="var(--muted)" />
            {circularTotal > 0 &&
              chart.categories.map((category, index) => {
                const value = circularValues[index] ?? 0;
                if (value <= 0) return null;
                const arcAngle = (value / circularTotal) * 360;
                const start = polarToCartesian(0, 0, 84, currentAngle);
                const end = polarToCartesian(0, 0, 84, currentAngle + arcAngle);
                const largeArc = arcAngle > 180 ? 1 : 0;
                const path = [
                  'M 0 0',
                  `L ${start.x} ${start.y}`,
                  `A 84 84 0 ${largeArc} 1 ${end.x} ${end.y}`,
                  'Z',
                ].join(' ');
                const segment = (
                  <path
                    data-testid="spreadsheet-chart-datum"
                    key={`${category}-${index}`}
                    d={path}
                    fill={categoryColors[index]}
                    stroke="var(--card)"
                    strokeWidth={hoveredDatum?.key === `${chart.kind}:${index}:${category}` ? '4' : '2'}
                    onMouseMove={(event) =>
                      showHover(event, {
                        key: `${chart.kind}:${index}:${category}`,
                        category,
                        seriesName: circularSeries?.name ?? chart.title,
                        value,
                        color: categoryColors[index],
                      })
                    }
                  />
                );
                currentAngle += arcAngle;
                return segment;
              })}
            {chart.kind === 'doughnut' && <circle cx="0" cy="0" r="42" fill="var(--card)" />}
          </g>

          <g transform={`translate(${width * 0.56}, 48)`}>
            {chart.categories.map((category, index) => {
              const value = circularValues[index] ?? 0;
              const top = index * 28;
              return (
                <g key={`${category}-${index}-legend`} transform={`translate(0, ${top})`}>
                  <circle cx="8" cy="8" r="6" fill={categoryColors[index]} />
                  <text x="24" y="12" fontSize="12" fill="var(--foreground)">
                    {truncateChartLabel(category, 20)}
                  </text>
                  <text x="220" y="12" fontSize="12" fill="var(--muted-foreground)" textAnchor="end">
                    {formatChartValue(value)}
                  </text>
                </g>
              );
            })}
          </g>
        </>
      ) : (
        <>
          {tickValues.map((tickValue, index) => {
            const y = yScale(tickValue);
            return (
              <g key={index}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  stroke="var(--border)"
                  strokeDasharray="4 6"
                />
                <text
                  x={padding.left - 10}
                  y={y + 4}
                  textAnchor="end"
                  fontSize="11"
                  fill="var(--muted-foreground)"
                >
                  {formatChartValue(tickValue)}
                </text>
              </g>
            );
          })}
          <line
            x1={padding.left}
            y1={zeroY}
            x2={width - padding.right}
            y2={zeroY}
            stroke="var(--border)"
            strokeWidth="1.2"
          />

          {chart.kind === 'bar' ? renderBarChart() : renderLineChart()}
        </>
      )}
      </svg>
      {hoveredDatum && (
        <div
          ref={tooltipRef}
          data-testid="spreadsheet-chart-tooltip"
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-3 py-2 text-popover-foreground shadow-md"
          style={{
            left: hoveredDatum.left,
            top: hoveredDatum.top,
            transform: 'translate(-50%, calc(-100% - 10px))',
          }}
        >
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-full"
              style={{ backgroundColor: hoveredDatum.color }}
            />
            <span className="text-xs font-semibold">{hoveredDatum.seriesName}</span>
          </div>
          <div className="mt-1 text-xs text-muted-foreground">{hoveredDatum.category}</div>
          <div className="text-sm font-medium">{formatChartValue(hoveredDatum.value)}</div>
        </div>
      )}
    </div>
  );
}

function ChartTabBar({
  charts,
  activeIndex,
  onActiveIndexChange,
}: {
  charts: SpreadsheetChart[];
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [scrollState, setScrollState] = useState({
    hasOverflow: false,
    canScrollBackward: false,
    canScrollForward: false,
  });

  const updateScrollState = useCallback(() => {
    const node = scrollerRef.current;
    if (!node) return;
    const maxScrollLeft = Math.max(0, node.scrollWidth - node.clientWidth);
    setScrollState({
      hasOverflow: maxScrollLeft > 1,
      canScrollBackward: node.scrollLeft > 1,
      canScrollForward: node.scrollLeft < maxScrollLeft - 1,
    });
  }, []);
  const updateScrollStateRef = useRef(updateScrollState);
  updateScrollStateRef.current = updateScrollState;

  useLayoutEffect(() => {
    const node = scrollerRef.current;
    if (!node) return;

    const handleScrollStateChange = () => updateScrollStateRef.current();
    const resizeObserver = new ResizeObserver(handleScrollStateChange);
    resizeObserver.observe(node);
    node.addEventListener('scroll', handleScrollStateChange, { passive: true });
    handleScrollStateChange();

    return () => {
      resizeObserver.disconnect();
      node.removeEventListener('scroll', handleScrollStateChange);
    };
  }, []);

  useLayoutEffect(() => {
    updateScrollState();
  }, [charts, updateScrollState]);

  useEffect(() => {
    const activeTab = tabRefs.current[activeIndex];
    if (typeof activeTab?.scrollIntoView === 'function') {
      activeTab.scrollIntoView({
        block: 'nearest',
        inline: 'nearest',
      });
    }
    window.requestAnimationFrame(updateScrollState);
  }, [activeIndex, updateScrollState]);

  const scrollTabs = (direction: -1 | 1) => {
    scrollerRef.current?.scrollBy({
      left: direction * 220,
      behavior: 'smooth',
    });
  };

  const focusTab = (index: number) => {
    const nextIndex = Math.max(0, Math.min(charts.length - 1, index));
    onActiveIndexChange(nextIndex);
    window.requestAnimationFrame(() => tabRefs.current[nextIndex]?.focus());
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab(activeIndex - 1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab(activeIndex + 1);
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      focusTab(0);
      return;
    }
    if (event.key === 'End') {
      event.preventDefault();
      focusTab(charts.length - 1);
    }
  };

  return (
    <div className="flex items-end gap-1 border-b border-border/70 bg-muted/60 px-2 pt-1">
      {scrollState.hasOverflow && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Scroll charts left"
          className="mb-1 shrink-0"
          disabled={!scrollState.canScrollBackward}
          onClick={() => scrollTabs(-1)}
        >
          <ChevronLeft className="size-4" />
        </Button>
      )}

      <div
        ref={scrollerRef}
        role="tablist"
        aria-label="Workbook charts"
        className="min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
        onKeyDown={handleKeyDown}
      >
        <div className="flex w-max min-w-full items-end gap-1 border-b border-border">
          {charts.map((chart, index) => {
            const title = chart.title || `Chart ${index + 1}`;
            return (
              <button
                key={chart.id}
                ref={(node) => {
                  tabRefs.current[index] = node;
                }}
                type="button"
                role="tab"
                aria-selected={index === activeIndex}
                tabIndex={index === activeIndex ? 0 : -1}
                className={cn(
                  'relative flex max-w-[190px] min-w-[120px] shrink-0 flex-col items-start rounded-t-md border px-3 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                  index === activeIndex
                    ? 'z-10 -mb-px border-border border-b-card bg-card text-foreground'
                    : 'border-transparent bg-muted/40 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
                title={`${title} - ${chart.sheetName}`}
                onClick={() => onActiveIndexChange(index)}
              >
                <span className="w-full truncate font-medium">{title}</span>
                <span className="w-full truncate text-[11px] font-normal text-muted-foreground">
                  {chart.sheetName}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {scrollState.hasOverflow && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Scroll charts right"
          className="mb-1 shrink-0"
          disabled={!scrollState.canScrollForward}
          onClick={() => scrollTabs(1)}
        >
          <ChevronRight className="size-4" />
        </Button>
      )}
    </div>
  );
}

export function SpreadsheetChartWorkspace({ chart }: { chart: SpreadsheetChart }) {
  return (
    <div data-testid="spreadsheet-chart-workspace" className="rounded-lg border border-border bg-card shadow-sm">
      <div className="px-4 py-4">
        <h3 className="text-lg font-semibold text-foreground">{chart.title || 'Excel Chart'}</h3>
      </div>
      <div className="p-4">
        <div className="relative h-[26rem]">
          <SpreadsheetChartGraphic chart={chart} />
        </div>
      </div>
    </div>
  );
}

export function SpreadsheetChartsSurface({
  charts,
}: {
  charts: SpreadsheetChart[];
}) {
  const [activeChartIndex, setActiveChartIndex] = useState(0);

  useLayoutEffect(() => {
    setActiveChartIndex(0);
  }, [charts]);

  if (charts.length === 0) {
    return (
      <div className="flex h-full min-h-[280px] items-center justify-center bg-muted px-6 text-center">
        <div className="max-w-sm space-y-2">
          <p className="text-sm font-medium text-foreground">No embedded charts found</p>
          <p className="text-xs text-muted-foreground">
            This preview only renders charts embedded in the workbook.
          </p>
        </div>
      </div>
    );
  }

  const activeChart = charts[Math.min(activeChartIndex, charts.length - 1)];
  if (!activeChart) return null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-muted">
      {charts.length > 1 && (
        <ChartTabBar
          charts={charts}
          activeIndex={Math.min(activeChartIndex, charts.length - 1)}
          onActiveIndexChange={setActiveChartIndex}
        />
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <SpreadsheetChartWorkspace chart={activeChart} />
      </div>
    </div>
  );
}

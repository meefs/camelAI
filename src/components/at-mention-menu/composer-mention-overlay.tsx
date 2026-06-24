'use client';

import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { parseMentions } from '@/lib/mentions';
import { MentionTargetHoverPreview } from '@/components/at-mention-menu/mention-target-hover-preview';
import type { AtMentionEntity } from '@/types';

interface ComposerMentionDecorationsProps {
  value: string;
  slugMap: Map<string, AtMentionEntity>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  scrollTop: number;
  scrollLeft: number;
  onTextareaSelectionChange?: () => void;
}

interface MentionMeasurement {
  key: string;
  slug: string;
  target: AtMentionEntity;
  startIndex: number;
  endIndex: number;
}

interface MentionDecorationRect extends MentionMeasurement {
  rectKey: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

const CHIP_X_PAD = 6;
const CHIP_Y_PAD = 2;
const RECT_EPSILON = 0.25;
const ZERO_WIDTH_SENTINEL = '\u200b';

const MIRROR_STYLE_PROPS = [
  'boxSizing',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontVariant',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'textAlign',
  'textIndent',
  'textTransform',
  'tabSize',
] as const;

function roundRectValue(value: number): number {
  return Math.round(value * 100) / 100;
}

function rectsEqual(
  a: MentionDecorationRect[],
  b: MentionDecorationRect[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((leftRect, index) => {
    const rightRect = b[index];
    if (!rightRect) return false;
    return leftRect.rectKey === rightRect.rectKey &&
      leftRect.slug === rightRect.slug &&
      leftRect.target.kind === rightRect.target.kind &&
      leftRect.target.id === rightRect.target.id &&
      leftRect.startIndex === rightRect.startIndex &&
      leftRect.endIndex === rightRect.endIndex &&
      Math.abs(leftRect.left - rightRect.left) < RECT_EPSILON &&
      Math.abs(leftRect.top - rightRect.top) < RECT_EPSILON &&
      Math.abs(leftRect.width - rightRect.width) < RECT_EPSILON &&
      Math.abs(leftRect.height - rightRect.height) < RECT_EPSILON;
  });
}

function syncMirrorStyles(
  textarea: HTMLTextAreaElement,
  mirror: HTMLDivElement,
) {
  const computed = window.getComputedStyle(textarea);
  for (const prop of MIRROR_STYLE_PROPS) {
    mirror.style[prop] = computed[prop];
  }
  mirror.style.width = `${textarea.clientWidth}px`;
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
}

function renderMirrorTokens(
  value: string,
  mentions: MentionMeasurement[],
): ReactNode[] {
  const output: ReactNode[] = [];
  let cursor = 0;

  for (const mention of mentions) {
    if (mention.startIndex > cursor) {
      output.push(value.slice(cursor, mention.startIndex));
    }

    output.push(
      <span key={mention.key} data-mention-key={mention.key}>
        {value.slice(mention.startIndex, mention.endIndex)}
      </span>,
    );
    cursor = mention.endIndex;
  }

  if (cursor < value.length) {
    output.push(value.slice(cursor));
  }

  output.push(ZERO_WIDTH_SENTINEL);
  return output;
}

export function ComposerMentionDecorations({
  value,
  slugMap,
  textareaRef,
  wrapperRef,
  scrollTop,
  scrollLeft,
  onTextareaSelectionChange,
}: ComposerMentionDecorationsProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [rects, setRects] = useState<MentionDecorationRect[]>([]);
  const [measurementVersion, setMeasurementVersion] = useState(0);

  const mentions = useMemo<MentionMeasurement[]>(() => {
    return parseMentions(value, slugMap)
      .filter((match) => match.target !== null)
      .map((match) => ({
        key: `${match.index}-${match.length}-${match.slug}`,
        slug: match.slug,
        target: match.target as AtMentionEntity,
        startIndex: match.index,
        endIndex: match.index + match.length,
      }));
  }, [value, slugMap]);

  const mentionByKey = useMemo(() => {
    return new Map(mentions.map((mention) => [mention.key, mention]));
  }, [mentions]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const wrapper = wrapperRef.current;
    if (!textarea || !wrapper || typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      setMeasurementVersion((version) => version + 1);
    });
    observer.observe(textarea);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [textareaRef, wrapperRef]);

  useLayoutEffect(() => {
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) {
        setMeasurementVersion((version) => version + 1);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const mirror = mirrorRef.current;
    if (!textarea || !mirror) {
      setRects((previous) => previous.length === 0 ? previous : []);
      return;
    }

    syncMirrorStyles(textarea, mirror);

    const mirrorBox = mirror.getBoundingClientRect();
    const nextRects: MentionDecorationRect[] = [];

    for (const element of mirror.querySelectorAll<HTMLElement>('[data-mention-key]')) {
      const key = element.dataset.mentionKey;
      const mention = key ? mentionByKey.get(key) : null;
      if (!mention) continue;

      let fragmentIndex = 0;
      for (const fragment of element.getClientRects()) {
        if (fragment.width <= 0 || fragment.height <= 0) continue;
        nextRects.push({
          ...mention,
          rectKey: `${mention.key}-${fragmentIndex}`,
          left: roundRectValue(fragment.left - mirrorBox.left - CHIP_X_PAD),
          top: roundRectValue(fragment.top - mirrorBox.top - CHIP_Y_PAD),
          width: roundRectValue(fragment.width + CHIP_X_PAD * 2),
          height: roundRectValue(fragment.height + CHIP_Y_PAD * 2),
        });
        fragmentIndex++;
      }
    }

    setRects((previous) => (
      rectsEqual(previous, nextRects) ? previous : nextRects
    ));
  }, [mentionByKey, measurementVersion, textareaRef, value]);

  const planeTransform = `translate(${-scrollLeft}px, ${-scrollTop}px)`;

  return (
    <>
      <div
        aria-hidden
        ref={mirrorRef}
        className="pointer-events-none invisible absolute left-0 top-0 whitespace-pre-wrap break-words"
      >
        {renderMirrorTokens(value, mentions)}
      </div>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0 overflow-hidden"
      >
        <div
          className="absolute left-0 top-0"
          style={{ transform: planeTransform }}
        >
          {rects.map((rect) => (
            <span
              key={rect.rectKey}
              className="absolute rounded-md bg-muted"
              style={{
                left: rect.left,
                top: rect.top,
                width: rect.width,
                height: rect.height,
              }}
            />
          ))}
        </div>
      </div>

      <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
        <div
          className="absolute left-0 top-0"
          style={{ transform: planeTransform }}
        >
          {rects.map((rect) => (
            <HoverCard key={`hit-${rect.rectKey}`} openDelay={200} closeDelay={100}>
              <HoverCardTrigger asChild>
                <span
                  aria-hidden
                  className="pointer-events-auto absolute cursor-default rounded-md"
                  style={{
                    left: rect.left,
                    top: rect.top,
                    width: rect.width,
                    height: rect.height,
                  }}
                  onPointerDown={(event: PointerEvent<HTMLSpanElement>) => {
                    event.preventDefault();
                    const textarea = textareaRef.current;
                    if (!textarea) return;
                    textarea.focus();
                    textarea.setSelectionRange(rect.startIndex, rect.endIndex);
                    onTextareaSelectionChange?.();
                  }}
                />
              </HoverCardTrigger>
              <HoverCardContent
                side="top"
                align="start"
                className="w-auto min-w-[200px] max-w-[280px] rounded-md border border-border p-2 shadow-md ring-0"
              >
                <MentionTargetHoverPreview target={rect.target} />
              </HoverCardContent>
            </HoverCard>
          ))}
        </div>
      </div>
    </>
  );
}

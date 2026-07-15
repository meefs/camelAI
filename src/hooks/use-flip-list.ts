import { useLayoutEffect, useRef, type RefObject } from "react";

const FLIP_DURATION_MS = 300;
const FLIP_EASING = "cubic-bezier(0.2, 0, 0, 1)";

function getFlipItems(list: HTMLElement): HTMLElement[] {
  return Array.from(
    list.querySelectorAll<HTMLElement>("[data-flip-id]"),
  );
}

function measureFlipPositions(items: HTMLElement[]): Map<string, number> {
  return new Map(
    items
      .filter((el) => el.dataset.flipId)
      .map((el) => [el.dataset.flipId as string, el.offsetTop]),
  );
}

function cancelTrackedAnimations(animations: Map<string, Animation>): void {
  for (const animation of animations.values()) {
    animation.cancel();
  }
  animations.clear();
}

/**
 * FLIP-animates vertical reordering of a list's children. Children must carry
 * a stable `data-flip-id`. Only reorders animate: first mount, insertions, and
 * removals render in place. No-ops under prefers-reduced-motion and in
 * environments without WAAPI (jsdom).
 */
export function useFlipList(
  listRef: RefObject<HTMLElement | null>,
  orderKey: string,
): void {
  const positionsRef = useRef<Map<string, number>>(new Map());
  const prevOrderKeyRef = useRef<string | null>(null);
  const animationsRef = useRef<Map<string, Animation>>(new Map());

  // No dependency array: the effect must refresh positionsRef even when the
  // order didn't change, so the "first" positions are never stale. The work is
  // a handful of offsetTop reads; the list is small.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = getFlipItems(list);
    const supportsWaapi =
      typeof Element !== "undefined" &&
      typeof Element.prototype.animate === "function";
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const orderChanged =
      prevOrderKeyRef.current !== null && prevOrderKeyRef.current !== orderKey;

    if (reduceMotion) {
      cancelTrackedAnimations(animationsRef.current);
    }

    if (orderChanged && supportsWaapi && !reduceMotion) {
      for (const el of items) {
        const id = el.dataset.flipId;
        if (!id) continue;
        const stored = positionsRef.current.get(id);
        if (stored === undefined) continue; // new item: appear in place
        // offsetTop reports the layout box — it ignores the in-flight
        // transform and is immune to container scroll, so "last" is always
        // the true destination slot.
        const last = el.offsetTop;
        let first = stored;
        const running = animationsRef.current.get(id);
        if (running && running.playState === "running") {
          // Interrupted mid-flight: resume from the currently painted spot.
          // Read the transform BEFORE cancel().
          const transform = getComputedStyle(el).transform;
          if (transform && transform !== "none") {
            first = stored + new DOMMatrixReadOnly(transform).m42;
          }
          running.cancel();
        }
        const delta = first - last;
        if (Math.abs(delta) < 1) continue;
        const animation = el.animate(
          [{ transform: `translateY(${delta}px)` }, { transform: "none" }],
          { duration: FLIP_DURATION_MS, easing: FLIP_EASING },
        );
        animationsRef.current.set(id, animation);
        const clearSettledAnimation = () => {
          if (animationsRef.current.get(id) === animation) {
            animationsRef.current.delete(id);
          }
        };
        // cancel() rejects `finished`; both outcomes release the animation and
        // its target. The identity check keeps an interrupted animation from
        // deleting the replacement stored under the same row id.
        void animation.finished.then(
          clearSettledAnimation,
          clearSettledAnimation,
        );
      }
    }

    positionsRef.current = measureFlipPositions(items);
    prevOrderKeyRef.current = orderKey;
  });

  // Ancestor-only sidebar transitions do not render ChatGroupsList, but they
  // can change row heights and offsets. Keep the FLIP snapshot synchronized
  // with those layout changes so the next reorder starts from current slots.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      positionsRef.current = measureFlipPositions(getFlipItems(list));
    });
    observer.observe(list);
    for (const item of getFlipItems(list)) {
      observer.observe(item);
    }
    return () => observer.disconnect();
  });

  useLayoutEffect(() => {
    return () => {
      cancelTrackedAnimations(animationsRef.current);
    };
  }, []);
}

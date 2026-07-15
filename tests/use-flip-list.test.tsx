import { useRef } from "react";
import { render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useFlipList } from "@/hooks/use-flip-list";

// jsdom has neither WAAPI nor layout. Stub Element.prototype.animate (recording
// the element it ran on) and drive offsetTop from a test-controlled layout
// table keyed by data-flip-id.
const layout = new Map<string, number>();

function setLayout(ids: string[], rowHeight = 28) {
  layout.clear();
  ids.forEach((id, index) => layout.set(id, index * rowHeight));
}

interface RecordedAnimateCall {
  flipId: string | undefined;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

interface StubAnimation {
  cancel: ReturnType<typeof vi.fn>;
  finished: Promise<void>;
  playState: AnimationPlayState;
}

interface DeferredAnimation {
  animation: StubAnimation;
  resolve: () => void;
}

let animateCalls: RecordedAnimateCall[] = [];
let createdAnimations: StubAnimation[] = [];

function createResolvedAnimation(): StubAnimation {
  return {
    cancel: vi.fn(),
    finished: Promise.resolve(),
    playState: "finished",
  };
}

function createDeferredAnimation(): DeferredAnimation {
  let resolve = () => {};
  const finished = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return {
    animation: {
      cancel: vi.fn(),
      finished,
      playState: "running",
    },
    resolve,
  };
}

let animationFactory = createResolvedAnimation;

function animateStub(
  this: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
) {
  animateCalls.push({ flipId: this.dataset.flipId, keyframes, options });
  const animation = animationFactory();
  createdAnimations.push(animation);
  return animation;
}

let originalOffsetTop: PropertyDescriptor | undefined;

beforeAll(() => {
  originalOffsetTop = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "offsetTop",
  );
  Object.defineProperty(HTMLElement.prototype, "offsetTop", {
    configurable: true,
    get(this: HTMLElement) {
      return layout.get(this.dataset.flipId ?? "") ?? 0;
    },
  });
  (Element.prototype as { animate: unknown }).animate = animateStub;
});

afterAll(() => {
  if (originalOffsetTop) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetTop",
      originalOffsetTop,
    );
  }
  delete (Element.prototype as { animate?: unknown }).animate;
});

beforeEach(() => {
  animateCalls = [];
  createdAnimations = [];
  animationFactory = createResolvedAnimation;
  layout.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function FlipList({ ids }: { ids: string[] }) {
  const listRef = useRef<HTMLUListElement | null>(null);
  useFlipList(listRef, ids.join("\n"));
  return (
    <ul ref={listRef}>
      {ids.map((id) => (
        <li key={id} data-flip-id={id}>
          {id}
        </li>
      ))}
    </ul>
  );
}

describe("useFlipList", () => {
  it("does not animate on first render", () => {
    setLayout(["a", "b", "c"]);
    render(<FlipList ids={["a", "b", "c"]} />);

    expect(animateCalls).toHaveLength(0);
  });

  it("animates moved items from their previous slot and leaves unmoved items alone", () => {
    setLayout(["a", "b", "c"]);
    const { rerender } = render(<FlipList ids={["a", "b", "c"]} />);

    setLayout(["b", "a", "c"]);
    rerender(<FlipList ids={["b", "a", "c"]} />);

    expect(animateCalls.map((call) => call.flipId).sort()).toEqual(["a", "b"]);

    const aCall = animateCalls.find((call) => call.flipId === "a");
    expect(aCall?.keyframes).toEqual([
      { transform: "translateY(-28px)" },
      { transform: "none" },
    ]);
    const bCall = animateCalls.find((call) => call.flipId === "b");
    expect(bCall?.keyframes).toEqual([
      { transform: "translateY(28px)" },
      { transform: "none" },
    ]);
    expect(aCall?.options).toEqual({
      duration: 300,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
    });
  });

  it("renders appended items in place without animating anything", () => {
    setLayout(["a", "b"]);
    const { rerender } = render(<FlipList ids={["a", "b"]} />);

    setLayout(["a", "b", "c"]);
    rerender(<FlipList ids={["a", "b", "c"]} />);

    expect(animateCalls).toHaveLength(0);
  });

  it("slides survivors up into the gap a removed item leaves", () => {
    setLayout(["a", "b", "c"]);
    const { rerender } = render(<FlipList ids={["a", "b", "c"]} />);

    setLayout(["a", "c"]);
    rerender(<FlipList ids={["a", "c"]} />);

    expect(animateCalls.map((call) => call.flipId)).toEqual(["c"]);
    expect(animateCalls[0].keyframes).toEqual([
      { transform: "translateY(28px)" },
      { transform: "none" },
    ]);
  });

  it("refreshes stored positions after a layout change without a hook render", () => {
    const observers: Array<{ trigger: () => void }> = [];
    class TestResizeObserver {
      constructor(private readonly callback: ResizeObserverCallback) {
        observers.push({ trigger: () => this.callback([], this as ResizeObserver) });
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);

    try {
      setLayout(["a", "b"]);
      const { rerender } = render(<FlipList ids={["a", "b"]} />);
      expect(observers).toHaveLength(1);

      // The collapsed sidebar changes layout without rendering ChatGroupsList.
      setLayout(["a", "b"], 40);
      observers[0].trigger();
      expect(animateCalls).toHaveLength(0);

      setLayout(["b", "a"], 40);
      rerender(<FlipList ids={["b", "a"]} />);

      const bCall = animateCalls.find((call) => call.flipId === "b");
      expect(bCall?.keyframes).toEqual([
        { transform: "translateY(40px)" },
        { transform: "none" },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("releases an animation after its finished promise settles", async () => {
    const deferredAnimations: DeferredAnimation[] = [];
    animationFactory = () => {
      const deferred = createDeferredAnimation();
      deferredAnimations.push(deferred);
      return deferred.animation;
    };
    setLayout(["a", "b"]);
    const { rerender } = render(<FlipList ids={["a", "b"]} />);

    setLayout(["b", "a"]);
    rerender(<FlipList ids={["b", "a"]} />);
    expect(deferredAnimations).toHaveLength(2);

    deferredAnimations.forEach(({ resolve }) => resolve());
    await Promise.all(
      deferredAnimations.map(({ animation }) => animation.finished),
    );
    // If the settled animations were still retained, marking the stubs as
    // running would make the next reorder cancel them.
    deferredAnimations.forEach(({ animation }) => {
      animation.playState = "running";
    });

    setLayout(["a", "b"]);
    rerender(<FlipList ids={["a", "b"]} />);

    for (const { animation } of deferredAnimations) {
      expect(animation.cancel).not.toHaveBeenCalled();
    }
  });

  it("does not let a settled animation delete its replacement", async () => {
    const deferredAnimations: DeferredAnimation[] = [];
    animationFactory = () => {
      const deferred = createDeferredAnimation();
      deferredAnimations.push(deferred);
      return deferred.animation;
    };
    setLayout(["a", "b"]);
    const { rerender } = render(<FlipList ids={["a", "b"]} />);

    setLayout(["b", "a"]);
    rerender(<FlipList ids={["b", "a"]} />);
    const firstAnimations = deferredAnimations.slice();

    setLayout(["a", "b"]);
    rerender(<FlipList ids={["a", "b"]} />);
    const replacementAnimations = deferredAnimations.slice(2);
    expect(replacementAnimations).toHaveLength(2);

    firstAnimations.forEach(({ resolve }) => resolve());
    await Promise.all(
      firstAnimations.map(({ animation }) => animation.finished),
    );

    setLayout(["b", "a"]);
    rerender(<FlipList ids={["b", "a"]} />);

    for (const { animation } of replacementAnimations) {
      expect(animation.cancel).toHaveBeenCalledOnce();
    }
  });

  it("cancels active animations when the list unmounts", () => {
    animationFactory = () => createDeferredAnimation().animation;
    setLayout(["a", "b"]);
    const { rerender, unmount } = render(<FlipList ids={["a", "b"]} />);

    setLayout(["b", "a"]);
    rerender(<FlipList ids={["b", "a"]} />);
    const activeAnimations = createdAnimations.slice();
    expect(activeAnimations).toHaveLength(2);

    unmount();

    for (const animation of activeAnimations) {
      expect(animation.cancel).toHaveBeenCalledOnce();
    }
  });

  it("does not animate when only data behind the same order re-renders", () => {
    setLayout(["a", "b"]);
    const { rerender } = render(<FlipList ids={["a", "b"]} />);

    rerender(<FlipList ids={["a", "b"]} />);

    expect(animateCalls).toHaveLength(0);
  });

  it("does not animate under prefers-reduced-motion", () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as typeof window.matchMedia;

    try {
      setLayout(["a", "b"]);
      const { rerender } = render(<FlipList ids={["a", "b"]} />);

      setLayout(["b", "a"]);
      rerender(<FlipList ids={["b", "a"]} />);

      expect(animateCalls).toHaveLength(0);
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("cancels active animations when reduced motion becomes enabled", () => {
    const originalMatchMedia = window.matchMedia;
    let reduceMotion = false;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches:
        reduceMotion && query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as typeof window.matchMedia;
    animationFactory = () => createDeferredAnimation().animation;

    try {
      setLayout(["a", "b"]);
      const { rerender } = render(<FlipList ids={["a", "b"]} />);

      setLayout(["b", "a"]);
      rerender(<FlipList ids={["b", "a"]} />);
      const activeAnimations = createdAnimations.slice();
      expect(activeAnimations).toHaveLength(2);

      reduceMotion = true;
      rerender(<FlipList ids={["b", "a"]} />);

      for (const animation of activeAnimations) {
        expect(animation.cancel).toHaveBeenCalledOnce();
      }
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

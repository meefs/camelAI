import { memo, useEffect, useRef } from "react";
import { useTheme } from "next-themes";

const SPACING = 26;
const X_ARM = 6;
const BAND = SPACING * 5;

function drawX(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  arm: number,
  alpha: number,
  rgb: string,
) {
  if (alpha < 0.004) return;
  const s = arm * 0.707;
  ctx.beginPath();
  ctx.moveTo(cx - s, cy - s);
  ctx.lineTo(cx + s, cy + s);
  ctx.moveTo(cx + s, cy - s);
  ctx.lineTo(cx - s, cy + s);
  ctx.strokeStyle = `rgba(${rgb},${alpha})`;
  ctx.lineWidth = 1;
  ctx.lineCap = "round";
  ctx.stroke();
}

function getEdgeY(x: number, H: number, time: number, scale: number) {
  const baseY = H * 0.5;
  const px = (x * 0.0008) / scale;
  const t = time * 0.15;
  let y = baseY;
  y += H * 0.12 * Math.sin(px * 5.1 + t * 1.0 + Math.sin(t * 0.7) * 2);
  y += H * 0.08 * Math.sin(px * 8.7 + t * 1.3 + Math.sin(t * 0.4) * 3);
  y += H * 0.06 * Math.sin(px * 14.3 + t * 0.8 + Math.sin(t * 1.1) * 1.5);
  y += H * 0.04 * Math.sin(px * 3.1 + t * 2.1);
  y += H * 0.08 * Math.sin(t * 0.3);
  return y;
}

interface WaveRibbonProps {
  className?: string;
  /** Multiplier on the wave drift speed. The full-page pace (1) reads as
   * static in a small strip that is only glanced at for a few seconds. */
  speed?: number;
  /** Zooms the whole pattern (grid spacing, X size, band thickness, and
   * spatial wavelength together). 1 is the full-page hero scale; small
   * containers need < 1 so the ribbon fits and its edges can undulate. */
  scale?: number;
}

function WaveRibbonInner({
  className,
  speed = 1,
  scale = 1,
}: WaveRibbonProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const isDarkRef = useRef(isDark);

  useEffect(() => {
    isDarkRef.current = isDark;
  }, [isDark]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const targetCanvas = canvas;
    const parentElement = parent;
    const context = ctx;

    let W = 0;
    let H = 0;
    let animId = 0;
    let time = 0;
    let last = performance.now();

    function renderFrame(frameTime: number) {
      context.clearRect(0, 0, W, H);

      const rgb = isDarkRef.current ? "255,255,255" : "0,0,0";
      const spacing = SPACING * scale;
      const arm = X_ARM * scale;
      const band = BAND * scale;

      for (let x = spacing; x < W; x += spacing) {
        const edgeY = getEdgeY(x, H, frameTime, scale);

        for (let y = spacing; y < H; y += spacing) {
          const dist = Math.abs(y - edgeY);
          if (dist < band) {
            drawX(context, x, y, arm, 0.12, rgb);
          }
        }
      }
    }

    function resize() {
      const dpr = window.devicePixelRatio || 1;
      W = parentElement.clientWidth;
      H = parentElement.clientHeight;
      targetCanvas.width = W * dpr;
      targetCanvas.height = H * dpr;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      renderFrame(time);
    }

    function draw(now: number) {
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      time += dt * speed;

      renderFrame(time);

      animId = requestAnimationFrame(draw);
    }

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parentElement);

    const prefersReducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (prefersReducedMotion) {
      renderFrame(0);
    } else {
      animId = requestAnimationFrame(draw);
    }

    return () => {
      cancelAnimationFrame(animId);
      observer.disconnect();
    };
  }, [speed, scale]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: "block", width: "100%", height: "100%" }}
    />
  );
}

export const WaveRibbon = memo(WaveRibbonInner);

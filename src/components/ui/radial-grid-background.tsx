'use client';

import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

interface RadialGridBackgroundProps {
  className?: string;
  spacing?: number;
}

interface Pulse {
  x: number;
  y: number;
  age: number;
  duration: number;
  maxRadius: number;
}

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

export function RadialGridBackground({
  className,
  spacing = 28,
}: RadialGridBackgroundProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const pointsRef = useRef<Array<{ x: number; y: number }>>([]);
  const pulsesRef = useRef<Pulse[]>([]);
  const sizeRef = useRef({ width: 0, height: 0 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const parent = canvas.parentElement;
    if (!parent) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = clamp(window.devicePixelRatio || 1, 1, 2);
    const points = pointsRef.current;
    const pulses = pulsesRef.current;

    const resize = () => {
      const { width, height } = parent.getBoundingClientRect();
      sizeRef.current = { width, height };
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      rebuildGrid(width, height);
    };

    const rebuildGrid = (width: number, height: number) => {
      points.length = 0;
      const startX = -spacing;
      const startY = -spacing;
      const endX = width + spacing;
      const endY = height + spacing;
      for (let y = startY; y <= endY; y += spacing) {
        for (let x = startX; x <= endX; x += spacing) {
          points.push({ x, y });
        }
      }
    };

    const spawnPulse = () => {
      const { width, height } = sizeRef.current;
      if (!width || !height) return;

      pulses.push({
        x: Math.random() * width,
        y: Math.random() * height,
        age: 0,
        duration: 2500 + Math.random() * 2000,
        maxRadius: Math.min(width, height) * (0.3 + Math.random() * 0.4),
      });
    };

    // Spawn initial pulses
    for (let i = 0; i < 2; i++) {
      setTimeout(() => spawnPulse(), i * 800);
    }

    // Spawn new pulses periodically
    const spawnInterval = setInterval(() => {
      if (pulses.length < 3) {
        spawnPulse();
      }
    }, 1500);

    let lastTime = 0;
    const draw = (time: number) => {
      const delta = lastTime ? time - lastTime : 16;
      lastTime = time;

      const { width, height } = sizeRef.current;
      if (!width || !height) {
        animationRef.current = requestAnimationFrame(draw);
        return;
      }

      // Get theme color
      const computedStyle = getComputedStyle(parent);
      const color =
        computedStyle.getPropertyValue('--foreground')?.trim() ||
        'oklch(0.141 0.005 285.823)';

      // Subtle drift
      const driftX = Math.sin(time * 0.0003) * 4;
      const driftY = Math.cos(time * 0.00025) * 4;

      // Update pulses
      for (let i = pulses.length - 1; i >= 0; i--) {
        pulses[i].age += delta;
        if (pulses[i].age > pulses[i].duration) {
          pulses.splice(i, 1);
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.lineCap = 'round';

      for (let i = 0; i < points.length; i++) {
        const basePoint = points[i];
        const px = basePoint.x + driftX;
        const py = basePoint.y + driftY;

        // Calculate combined influence from all pulses
        let maxInfluence = 0;
        let influenceAngle = 0;

        for (const pulse of pulses) {
          const dx = px - pulse.x;
          const dy = py - pulse.y;
          const dist = Math.hypot(dx, dy);

          // Pulse expands then contracts
          const progress = pulse.age / pulse.duration;
          const envelope = Math.sin(progress * Math.PI); // 0 -> 1 -> 0
          const currentRadius = pulse.maxRadius * envelope;

          if (dist < currentRadius) {
            const falloff = 1 - dist / currentRadius;
            const influence = falloff * falloff * envelope;
            if (influence > maxInfluence) {
              maxInfluence = influence;
              influenceAngle = Math.atan2(dy, dx);
            }
          }
        }

        if (maxInfluence < 0.05) {
          // Resting dots
          const radius = 1.25;
          ctx.globalAlpha = 0.4;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(px * dpr, py * dpr, radius * dpr, 0, Math.PI * 2);
          ctx.fill();
          continue;
        }

        // Lines that radiate away from pulse center
        const length = 6 + maxInfluence * 14;
        const half = length / 2;
        const cos = Math.cos(influenceAngle);
        const sin = Math.sin(influenceAngle);
        const startX = (px - cos * half) * dpr;
        const startY = (py - sin * half) * dpr;
        const endX = (px + cos * half) * dpr;
        const endY = (py + sin * half) * dpr;

        ctx.globalAlpha = 0.35 + maxInfluence * 0.5;
        ctx.lineWidth = (1 + maxInfluence * 1.5) * dpr;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      animationRef.current = requestAnimationFrame(draw);
    };

    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(parent);
    animationRef.current = requestAnimationFrame(draw);

    return () => {
      resizeObserver.disconnect();
      clearInterval(spawnInterval);
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [spacing]);

  return (
    <div className={cn('absolute inset-0 overflow-hidden bg-background', className)}>
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}

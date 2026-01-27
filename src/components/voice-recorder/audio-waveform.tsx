'use client';

import { useRef, useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

interface AudioWaveformProps {
  analyser: AnalyserNode | null;
  barCount?: number;
  className?: string;
}

export function AudioWaveform({
  analyser,
  barCount = 72,
  className,
}: AudioWaveformProps) {
  const noiseFloor = 0.006;
  const gain = 3.8;
  const curve = 0.5;
  const minLevel = 0.02;
  const smoothing = 0.85;
  const intervalMs = 40;
  const jitterAmount = 0.02;

  const baseline = useRef<number[]>(Array(barCount).fill(minLevel));
  const [levels, setLevels] = useState<number[]>(() => Array(barCount).fill(minLevel));
  const historyRef = useRef<number[]>(Array(barCount).fill(minLevel));
  const previousAmplitudeRef = useRef<number>(minLevel);
  const floatBufferRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const byteBufferRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    const baseLevels = Array(barCount).fill(minLevel);
    baseline.current = baseLevels;
    historyRef.current = baseLevels.slice();
    previousAmplitudeRef.current = minLevel;
    setLevels(baseLevels);
  }, [barCount]);

  useEffect(() => {
    if (!analyser) {
      setLevels(baseline.current.slice());
      return;
    }

    if (!floatBufferRef.current || floatBufferRef.current.length !== analyser.fftSize) {
      floatBufferRef.current = new Float32Array(analyser.fftSize);
    }
    if (!byteBufferRef.current || byteBufferRef.current.length !== analyser.fftSize) {
      byteBufferRef.current = new Uint8Array(analyser.fftSize);
    }

    const tick = () => {
      const floatBuffer = floatBufferRef.current;
      const byteBuffer = byteBufferRef.current;
      if (!floatBuffer || !byteBuffer) return;

      let sumSquares = 0;

      if (typeof analyser.getFloatTimeDomainData === 'function') {
        analyser.getFloatTimeDomainData(floatBuffer);
        for (let i = 0; i < floatBuffer.length; i += 1) {
          const sample = floatBuffer[i];
          sumSquares += sample * sample;
        }
      } else {
        analyser.getByteTimeDomainData(byteBuffer);
        for (let i = 0; i < byteBuffer.length; i += 1) {
          const sample = (byteBuffer[i] - 128) / 128;
          sumSquares += sample * sample;
        }
      }

      const rms = Math.sqrt(sumSquares / (floatBuffer.length || 1));
      let amplitude = rms <= noiseFloor ? 0 : (rms - noiseFloor) / (1 - noiseFloor);
      amplitude = Math.min(1, amplitude * gain);
      amplitude = Math.pow(amplitude, curve);
      amplitude = Math.max(minLevel, amplitude);

      const smoothed = previousAmplitudeRef.current * smoothing + amplitude * (1 - smoothing);
      previousAmplitudeRef.current = smoothed;

      const history = historyRef.current.length === barCount
        ? historyRef.current
        : Array(barCount).fill(minLevel);
      historyRef.current = history;
      history.shift();
      history.push(smoothed);
      const jittered = history.map((level, index) => {
        const age = (barCount - index) / barCount;
        const noise = (Math.random() - 0.5) * jitterAmount * age;
        return Math.max(minLevel, Math.min(1, level + noise));
      });
      setLevels(jittered);
    };

    const intervalId = window.setInterval(tick, intervalMs);
    tick();

    return () => window.clearInterval(intervalId);
  }, [analyser, barCount]);

  return (
    <div
      className={cn('grid items-center w-full gap-[2px]', className)}
      style={{ gridTemplateColumns: `repeat(${barCount}, minmax(0, 1fr))` }}
      aria-hidden="true"
    >
      {levels.map((level, i) => (
        <div
          key={i}
          className="w-full bg-foreground/60 rounded-full transition-[height] duration-75"
          style={{
            height: `${level * 100}%`,
            minHeight: '2px',
          }}
        />
      ))}
    </div>
  );
}

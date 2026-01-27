# Speech-to-Text Recorder Restyle Plan

This document outlines the design and implementation plan for improving the styling of the speech-to-text recorder in the chat input field.

---

## Problem Statement

The current voice recording UI is minimal and functional but lacks visual polish:

1. **No audio visualization** - Users can't see if their voice is being picked up
2. **No elapsed time display** - Users don't know how long they've been recording
3. **Ambiguous actions** - The single mic button toggles states but doesn't clearly communicate intent
4. **Generic styling** - Recording state uses basic pulse animation without distinctive UI treatment

**Goal:** Create an engaging, intuitive recording experience with audio-reactive visualization, clear timing feedback, and distinct action buttons for cancel/confirm.

---

## Reference Design Analysis

The reference screenshot shows a recording UI from another app with these key elements:

```
┌────────────────────────────────────────────────────────────────────────┐
│  ╭───╮                                                        ╭───╮   │
│  │ X │  ·║·····│·││·│││·║║│·║│·││·│··║║│·││·││··   0:02       │ ✓ │   │
│  ╰───╯                                                        ╰───╯   │
└────────────────────────────────────────────────────────────────────────┘
```

**Key elements identified:**
- **Cancel button (X)** - Circular button on left to discard recording
- **Audio waveform** - Live visualization that responds to voice amplitude
- **Elapsed time** - "0:02" format showing recording duration
- **Confirm button (✓)** - Circular button on right to finish and transcribe
- **Contained layout** - Everything inside a pill-shaped container

---

## Design Decisions

### 1. Inline Recording Bar Approach

When recording is active, replace the bottom button row with a recording bar. The textarea remains visible above, preserving context.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ Normal State (idle):                                                        │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                                                                         │ │
│ │   Type a message...                                                     │ │
│ │                                                                         │ │
│ ├─────────────────────────────────────────────────────────────────────────┤ │
│ │  [+] [🎤]                                                          [→]  │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ Recording State (button row transforms):                                    │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                                                                         │ │
│ │   Type a message...                                          (dimmed)   │ │
│ │                                                                         │ │
│ ├─────────────────────────────────────────────────────────────────────────┤ │
│ │  [X]  ▁▂▃▅▇▅▃▂▁▂▄▆▇▆▄▂▁▃▅▇▅▃▁  0:05                              [✓]  │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ Warming Up State:                                                           │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                                                                         │ │
│ │   Type a message...                                          (dimmed)   │ │
│ │                                                                         │ │
│ ├─────────────────────────────────────────────────────────────────────────┤ │
│ │  [X]       ◌ Listening...                                         [ ]  │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│ Transcribing State:                                                         │
│ ┌─────────────────────────────────────────────────────────────────────────┐ │
│ │                                                                         │ │
│ │   Type a message...                                          (dimmed)   │ │
│ │                                                                         │ │
│ ├─────────────────────────────────────────────────────────────────────────┤ │
│ │              ◌ Transcribing...                                          │ │
│ └─────────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Why inline replacement:**
- Less jarring - textarea stays visible, only the button row transforms
- Context preserved - if user typed something before recording, they can still see it
- Matches the reference screenshot's compact inline style
- Simpler implementation - swap contents of the bottom `InputGroupAddon` only

### 2. Audio Waveform Visualization

Use the existing `AnalyserNode` from `useVoiceRecording` to drive a real-time waveform:

- **Bar count:** 32-48 bars across the width
- **Update rate:** ~60fps via `requestAnimationFrame`
- **Amplitude mapping:** FFT frequency data → bar heights
- **Visual style:** Thin vertical bars with rounded caps, subtle gradient or solid color
- **Color:** Muted foreground when quiet, accent color when active signal detected

### 3. Elapsed Time Display

- **Format:** `M:SS` (e.g., "0:05", "1:23")
- **Position:** Right of waveform, left of confirm button
- **Typography:** Tabular numbers (`font-variant-numeric: tabular-nums`) for stable width
- **Color:** `text-muted-foreground`

### 4. Action Buttons

| Button | Icon | Variant | Behavior |
|--------|------|---------|----------|
| Cancel | `X` | Ghost with subtle background | Discards recording, returns to idle |
| Confirm | `Check` | Primary/accent | Stops recording, begins transcription |

Button styling:
- Size: `size-8` (32px) circular
- Cancel: `bg-muted/80 hover:bg-muted text-muted-foreground`
- Confirm: `bg-primary text-primary-foreground` or accent blue

### 5. Warming Up State

Brief state while detecting mic signal (shown in ASCII above):

- Cancel button active (X) on left
- Spinner + "Listening..." text centered
- Confirm button disabled (grayed out or hidden) on right
- Textarea above is dimmed but visible

### 6. Visual Styling

Following existing design patterns:
- **Container:** Same `rounded-2xl` as the input group
- **Background:** `bg-muted/30` or subtle surface treatment
- **Border:** Match input border styling
- **Shadow:** Same shadow treatment as focused input
- **Animation:** Smooth transitions between states (200ms ease-out)

---

## Component Architecture

### New Components

```
src/components/
├── voice-recorder/
│   ├── index.tsx                    # Main export
│   ├── voice-recorder-bar.tsx       # Inline recording bar (replaces button row)
│   ├── audio-waveform.tsx           # Animated waveform visualization
│   └── recording-timer.tsx          # Elapsed time display
```

### Component Hierarchy

```tsx
{/* Inside PromptInput's bottom InputGroupAddon */}
{isActiveRecording ? (
  <VoiceRecorderBar
    analyser={analyser}
    recordingStartTime={recordingStartTime}
    isWarmingUp={isWarmingUp}
    isTranscribing={isTranscribing}
    onCancel={cancelRecording}
    onConfirm={stopRecording}
  />
) : (
  <>
    {/* Normal button row: [+] [🎤] ... [→] */}
    <div className="flex items-center gap-1">
      <PlusButton />
      <MicButton />
    </div>
    <SubmitButton />
  </>
)}
```

### Props Interfaces

```typescript
// voice-recorder-bar.tsx
interface VoiceRecorderBarProps {
  analyser: AnalyserNode | null;
  recordingStartTime: number | null;
  isWarmingUp: boolean;
  isTranscribing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  className?: string;
}

// audio-waveform.tsx
interface AudioWaveformProps {
  analyser: AnalyserNode;
  barCount?: number;        // Default: 40
  className?: string;
}

// recording-timer.tsx
interface RecordingTimerProps {
  startTime: number;        // Date.now() when recording started
  className?: string;
}
```

---

## Hook Modifications

### Changes to `useVoiceRecording`

The hook needs to expose additional data for the UI:

```typescript
interface UseVoiceRecordingReturn {
  state: VoiceRecordingState;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  cancelRecording: () => void;
  isSupported: boolean;
  // NEW: For waveform visualization
  analyser: AnalyserNode | null;
  // NEW: For elapsed time
  recordingStartTime: number | null;
}
```

**Implementation changes:**
1. Store `analyserNode` in a ref and expose it
2. Track `recordingStartTime` when entering 'recording' state
3. Keep `AnalyserNode` connected during recording (currently disconnected after warm-up)

---

## Integration with PromptInput

### Conditional Rendering in Bottom Addon

The key change is in the bottom `InputGroupAddon`. Instead of always showing `[+] [🎤] ... [→]`, we conditionally render the recording bar:

```tsx
// prompt-input.tsx
const isActiveRecording = isWarmingUp || isRecording;

// Inside the InputGroup...
<InputGroupAddon align="block-end" className="justify-between pb-3 px-3">
  {isActiveRecording || isTranscribing ? (
    <VoiceRecorderBar
      analyser={analyser}
      recordingStartTime={recordingStartTime}
      isWarmingUp={isWarmingUp}
      isTranscribing={isTranscribing}
      onCancel={cancelRecording}
      onConfirm={stopRecording}
    />
  ) : (
    <>
      {/* Left side buttons: Plus and Mic */}
      <div className="flex items-center gap-1">
        {showFileUpload && <PlusButton ... />}
        {showVoiceButton && <MicButton ... />}
      </div>

      {/* Submit/Stop button */}
      <SubmitButton ... />
    </>
  )}
</InputGroupAddon>
```

### Textarea Dimming During Recording

When recording is active, the textarea should be visually dimmed to indicate it's not the focus:

```tsx
<InputGroupTextarea
  value={value}
  onChange={(e) => onChange(e.target.value)}
  onKeyDown={handleKeyDown}
  placeholder={placeholder}
  disabled={disabled || isActiveRecording}  // Disable during recording
  className={cn(
    "text-base p-3.5 max-h-96 overflow-y-auto",
    isActiveRecording && "opacity-50"  // Dim during recording
  )}
/>
```

---

## Detailed Component Specifications

### VoiceRecorderBar

```tsx
// src/components/voice-recorder/voice-recorder-bar.tsx
'use client';

import { cn } from '@/lib/utils';
import { X, Check, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AudioWaveform } from './audio-waveform';
import { RecordingTimer } from './recording-timer';

interface VoiceRecorderBarProps {
  analyser: AnalyserNode | null;
  recordingStartTime: number | null;
  isWarmingUp: boolean;
  isTranscribing: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  className?: string;
}

export function VoiceRecorderBar({
  analyser,
  recordingStartTime,
  isWarmingUp,
  isTranscribing,
  onCancel,
  onConfirm,
  className,
}: VoiceRecorderBarProps) {
  // Transcribing state - centered spinner
  if (isTranscribing) {
    return (
      <div className={cn('flex-1 flex items-center justify-center gap-2', className)}>
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
        <span className="text-sm text-muted-foreground">Transcribing...</span>
      </div>
    );
  }

  return (
    <div className={cn('flex-1 flex items-center gap-2', className)}>
      {/* Cancel button */}
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onCancel}
        className="size-8 rounded-full bg-muted/80 hover:bg-muted text-muted-foreground shrink-0"
        aria-label="Cancel recording"
      >
        <X className="size-4" />
      </Button>

      {/* Center content */}
      <div className="flex-1 flex items-center justify-center gap-3 min-w-0">
        {isWarmingUp ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            <span className="text-sm">Listening...</span>
          </div>
        ) : (
          <>
            <AudioWaveform
              analyser={analyser}
              className="flex-1 h-6 min-w-0"
            />
            <RecordingTimer
              startTime={recordingStartTime}
              className="shrink-0 text-sm text-muted-foreground tabular-nums"
            />
          </>
        )}
      </div>

      {/* Confirm button */}
      <Button
        type="button"
        variant="default"
        size="icon"
        onClick={onConfirm}
        disabled={isWarmingUp}
        className={cn(
          'size-8 rounded-full shrink-0',
          isWarmingUp && 'opacity-50 cursor-not-allowed'
        )}
        aria-label="Finish recording"
      >
        <Check className="size-4" />
      </Button>
    </div>
  );
}
```

### AudioWaveform

```tsx
// src/components/voice-recorder/audio-waveform.tsx
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
  barCount = 40,
  className,
}: AudioWaveformProps) {
  const [levels, setLevels] = useState<number[]>(() => Array(barCount).fill(0.1));
  const animationRef = useRef<number>();

  useEffect(() => {
    if (!analyser) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    const updateLevels = () => {
      analyser.getByteFrequencyData(dataArray);

      // Map frequency bins to bar count
      const binSize = Math.floor(dataArray.length / barCount);
      const newLevels = Array(barCount).fill(0).map((_, i) => {
        const start = i * binSize;
        const end = start + binSize;
        let sum = 0;
        for (let j = start; j < end; j++) {
          sum += dataArray[j];
        }
        // Normalize to 0-1 range with minimum height
        return Math.max(0.1, (sum / binSize) / 255);
      });

      setLevels(newLevels);
      animationRef.current = requestAnimationFrame(updateLevels);
    };

    updateLevels();

    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [analyser, barCount]);

  return (
    <div
      className={cn('flex items-center justify-center gap-px', className)}
      aria-hidden="true"
    >
      {levels.map((level, i) => (
        <div
          key={i}
          className="w-0.5 bg-foreground/60 rounded-full transition-all duration-75"
          style={{
            height: `${level * 100}%`,
            minHeight: '2px',
          }}
        />
      ))}
    </div>
  );
}
```

### RecordingTimer

```tsx
// src/components/voice-recorder/recording-timer.tsx
'use client';

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';

interface RecordingTimerProps {
  startTime: number | null;
  className?: string;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function RecordingTimer({ startTime, className }: RecordingTimerProps) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!startTime) {
      setElapsed(0);
      return;
    }

    // Update immediately
    setElapsed(Math.floor((Date.now() - startTime) / 1000));

    // Then update every second
    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000));
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  return (
    <span className={cn('font-mono', className)}>
      {formatTime(elapsed)}
    </span>
  );
}
```

---

## Animation & Transitions

### Waveform Animation

- Bars use CSS transitions for smooth height changes: `transition-all duration-75`
- Slight ease-out for natural feel
- Minimum bar height (10%) prevents visual "collapse" when silent

### Button Feedback

- Standard shadcn button hover/active states
- Confirm button has subtle scale on press: `active:scale-95`

### State Transition

- The swap between normal buttons and recording bar should feel instant
- No complex enter/exit animations needed since the layout position stays the same

---

## Implementation Phases

### Phase 1: Hook Modifications

1. Update `useVoiceRecording` to expose `analyser` and `recordingStartTime`
2. Keep `AnalyserNode` connected during recording (not just warm-up)
3. Test that existing functionality still works

### Phase 2: Core Components

1. Create `voice-recorder/` directory structure
2. Implement `AudioWaveform` component with analyser integration
3. Implement `RecordingTimer` component
4. Implement `VoiceRecorderBar` container

### Phase 3: Integration

1. Update `PromptInput` bottom `InputGroupAddon` to conditionally render `VoiceRecorderBar`
2. Add textarea dimming when recording is active
3. Test all recording states (idle → warming → recording → transcribing → idle)

### Phase 4: Polish

1. Fine-tune waveform sensitivity and bar count
2. Adjust animation timing
3. Test on mobile (touch targets, responsive layout)
4. Verify dark/light mode appearance
5. Add keyboard accessibility (Escape to cancel)

---

## Acceptance Criteria

### Visual
- [ ] Recording bar replaces normal buttons when mic is clicked
- [ ] Textarea remains visible above, but is dimmed during recording
- [ ] Waveform animates in response to voice input
- [ ] Elapsed time increments every second in M:SS format
- [ ] Cancel (X) and confirm (checkmark) buttons are clearly visible
- [ ] Warming up state shows spinner with "Listening..." text
- [ ] Transcribing state shows centered loading indicator
- [ ] All states work in both light and dark mode

### Behavior
- [ ] Cancel button discards recording and returns to idle (normal buttons reappear)
- [ ] Confirm button stops recording and begins transcription
- [ ] Pressing Escape key cancels recording (keyboard accessibility)
- [ ] Confirm button is disabled during warm-up phase
- [ ] Transcribed text appends to existing input (existing behavior preserved)

### Integration
- [ ] Recording bar fits naturally in the bottom addon row
- [ ] Attachments above input remain visible during recording
- [ ] Textarea is disabled during recording (no typing)
- [ ] Works with existing voice recording error handling

---

## Testing Checklist

1. **Happy path:** Click mic → wait for waveform → speak → click confirm → see transcribed text
2. **Cancel during warm-up:** Click mic → immediately click X → returns to idle
3. **Cancel during recording:** Click mic → speak → click X → recording discarded
4. **Keyboard cancel:** Click mic → press Escape → recording cancelled
5. **Silent recording:** Click mic → don't speak → confirm → handles empty/short audio gracefully
6. **Long recording:** Record for 2+ minutes → timer displays correctly (e.g., "2:15")
7. **Mobile:** Touch targets are adequate size, layout responsive
8. **Error handling:** Deny mic permission → appropriate error shown

---

## Summary

This plan transforms the minimal voice recording UI into an engaging, polished experience:

- **Audio waveform** provides real-time visual feedback that the mic is working
- **Elapsed timer** gives users confidence about recording length
- **Distinct action buttons** make cancel vs. confirm unambiguous
- **Inline recording bar** replaces the button row without disrupting the textarea above
- **Smooth transitions** between states feel responsive and intentional

The implementation builds on existing infrastructure (the `AnalyserNode` is already created during warm-up) and uses standard shadcn/ui components for consistency with the rest of the app.

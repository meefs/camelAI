'use client';

import { useRef, useState, useCallback } from 'react';
import { ArrowUp, Square, Loader2, Plus, Mic } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { AttachmentList, type Attachment } from '@/components/attachment-list';
import { cn } from '@/lib/utils';
import { useVoiceRecording } from '@/hooks/use-voice-recording';

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  isAssistantRunning?: boolean;
  minHeight?: string;
  className?: string;
  autoFocus?: boolean;
  // File upload props
  attachments?: Attachment[];
  onFilesSelected?: (files: File[]) => void;
  onAttachmentRemove?: (id: string) => void;
  // Voice recording props
  enableVoiceRecording?: boolean;
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  onStop,
  placeholder = 'Type a message...',
  disabled = false,
  isLoading = false,
  isAssistantRunning = false,
  minHeight = '44px',
  className,
  autoFocus = false,
  attachments = [],
  onFilesSelected,
  onAttachmentRemove,
  enableVoiceRecording = true,
}: PromptInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  // Track latest value for voice recording callback
  const valueRef = useRef(value);
  valueRef.current = value;

  // Voice recording
  const {
    state: voiceState,
    startRecording,
    stopRecording,
    cancelRecording,
    isSupported: isVoiceSupported,
  } = useVoiceRecording({
    onTranscript: (text) => {
      // Use ref to get latest value, preserving any edits made during recording
      const currentValue = valueRef.current;
      const newValue = currentValue.trim() ? `${currentValue} ${text}` : text;
      onChange(newValue);
    },
    onError: (error) => {
      console.error('[PromptInput] Voice error:', error);
    },
  });

  const isWarmingUp = voiceState === 'warming_up';
  const isRecording = voiceState === 'recording';
  const isTranscribing = voiceState === 'transcribing';
  const showVoiceButton = enableVoiceRecording && isVoiceSupported;

  // Show stop button when assistant is running and input is empty
  const showStopButton = isAssistantRunning && !value.trim() && onStop;

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) {
        onSubmit();
      }
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (showStopButton) {
      onStop?.();
    } else if (value.trim() && !disabled) {
      onSubmit();
    }
  }

  function handleButtonClick(e: React.MouseEvent) {
    if (showStopButton) {
      e.preventDefault();
      onStop?.();
    }
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0 && onFilesSelected) {
      onFilesSelected(Array.from(files));
    }
    // Reset input so the same file can be selected again
    e.target.value = '';
  }

  function handlePlusClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    fileInputRef.current?.click();
  }

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && onFilesSelected) {
      setIsDragOver(true);
    }
  }, [disabled, onFilesSelected]);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Only set drag over to false if we're leaving the container entirely
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    if (disabled || !onFilesSelected) return;

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      onFilesSelected(Array.from(files));
    }
  }, [disabled, onFilesSelected]);

  const hasUploadingAttachments = attachments.some(a => a.status === 'uploading');
  const isSubmitDisabled = disabled || isLoading || hasUploadingAttachments || isTranscribing || (!showStopButton && !value.trim());
  const showFileUpload = !!onFilesSelected;

  function handleMicClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (isRecording) {
      stopRecording();
    } else if (isWarmingUp) {
      cancelRecording();
    } else {
      startRecording();
    }
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      {/* Hidden file input */}
      {showFileUpload && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={handleFileInputChange}
          className="hidden"
          aria-hidden="true"
        />
      )}

      <div
        onDragOver={showFileUpload ? handleDragOver : undefined}
        onDragLeave={showFileUpload ? handleDragLeave : undefined}
        onDrop={showFileUpload ? handleDrop : undefined}
        className={cn(
          'relative rounded-2xl transition-all duration-200',
          isDragOver && 'ring-2 ring-primary ring-offset-2'
        )}
      >
        {/* Drag overlay */}
        {isDragOver && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-primary/10 border-2 border-dashed border-primary">
            <span className="text-sm font-medium text-primary">Drop files here</span>
          </div>
        )}

        <InputGroup className="rounded-2xl border-border bg-background cursor-text shadow-sm hover:shadow-md focus-within:shadow-md focus-within:border-ring transition-all duration-200">
          {/* Attachment list above textarea */}
          {attachments.length > 0 && onAttachmentRemove && (
            <InputGroupAddon align="block-start" className="border-b border-border">
              <AttachmentList
                attachments={attachments}
                onRemove={onAttachmentRemove}
                className="px-0"
              />
            </InputGroupAddon>
          )}

          <InputGroupTextarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            className="text-base p-3.5 max-h-96 overflow-y-auto"
            style={{ minHeight }}
          />

          <InputGroupAddon align="block-end" className="justify-between pb-3 px-3">
            {/* Left side buttons: Plus and Mic */}
            <div className="flex items-center gap-1">
              {/* Plus button for file upload */}
              {showFileUpload && (
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={handlePlusClick}
                  disabled={disabled || isRecording || isTranscribing}
                  className="rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
                  aria-label="Attach file"
                >
                  <Plus className="size-4" />
                </InputGroupButton>
              )}

              {/* Microphone button for voice recording */}
              {showVoiceButton && (
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={handleMicClick}
                  disabled={disabled || isTranscribing}
                  className={cn(
                    'rounded-full text-muted-foreground hover:text-foreground hover:bg-muted',
                    isWarmingUp && 'text-amber-500 hover:text-amber-500 animate-pulse bg-amber-500/10',
                    isRecording && 'text-destructive hover:text-destructive animate-pulse bg-destructive/10'
                  )}
                  aria-label={isRecording ? 'Stop recording' : isWarmingUp ? 'Cancel' : 'Start voice recording'}
                >
                  {isTranscribing || isWarmingUp ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Mic className="size-4" />
                  )}
                </InputGroupButton>
              )}
            </div>

            {/* Submit/Stop button */}
            <InputGroupButton
              type={showStopButton ? 'button' : 'submit'}
              size="icon-sm"
              variant={showStopButton ? 'destructive' : 'default'}
              disabled={isSubmitDisabled}
              onClick={handleButtonClick}
              className="rounded-full"
            >
              {isLoading ? (
                <Loader2 className="size-4 animate-spin" />
              ) : showStopButton ? (
                <Square className="size-3" />
              ) : (
                <ArrowUp className="size-4" />
              )}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
      </div>
    </form>
  );
}

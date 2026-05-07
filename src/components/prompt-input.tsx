'use client';

import { memo, useMemo, useRef, useState, useCallback, useEffect } from 'react';
import { ArrowUp, Square, Loader2, Plus, Mic } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';
import { AttachmentList, type Attachment } from '@/components/attachment-list';
import { ContextIndicator } from '@/components/context-indicator';
import { VoiceRecorderBar } from '@/components/voice-recorder';
import { cn } from '@/lib/utils';
import { useVoiceRecording } from '@/hooks/use-voice-recording';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { LLM_MODEL_OPTIONS } from '@/lib/llm-provider-config';
import { ModelPicker } from '@/components/model-picker';
import {
  modelCatalogEntriesForIds,
  type ModelCatalogEntry,
} from '@/lib/model-catalog';
import type { RecentModelScope } from '@/lib/recent-model';
import type { Integration, LlmModel } from '@/types';
import { ConnectionMentionMenu } from '@/components/connection-mention-menu';
import { ComposerMentionDecorations } from '@/components/connection-mention-menu/composer-mention-overlay';
import { useMentionTrigger } from '@/components/connection-mention-menu/use-mention-trigger';
import {
  buildSlugMap,
  filterMentionableConnections,
  rankMentionableConnections,
  slugForIntegration,
} from '@/lib/connection-mentions';

interface PromptInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop?: () => void;
  placeholder?: string;
  animatedPlaceholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  isAssistantRunning?: boolean;
  minHeight?: string;
  className?: string;
  autoFocus?: boolean;
  onFocus?: () => void;
  onBlur?: () => void;
  // File upload props
  attachments?: Attachment[];
  onFilesSelected?: (files: File[]) => void;
  onAttachmentRemove?: (id: string) => void;
  // Voice recording props
  enableVoiceRecording?: boolean;
  // Context indicator props
  contextUsedPercent?: number | null;
  onCompact?: () => void;
  model?: LlmModel;
  onModelChange?: (model: LlmModel) => void;
  modelOptions?: ReadonlyArray<ModelCatalogEntry>;
  modelDisabled?: boolean;
  isOrgAdmin?: boolean;
  recentModelScope?: RecentModelScope | null;
  // Ref for programmatic focus
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  // @-mention menu for configured connections
  mentionableConnections?: Integration[];
  onMentionAddNewClick?: () => void;
  mentionMenuSide?: 'top' | 'bottom';
}

interface SendButtonProps {
  showStopButton: boolean;
  isSubmitDisabled: boolean;
  isLoading: boolean;
  onClick: (e: React.MouseEvent) => void;
}

const LONG_PASTE_CHAR_THRESHOLD = 8_000;
const DEFAULT_MODEL_OPTIONS = modelCatalogEntriesForIds(
  LLM_MODEL_OPTIONS.map((option) => option.value),
);

const MemoizedSendButton = memo(function MemoizedSendButton({
  showStopButton,
  isSubmitDisabled,
  isLoading,
  onClick,
}: SendButtonProps) {
  return (
    <InputGroupButton
      type={showStopButton ? 'button' : 'submit'}
      size="icon-sm"
      variant={showStopButton ? 'destructive' : 'default'}
      disabled={isSubmitDisabled}
      onClick={onClick}
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
  );
});

export function PromptInput({
  value,
  onChange,
  onSubmit,
  onStop,
  placeholder = 'Type a message...',
  animatedPlaceholder,
  disabled = false,
  isLoading = false,
  isAssistantRunning = false,
  minHeight = '44px',
  className,
  autoFocus = false,
  onFocus,
  onBlur,
  attachments = [],
  onFilesSelected,
  onAttachmentRemove,
  enableVoiceRecording = true,
  contextUsedPercent,
  onCompact,
  model,
  onModelChange,
  modelOptions = DEFAULT_MODEL_OPTIONS,
  modelDisabled = false,
  isOrgAdmin = false,
  recentModelScope,
  textareaRef,
  mentionableConnections,
  onMentionAddNewClick,
  mentionMenuSide = 'top',
}: PromptInputProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const onStopRef = useRef(onStop);
  onStopRef.current = onStop;

  // @-mention state
  const internalTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const effectiveTextareaRef = textareaRef ?? internalTextareaRef;
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [caretPos, setCaretPos] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const [isComposing, setIsComposing] = useState(false);
  const [activeMentionId, setActiveMentionId] = useState<string | null>(null);
  const textareaWrapperRef = useRef<HTMLDivElement | null>(null);
  const [textareaScroll, setTextareaScroll] = useState({ top: 0, left: 0 });

  const mentionableConnectionList = useMemo(
    () => filterMentionableConnections(mentionableConnections ?? []),
    [mentionableConnections],
  );
  const mentionsEnabled = mentionableConnectionList.length > 0
    || onMentionAddNewClick !== undefined;
  const mentionTrigger = useMentionTrigger({
    value,
    caretPos,
    enabled: mentionsEnabled && isFocused && !isComposing && !disabled,
  });
  const mentionMenuOpen = mentionTrigger.open;

  const slugMap = useMemo(
    () => buildSlugMap(mentionableConnectionList) as Map<string, Integration>,
    [mentionableConnectionList],
  );

  const filteredMentionConnections = useMemo(() => {
    return rankMentionableConnections(
      mentionableConnectionList,
      mentionTrigger.query,
    );
  }, [mentionableConnectionList, mentionTrigger.query]);

  // Escape (or outside-click) closes the menu but the trigger conditions
  // still hold, so we lock out re-opening until the user types or moves the
  // caret away.
  const mentionLockoutValueRef = useRef<string | null>(null);
  const mentionLockoutCaretRef = useRef<number>(-1);

  const closeMentionMenu = useCallback(() => {
    setActiveMentionId(null);
    const ta = effectiveTextareaRef.current;
    if (ta) {
      mentionLockoutValueRef.current = ta.value;
      mentionLockoutCaretRef.current = ta.selectionStart ?? 0;
    }
  }, [effectiveTextareaRef]);
  const isLockedOut = mentionLockoutValueRef.current === value
    && mentionLockoutCaretRef.current === caretPos;
  const hasAnyConnections = mentionableConnectionList.length > 0;
  const hasMatches = filteredMentionConnections.length > 0;
  // When the user has connections but no match for their current query, hide
  // the menu — Slack-style.
  const matchesAvailable = !hasAnyConnections || hasMatches;
  const effectiveMenuOpen = mentionMenuOpen && !isLockedOut && matchesAvailable;

  const insertMention = useCallback((connection: Integration) => {
    if (!mentionTrigger.open) return;
    const computedSlug = slugForIntegration(connection, slugMap);
    if (!computedSlug) return;
    const before = value.slice(0, mentionTrigger.triggerStart);
    const after = value.slice(mentionTrigger.triggerEnd);
    const insertion = `@${computedSlug} `;
    const nextValue = `${before}${insertion}${after}`;
    onChange(nextValue);

    const nextCaret = before.length + insertion.length;
    mentionLockoutValueRef.current = nextValue;
    mentionLockoutCaretRef.current = nextCaret;
    requestAnimationFrame(() => {
      const ta = effectiveTextareaRef.current;
      if (!ta) return;
      ta.selectionStart = nextCaret;
      ta.selectionEnd = nextCaret;
      setCaretPos(nextCaret);
    });
  }, [mentionTrigger, slugMap, value, onChange, effectiveTextareaRef]);

  const updateCaretPos = useCallback(() => {
    const ta = effectiveTextareaRef.current;
    if (!ta) return;
    setCaretPos(ta.selectionStart ?? 0);
  }, [effectiveTextareaRef]);

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
    analyser,
    recordingStartTime,
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
  const isActiveRecording = isWarmingUp || isRecording;
  const showVoiceButton = enableVoiceRecording && isVoiceSupported;

  // Show stop button when assistant is running and input is empty
  const showStopButton = Boolean(isAssistantRunning && !value.trim() && onStop);
  const effectivePlaceholder = animatedPlaceholder ?? placeholder;
  const hasUploadingAttachments = attachments.some(a => a.status === 'uploading');
  const hasCompletedAttachments = attachments.some(a => a.status === 'complete');

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!onFilesSelected || disabled) return;

    const files = Array.from(e.clipboardData.files);
    if (files.length > 0) {
      e.preventDefault();
      onFilesSelected(files);
      return;
    }

    const pastedText = e.clipboardData.getData('text/plain');
    if (pastedText && pastedText.length > LONG_PASTE_CHAR_THRESHOLD) {
      e.preventDefault();
      onFilesSelected([
        new File([pastedText], 'pasted-text.txt', { type: 'text/plain' }),
      ]);
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Menu key handling — ↑/↓/Enter/Tab/Escape are intercepted while open.
    if (effectiveMenuOpen && filteredMentionConnections.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const idx = filteredMentionConnections.findIndex((c) => c.id === activeMentionId);
        const nextIdx = idx === -1 ? 0 : (idx + 1) % filteredMentionConnections.length;
        setActiveMentionId(filteredMentionConnections[nextIdx]!.id);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const idx = filteredMentionConnections.findIndex((c) => c.id === activeMentionId);
        const prevIdx = idx <= 0 ? filteredMentionConnections.length - 1 : idx - 1;
        setActiveMentionId(filteredMentionConnections[prevIdx]!.id);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        const target = filteredMentionConnections.find((c) => c.id === activeMentionId)
          ?? filteredMentionConnections[0]!;
        e.preventDefault();
        insertMention(target);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionMenu();
        return;
      }
    }

    if (effectiveMenuOpen && mentionableConnectionList.length === 0) {
      if (e.key === 'Enter') {
        e.preventDefault();
        onMentionAddNewClick?.();
        closeMentionMenu();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        closeMentionMenu();
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (showStopButton) {
        onStopRef.current?.();
      } else if ((value.trim() || hasCompletedAttachments) && !disabled) {
        onSubmit();
      }
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (showStopButton) {
      onStopRef.current?.();
    } else if ((value.trim() || hasCompletedAttachments) && !disabled) {
      onSubmit();
    }
  }

  const handleButtonClick = useCallback((e: React.MouseEvent) => {
    if (showStopButton) {
      e.preventDefault();
      onStopRef.current?.();
    }
  }, [showStopButton]);

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

  const isSubmitDisabled = disabled
    || isLoading
    || hasUploadingAttachments
    || isTranscribing
    || (!showStopButton && !value.trim() && !hasCompletedAttachments);
  const showFileUpload = !!onFilesSelected;

  useEffect(() => {
    if (!isActiveRecording) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelRecording();
      }
    };

    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
    };
  }, [isActiveRecording, cancelRecording]);

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
        ref={anchorRef}
        onDragOver={showFileUpload ? handleDragOver : undefined}
        onDragLeave={showFileUpload ? handleDragLeave : undefined}
        onDrop={showFileUpload ? handleDrop : undefined}
        className={cn(
          'relative rounded-2xl transition-all duration-200',
          isDragOver && 'ring-2 ring-primary ring-offset-2'
        )}
      >
        {mentionsEnabled && (
          <ConnectionMentionMenu
            open={effectiveMenuOpen}
            query={mentionTrigger.query}
            connections={mentionableConnectionList}
            anchorRef={anchorRef}
            side={mentionMenuSide}
            activeId={activeMentionId}
            onActiveIdChange={setActiveMentionId}
            onSelect={insertMention}
            onClose={closeMentionMenu}
            onAddNewClick={() => onMentionAddNewClick?.()}
          />
        )}
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

          <div ref={textareaWrapperRef} className="relative w-full">
            <ComposerMentionDecorations
              value={value}
              slugMap={slugMap}
              textareaRef={effectiveTextareaRef}
              wrapperRef={textareaWrapperRef}
              scrollTop={textareaScroll.top}
              scrollLeft={textareaScroll.left}
              onTextareaSelectionChange={updateCaretPos}
            />
            <InputGroupTextarea
              ref={effectiveTextareaRef}
              value={value}
              onChange={(e) => {
                onChange(e.target.value);
                // Caret state needs to track value changes — onChange fires before selectionStart settles.
                requestAnimationFrame(updateCaretPos);
                // Any text edit clears the lockout from a previous Escape.
                mentionLockoutValueRef.current = null;
                mentionLockoutCaretRef.current = -1;
              }}
              onScroll={(e) => {
                const nextTop = e.currentTarget.scrollTop;
                const nextLeft = e.currentTarget.scrollLeft;
                setTextareaScroll((current) => (
                  current.top === nextTop && current.left === nextLeft
                    ? current
                    : { top: nextTop, left: nextLeft }
                ));
              }}
              onKeyDown={handleKeyDown}
              onKeyUp={updateCaretPos}
              onClick={updateCaretPos}
              onSelect={updateCaretPos}
              onCompositionStart={() => setIsComposing(true)}
              onCompositionEnd={() => setIsComposing(false)}
              onPaste={handlePaste}
              placeholder={effectivePlaceholder}
              disabled={disabled || isActiveRecording}
              autoFocus={autoFocus}
              onFocus={() => {
                setIsFocused(true);
                onFocus?.();
              }}
              onBlur={() => {
                setIsFocused(false);
                onBlur?.();
              }}
              className={cn(
                'relative z-10 bg-transparent text-base md:text-base p-3.5 max-h-96 overflow-y-auto',
                'selection:bg-primary/30',
                isActiveRecording && 'opacity-50',
              )}
              style={{
                minHeight,
                caretColor: 'var(--foreground)',
              }}
            />
          </div>

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
                <div className="flex items-center gap-1.5">
                  {/* Plus button for file upload */}
                  {showFileUpload && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <InputGroupButton
                          type="button"
                          size="icon-sm"
                          variant="ghost"
                          onClick={handlePlusClick}
                          disabled={disabled || isRecording || isTranscribing}
                          className="rounded-full text-muted-foreground hover:text-foreground hover:bg-muted"
                          aria-label="Upload file"
                        >
                          <Plus className="size-4" />
                        </InputGroupButton>
                      </TooltipTrigger>
                      <TooltipContent>Upload file</TooltipContent>
                    </Tooltip>
                  )}

                  {model && onModelChange && (
                    <ModelPicker
                      value={model}
                      onValueChange={onModelChange}
                      options={modelOptions}
                      isOrgAdmin={isOrgAdmin}
                      recentModelScope={recentModelScope}
                      disabled={modelDisabled || disabled}
                    />
                  )}

                  {contextUsedPercent != null && contextUsedPercent >= 50 && onCompact && (
                    <ContextIndicator usedPercent={contextUsedPercent} onCompact={onCompact} />
                  )}
                </div>

                <div className="flex items-center gap-1">
                  {/* Microphone button for voice recording */}
                  {showVoiceButton && (
                    <Tooltip>
                      <TooltipTrigger asChild>
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
                          aria-label={isRecording ? 'Stop recording' : isWarmingUp ? 'Cancel' : 'Dictate'}
                        >
                          {isTranscribing || isWarmingUp ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <Mic className="size-4" />
                          )}
                        </InputGroupButton>
                      </TooltipTrigger>
                      <TooltipContent>Dictate</TooltipContent>
                    </Tooltip>
                  )}

                  <MemoizedSendButton
                    showStopButton={showStopButton}
                    isSubmitDisabled={isSubmitDisabled}
                    isLoading={isLoading}
                    onClick={handleButtonClick}
                  />
                </div>
              </>
            )}
          </InputGroupAddon>
        </InputGroup>
      </div>
    </form>
  );
}

'use client';

import { ArrowUp, Square } from 'lucide-react';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from '@/components/ui/input-group';

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
}: PromptInputProps) {
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

  const isSubmitDisabled = disabled || isLoading || (!showStopButton && !value.trim());

  return (
    <form onSubmit={handleSubmit} className={className}>
      <InputGroup className="rounded-2xl border-border bg-background cursor-text shadow-sm hover:shadow-md focus-within:shadow-md focus-within:border-ring transition-all duration-200">
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
        <InputGroupAddon align="block-end" className="justify-end pb-3 pr-3">
          <InputGroupButton
            type={showStopButton ? 'button' : 'submit'}
            size="icon-sm"
            variant={showStopButton ? 'destructive' : 'default'}
            disabled={isSubmitDisabled}
            onClick={handleButtonClick}
            className="rounded-full"
          >
            {showStopButton ? <Square className="size-3" /> : <ArrowUp className="size-4" />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}

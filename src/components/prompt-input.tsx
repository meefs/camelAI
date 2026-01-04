'use client';

import { ArrowUp } from 'lucide-react';
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
  placeholder?: string;
  disabled?: boolean;
  isLoading?: boolean;
  minHeight?: string;
  className?: string;
  autoFocus?: boolean;
}

export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = 'Type a message...',
  disabled = false,
  isLoading = false,
  minHeight = '44px',
  className,
  autoFocus = false,
}: PromptInputProps) {
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled && !isLoading) {
        onSubmit();
      }
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (value.trim() && !disabled && !isLoading) {
      onSubmit();
    }
  }

  const isSubmitDisabled = disabled || isLoading || !value.trim();

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
            type="submit"
            size="icon-sm"
            variant="default"
            disabled={isSubmitDisabled}
            className="rounded-full"
          >
            <ArrowUp className="size-4" />
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}

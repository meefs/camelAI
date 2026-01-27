"use client";

import { useState, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Input } from '@/components/ui/input';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { MessageCircleQuestion, Send, ChevronUp, ChevronDown, ChevronRight } from 'lucide-react';

export interface QuestionOption {
  label: string;
  description: string;
}

export interface Question {
  question: string;
  header: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

export interface AskUserQuestionData {
  questionId: string;
  toolUseId: string;
  questions: Question[];
}

interface AskUserQuestionProps {
  data: AskUserQuestionData;
  onSubmit: (answers: Record<string, string>) => void;
  className?: string;
}

interface QuestionState {
  selected: string[];
  otherText: string;
  isOther: boolean;
}

export function AskUserQuestion({ data, onSubmit, className }: AskUserQuestionProps) {
  const [questionStates, setQuestionStates] = useState<Record<string, QuestionState>>(() => {
    const initial: Record<string, QuestionState> = {};
    for (const q of data.questions) {
      initial[q.question] = { selected: [], otherText: '', isOther: false };
    }
    return initial;
  });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isExpanded, setIsExpanded] = useState(true);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);

  // Reset state when a new question payload arrives
  useEffect(() => {
    setCurrentQuestionIndex(0);
    setIsSubmitting(false);
    const initial: Record<string, QuestionState> = {};
    for (const q of data.questions) {
      initial[q.question] = { selected: [], otherText: '', isOther: false };
    }
    setQuestionStates(initial);
  }, [data.questionId]);

  const totalQuestions = data.questions.length;
  const hasMultipleQuestions = totalQuestions > 1;
  // Clamp index to valid range to handle transitional render before useEffect resets it
  const safeIndex = Math.min(currentQuestionIndex, totalQuestions - 1);
  const isLastQuestion = safeIndex === totalQuestions - 1;
  const currentQuestion = data.questions[safeIndex];
  const currentState = questionStates[currentQuestion.question];

  const updateQuestionState = useCallback((questionText: string, update: Partial<QuestionState>) => {
    setQuestionStates(prev => ({
      ...prev,
      [questionText]: { ...prev[questionText], ...update }
    }));
  }, []);

  const handleSingleSelect = useCallback((questionText: string, value: string) => {
    if (value === '__other__') {
      updateQuestionState(questionText, { selected: [], isOther: true });
    } else {
      updateQuestionState(questionText, { selected: [value], isOther: false });
    }
  }, [updateQuestionState]);

  const handleMultiSelect = useCallback((questionText: string, value: string, checked: boolean) => {
    if (value === '__other__') {
      updateQuestionState(questionText, { isOther: checked });
    } else {
      setQuestionStates(prev => {
        const current = prev[questionText];
        const newSelected = checked
          ? [...current.selected, value]
          : current.selected.filter(v => v !== value);
        return {
          ...prev,
          [questionText]: { ...current, selected: newSelected }
        };
      });
    }
  }, [updateQuestionState]);

  const handleOtherTextChange = useCallback((questionText: string, text: string) => {
    updateQuestionState(questionText, { otherText: text });
  }, [updateQuestionState]);

  const handleSubmitAll = useCallback(() => {
    setIsSubmitting(true);

    const answers: Record<string, string> = {};

    for (const q of data.questions) {
      const state = questionStates[q.question];

      if (state.isOther && state.otherText.trim()) {
        // User provided custom text
        if (q.multiSelect && state.selected.length > 0) {
          // Combine selected options with "Other" text
          answers[q.question] = [...state.selected, state.otherText.trim()].join(', ');
        } else {
          answers[q.question] = state.otherText.trim();
        }
      } else if (state.selected.length > 0) {
        answers[q.question] = state.selected.join(', ');
      } else {
        // No selection - use empty string (SDK will handle)
        answers[q.question] = '';
      }
    }

    onSubmit(answers);
  }, [data.questions, questionStates, onSubmit]);

  const handleNextOrSubmit = useCallback(() => {
    if (isLastQuestion) {
      handleSubmitAll();
    } else {
      setCurrentQuestionIndex(prev => prev + 1);
    }
  }, [isLastQuestion, handleSubmitAll]);

  // Validate only the current question
  const isCurrentValid = currentState.selected.length > 0 || (currentState.isOther && currentState.otherText.trim());

  return (
    <div
      className={cn(
        "rounded-xl border border-border/50 bg-background/95 backdrop-blur-sm shadow-sm",
        "overflow-hidden",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
        className
      )}
    >
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        {/* Header */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full items-center gap-2 px-4 py-3 text-sm text-muted-foreground",
              "hover:bg-muted/30 transition-colors",
              "cursor-pointer"
            )}
          >
            <MessageCircleQuestion className="h-4 w-4 text-muted-foreground/60" />
            <span className="flex-1 text-left">Claude needs your input</span>
            {isExpanded ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground/40" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground/40" />
            )}
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent
          className={cn(
            "overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up",
            "motion-reduce:animate-none"
          )}
        >
          {/* Current Question */}
          <div className="px-4 pb-3 space-y-3">
            {/* Question header and text */}
            <div className="space-y-1">
              <span className="text-xs text-muted-foreground/60">
                {currentQuestion.header}
              </span>
              <p className="text-sm text-foreground">{currentQuestion.question}</p>
            </div>

            {/* Options */}
            {currentQuestion.multiSelect ? (
              <div className="space-y-1">
                {currentQuestion.options.map((opt, optIndex) => (
                  <label
                    key={`${opt.label}-${optIndex}`}
                    className={cn(
                      "flex items-start gap-3 py-2 px-2 -mx-2 rounded-md cursor-pointer",
                      "transition-colors hover:bg-muted/20"
                    )}
                  >
                    <Checkbox
                      checked={currentState.selected.includes(opt.label)}
                      onCheckedChange={(checked) => handleMultiSelect(currentQuestion.question, opt.label, !!checked)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-muted-foreground">{opt.label}</p>
                      {opt.description && (
                        <p className="text-xs text-muted-foreground/60">{opt.description}</p>
                      )}
                    </div>
                  </label>
                ))}

                {/* Other option for multi-select */}
                <label
                  className={cn(
                    "flex items-start gap-3 py-2 px-2 -mx-2 rounded-md cursor-pointer",
                    "transition-colors hover:bg-muted/20"
                  )}
                >
                  <Checkbox
                    checked={currentState.isOther}
                    onCheckedChange={(checked) => handleMultiSelect(currentQuestion.question, '__other__', !!checked)}
                    className="mt-0.5"
                  />
                  <div className="flex-1 min-w-0 space-y-2">
                    <p className="text-sm text-muted-foreground">Other</p>
                    {currentState.isOther && (
                      <Input
                        type="text"
                        placeholder="Type your answer..."
                        value={currentState.otherText}
                        onChange={(e) => handleOtherTextChange(currentQuestion.question, e.target.value)}
                        className="h-8 text-sm"
                        autoFocus
                      />
                    )}
                  </div>
                </label>
              </div>
            ) : (
              <RadioGroup
                value={currentState.isOther ? '__other__' : (currentState.selected[0] || '')}
                onValueChange={(value: string) => handleSingleSelect(currentQuestion.question, value)}
                className="space-y-1"
              >
                {currentQuestion.options.map((opt, optIndex) => (
                  <label
                    key={`${opt.label}-${optIndex}`}
                    className={cn(
                      "flex items-start gap-3 py-2 px-2 -mx-2 rounded-md cursor-pointer",
                      "transition-colors hover:bg-muted/20"
                    )}
                  >
                    <RadioGroupItem value={opt.label} className="mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-muted-foreground">{opt.label}</p>
                      {opt.description && (
                        <p className="text-xs text-muted-foreground/60">{opt.description}</p>
                      )}
                    </div>
                  </label>
                ))}

                {/* Other option for single-select */}
                <label
                  className={cn(
                    "flex items-start gap-3 py-2 px-2 -mx-2 rounded-md cursor-pointer",
                    "transition-colors hover:bg-muted/20"
                  )}
                >
                  <RadioGroupItem value="__other__" className="mt-0.5" />
                  <div className="flex-1 min-w-0 space-y-2">
                    <p className="text-sm text-muted-foreground">Other</p>
                    {currentState.isOther && (
                      <Input
                        type="text"
                        placeholder="Type your answer..."
                        value={currentState.otherText}
                        onChange={(e) => handleOtherTextChange(currentQuestion.question, e.target.value)}
                        className="h-8 text-sm"
                        autoFocus
                      />
                    )}
                  </div>
                </label>
              </RadioGroup>
            )}
          </div>

          {/* Footer with counter and button */}
          <div className="flex items-center justify-end gap-3 px-4 pb-3 pt-2">
            {hasMultipleQuestions && (
              <span className="text-xs text-muted-foreground/50">
                {currentQuestionIndex + 1} of {totalQuestions}
              </span>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleNextOrSubmit}
              disabled={!isCurrentValid || isSubmitting}
              className="text-muted-foreground hover:text-foreground"
            >
              {isSubmitting ? (
                <>Submitting...</>
              ) : isLastQuestion ? (
                <>
                  Submit
                  <Send className="ml-2 h-3.5 w-3.5" />
                </>
              ) : (
                <>
                  Next
                  <ChevronRight className="ml-1 h-3.5 w-3.5" />
                </>
              )}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

"use client";

import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MessageCircleQuestion, Send } from 'lucide-react';

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

  const handleSubmit = useCallback(() => {
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

  const isValid = data.questions.every(q => {
    const state = questionStates[q.question];
    return state.selected.length > 0 || (state.isOther && state.otherText.trim());
  });

  return (
    <div
      className={cn(
        "rounded-xl border border-primary/20 bg-primary/5",
        "overflow-hidden",
        "animate-in fade-in-0 slide-in-from-bottom-2 duration-200",
        className
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/20 bg-primary/10">
        <MessageCircleQuestion className="h-5 w-5 text-primary" />
        <span className="text-sm font-medium text-primary">Claude needs your input</span>
      </div>

      {/* Questions */}
      <div className="p-4 space-y-6">
        {data.questions.map((q, qIndex) => {
          const state = questionStates[q.question];

          return (
            <div key={`${q.question}-${qIndex}`} className="space-y-3">
              {/* Question header and text */}
              <div className="space-y-1">
                <span className="inline-block px-2 py-0.5 text-xs font-medium rounded-full bg-muted text-muted-foreground">
                  {q.header}
                </span>
                <p className="text-sm font-medium text-foreground">{q.question}</p>
              </div>

              {/* Options */}
              {q.multiSelect ? (
                <div className="space-y-2">
                  {q.options.map((opt, optIndex) => (
                    <label
                      key={`${opt.label}-${optIndex}`}
                      className={cn(
                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                        state.selected.includes(opt.label)
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50 hover:bg-muted/50"
                      )}
                    >
                      <Checkbox
                        checked={state.selected.includes(opt.label)}
                        onCheckedChange={(checked) => handleMultiSelect(q.question, opt.label, !!checked)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">{opt.label}</p>
                        <p className="text-xs text-muted-foreground">{opt.description}</p>
                      </div>
                    </label>
                  ))}

                  {/* Other option for multi-select */}
                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                      state.isOther
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50 hover:bg-muted/50"
                    )}
                  >
                    <Checkbox
                      checked={state.isOther}
                      onCheckedChange={(checked) => handleMultiSelect(q.question, '__other__', !!checked)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0 space-y-2">
                      <p className="text-sm font-medium text-foreground">Other</p>
                      {state.isOther && (
                        <Input
                          type="text"
                          placeholder="Type your answer..."
                          value={state.otherText}
                          onChange={(e) => handleOtherTextChange(q.question, e.target.value)}
                          className="h-8 text-sm"
                          autoFocus
                        />
                      )}
                    </div>
                  </label>
                </div>
              ) : (
                <RadioGroup
                  value={state.isOther ? '__other__' : (state.selected[0] || '')}
                  onValueChange={(value: string) => handleSingleSelect(q.question, value)}
                  className="space-y-2"
                >
                  {q.options.map((opt, optIndex) => (
                    <label
                      key={`${opt.label}-${optIndex}`}
                      className={cn(
                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                        state.selected.includes(opt.label)
                          ? "border-primary bg-primary/5"
                          : "border-border hover:border-primary/50 hover:bg-muted/50"
                      )}
                    >
                      <RadioGroupItem value={opt.label} className="mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground">{opt.label}</p>
                        <p className="text-xs text-muted-foreground">{opt.description}</p>
                      </div>
                    </label>
                  ))}

                  {/* Other option for single-select */}
                  <label
                    className={cn(
                      "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                      state.isOther
                        ? "border-primary bg-primary/5"
                        : "border-border hover:border-primary/50 hover:bg-muted/50"
                    )}
                  >
                    <RadioGroupItem value="__other__" className="mt-0.5" />
                    <div className="flex-1 min-w-0 space-y-2">
                      <p className="text-sm font-medium text-foreground">Other</p>
                      {state.isOther && (
                        <Input
                          type="text"
                          placeholder="Type your answer..."
                          value={state.otherText}
                          onChange={(e) => handleOtherTextChange(q.question, e.target.value)}
                          className="h-8 text-sm"
                          autoFocus
                        />
                      )}
                    </div>
                  </label>
                </RadioGroup>
              )}
            </div>
          );
        })}
      </div>

      {/* Submit button */}
      <div className="px-4 pb-4">
        <Button
          onClick={handleSubmit}
          disabled={!isValid || isSubmitting}
          className="w-full"
        >
          {isSubmitting ? (
            <>Submitting...</>
          ) : (
            <>
              <Send className="h-4 w-4 mr-2" />
              Submit Response
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

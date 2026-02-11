"use client";

import type { ToolResultBlock, ToolUseBlock } from '@/types';
import { getResultText } from '../tool-utils';
import { GenericDetails } from './generic-details';

interface AskUserQuestionDetailsProps {
  tool?: ToolUseBlock;
  result?: ToolResultBlock;
}

interface AskUserQuestionPrompt {
  question: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  return value as Record<string, unknown>;
}

function extractQuestions(tool?: ToolUseBlock): AskUserQuestionPrompt[] {
  const input = asRecord(tool?.input);
  const questions = input?.questions;
  if (!Array.isArray(questions)) return [];

  return questions
    .map((item) => {
      const question = asRecord(item)?.question;
      if (typeof question !== 'string' || !question.trim()) return null;
      return { question };
    })
    .filter((item): item is AskUserQuestionPrompt => Boolean(item));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeQuotedValue(value: string): string {
  let decoded = '';

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      decoded += char;
      continue;
    }

    const next = value[index + 1];
    if (next === undefined) {
      decoded += '\\';
      break;
    }

    if (next === '\\') {
      decoded += '\\';
      index += 1;
      continue;
    }

    if (next === '"') {
      decoded += '"';
      index += 1;
      continue;
    }

    if (next === 'n') {
      decoded += '\n';
      index += 1;
      continue;
    }

    if (next === 'r') {
      decoded += '\r';
      index += 1;
      continue;
    }

    if (next === 't') {
      decoded += '\t';
      index += 1;
      continue;
    }

    decoded += '\\';
  }

  return decoded;
}

function extractQuestionsAndAnswers(tool?: ToolUseBlock, result?: ToolResultBlock): {
  questions: AskUserQuestionPrompt[];
  answers: Record<string, string>;
  resultText: string;
} {
  const questions = extractQuestions(tool);
  const answers: Record<string, string> = {};
  const resultText = getResultText(result);

  if (!result || !resultText || questions.length === 0) {
    return { questions, answers, resultText };
  }

  for (const { question } of questions) {
    // The tool result is plain text with pairs like: "question"="answer"
    const serializedQuestion = question.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedQuestion = escapeRegExp(serializedQuestion);
    const pattern = new RegExp(`"${escapedQuestion}"\\s*=\\s*"((?:\\\\.|[^"\\\\])*)"`, 's');
    const match = resultText.match(pattern);
    if (match) {
      answers[question] = decodeQuotedValue(match[1] ?? '');
    }
  }

  return { questions, answers, resultText };
}

export function AskUserQuestionDetails({ tool, result }: AskUserQuestionDetailsProps) {
  const { questions, answers, resultText } = extractQuestionsAndAnswers(tool, result);
  const hasResult = Boolean(result && resultText.trim());
  const hasParsedAnswers = Object.keys(answers).length > 0;

  if (questions.length === 0 || (hasResult && !hasParsedAnswers)) {
    return <GenericDetails tool={tool} result={result} />;
  }

  return (
    <div className="space-y-2">
      {questions.map((question, index) => (
        <div key={`${question.question}-${index}`}>
          <p className="font-medium">{question.question}</p>
          <p className="text-muted-foreground/60">{answers[question.question] ?? '—'}</p>
        </div>
      ))}
    </div>
  );
}

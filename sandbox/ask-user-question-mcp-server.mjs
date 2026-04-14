#!/usr/bin/env node

import process from 'node:process';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const threadId = typeof process.env.THREAD_ID === 'string' ? process.env.THREAD_ID.trim() : '';
const controlPlanePort =
  typeof process.env.CONTROL_PLANE_PORT === 'string' && process.env.CONTROL_PLANE_PORT.trim()
    ? process.env.CONTROL_PLANE_PORT.trim()
    : '8080';

function createAskUserQuestionMcpServer() {
  return createSdkMcpServer({
    name: 'camelai_ui',
    version: '1.0.0',
    tools: [
      tool(
        'ask_user_question',
        'Ask the user one to four multiple-choice clarifying questions and wait for their selections.',
        {
          questions: z.array(
            z.object({
              question: z.string().trim().min(1).describe('The question to ask the user.'),
              header: z.string().trim().min(1).optional().describe('Short label shown above the question.'),
              options: z.array(
                z.object({
                  label: z.string().trim().min(1).describe('Option label shown to the user.'),
                  description: z.string().trim().optional().default('').describe('Short explanation for the option.'),
                }),
              ).min(2).max(10).describe('Multiple-choice options for the question.'),
              multiSelect: z.boolean().optional().default(false).describe('Allow selecting multiple options when true.'),
            }),
          ).min(1).max(4).describe('One to four questions to ask in a single flow.'),
        },
        async ({ questions }) => {
          if (!threadId) {
            return {
              content: [{ type: 'text', text: 'ask_user_question failed: missing THREAD_ID.' }],
              isError: true,
            };
          }

          try {
            const response = await fetch(`http://127.0.0.1:${controlPlanePort}/internal/ask-user-question`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ threadId, questions }),
            });

            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              return {
                content: [
                  {
                    type: 'text',
                    text: `ask_user_question failed: ${
                      payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
                    }`,
                  },
                ],
                isError: true,
              };
            }

            const answers =
              payload && typeof payload === 'object' && payload.answers && typeof payload.answers === 'object'
                ? payload.answers
                : {};

            return {
              content: [{ type: 'text', text: JSON.stringify({ answers }, null, 2) }],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: 'text',
                  text: `ask_user_question failed: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}

const transport = new StdioServerTransport();
const server = createAskUserQuestionMcpServer();

await server.instance.server.connect(transport);

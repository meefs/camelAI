import { describe, it, expect } from 'vitest';

// Copy of parseMessageContent from Chat.tsx for testing
// This function handles both plain string and JSON-encoded ContentBlock[]
function parseMessageContent(content: string | any[]): string | any[] {
  // Already an array - return as-is
  if (Array.isArray(content)) return content;

  // Not a string - return as-is
  if (typeof content !== 'string') return content;

  // Try to parse as JSON array of content blocks
  const trimmed = content.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].type) {
        return parsed;
      }
    } catch {
      // Not valid JSON - fall through to return as string
    }
  }

  // Plain string content
  return content;
}

describe('parseMessageContent', () => {
  describe('array content (already parsed)', () => {
    it('returns array content as-is', () => {
      const content = [{ type: 'text', text: 'Hello world' }];
      expect(parseMessageContent(content)).toBe(content);
    });

    it('returns tool_use content blocks as-is', () => {
      const content = [
        { type: 'text', text: 'Let me run that command' },
        { type: 'tool_use', id: 'tool_123', name: 'Bash', input: { command: 'echo hello' } },
      ];
      expect(parseMessageContent(content)).toBe(content);
    });

    it('returns mixed content blocks as-is', () => {
      const content = [
        { type: 'text', text: 'Here is the result:' },
        { type: 'tool_use', id: 'tool_1', name: 'Read', input: { file_path: '/test.txt' } },
        { type: 'tool_result', tool_use_id: 'tool_1', content: 'File contents here' },
        { type: 'text', text: 'As you can see...' },
      ];
      expect(parseMessageContent(content)).toBe(content);
    });
  });

  describe('JSON-encoded content blocks', () => {
    it('parses JSON-encoded text blocks', () => {
      const jsonContent = JSON.stringify([{ type: 'text', text: 'Hello world' }]);
      const result = parseMessageContent(jsonContent);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect((result as any[])[0]).toEqual({ type: 'text', text: 'Hello world' });
    });

    it('parses JSON-encoded tool_use blocks', () => {
      const content = [
        { type: 'text', text: 'Running command...' },
        { type: 'tool_use', id: 'toolu_abc123', name: 'Bash', input: { command: 'ls -la' } },
      ];
      const jsonContent = JSON.stringify(content);
      const result = parseMessageContent(jsonContent);

      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
      expect((result as any[])[0].type).toBe('text');
      expect((result as any[])[1].type).toBe('tool_use');
      expect((result as any[])[1].name).toBe('Bash');
      expect((result as any[])[1].input.command).toBe('ls -la');
    });

    it('parses JSON-encoded tool_result blocks', () => {
      const content = [
        { type: 'tool_result', tool_use_id: 'toolu_abc123', content: 'total 42\ndrwxr-xr-x...' },
      ];
      const jsonContent = JSON.stringify(content);
      const result = parseMessageContent(jsonContent);

      expect(Array.isArray(result)).toBe(true);
      expect((result as any[])[0].type).toBe('tool_result');
      expect((result as any[])[0].content).toContain('total 42');
    });

    it('handles whitespace around JSON', () => {
      const jsonContent = '  [{"type":"text","text":"Hello"}]  ';
      const result = parseMessageContent(jsonContent);
      expect(Array.isArray(result)).toBe(true);
      expect((result as any[])[0].text).toBe('Hello');
    });

    it('handles complex nested tool inputs', () => {
      const content = [
        {
          type: 'tool_use',
          id: 'toolu_xyz',
          name: 'Edit',
          input: {
            file_path: '/src/test.ts',
            old_string: 'const x = 1;',
            new_string: 'const x = 2;',
          },
        },
      ];
      const jsonContent = JSON.stringify(content);
      const result = parseMessageContent(jsonContent);

      expect(Array.isArray(result)).toBe(true);
      expect((result as any[])[0].input.file_path).toBe('/src/test.ts');
    });
  });

  describe('plain string content', () => {
    it('returns plain text as-is', () => {
      const content = 'Hello, how can I help you?';
      expect(parseMessageContent(content)).toBe(content);
    });

    it('returns text that looks like JSON array but is not valid', () => {
      const content = '[not valid json';
      expect(parseMessageContent(content)).toBe(content);
    });

    it('returns JSON array without type property as string', () => {
      // If the array doesn't have objects with 'type' property, treat as string
      const content = '[1, 2, 3]';
      expect(parseMessageContent(content)).toBe(content);
    });

    it('returns JSON array with empty objects as string', () => {
      const content = '[{}]';
      expect(parseMessageContent(content)).toBe(content);
    });

    it('handles markdown content with code blocks', () => {
      const content = '```javascript\nconst x = [1, 2, 3];\n```';
      expect(parseMessageContent(content)).toBe(content);
    });

    it('handles text starting with [ but not ending with ]', () => {
      const content = '[INFO] Server started on port 3000';
      expect(parseMessageContent(content)).toBe(content);
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(parseMessageContent('')).toBe('');
    });

    it('handles empty array', () => {
      const content: any[] = [];
      expect(parseMessageContent(content)).toBe(content);
    });

    it('handles null/undefined gracefully', () => {
      // TypeScript would prevent this, but testing runtime behavior
      expect(parseMessageContent(null as any)).toBe(null);
      expect(parseMessageContent(undefined as any)).toBe(undefined);
    });

    it('handles JSON array with thinking blocks', () => {
      const content = [
        { type: 'thinking', thinking: 'Let me analyze this...' },
        { type: 'text', text: 'Here is my response' },
      ];
      const jsonContent = JSON.stringify(content);
      const result = parseMessageContent(jsonContent);

      expect(Array.isArray(result)).toBe(true);
      expect((result as any[])[0].type).toBe('thinking');
      expect((result as any[])[1].type).toBe('text');
    });
  });
});

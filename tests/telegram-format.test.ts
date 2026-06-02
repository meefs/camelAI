import { describe, expect, it } from 'vitest';
import { formatMarkdownForTelegram } from '../src/lib/telegram-format';

describe('formatMarkdownForTelegram', () => {
  it('converts common markdown to Telegram HTML', () => {
    const formatted = formatMarkdownForTelegram([
      '# Update',
      '',
      '**Done** with _details_ and [link](https://example.com).',
      '',
      '- First',
      '- `code`',
    ].join('\n'));

    expect(formatted.parseMode).toBe('HTML');
    expect(formatted.text).toContain('<b>Update</b>');
    expect(formatted.text).toContain('<b>Done</b>');
    expect(formatted.text).toContain('<i>details</i>');
    expect(formatted.text).toContain('<a href="https://example.com">link</a>');
    expect(formatted.text).toContain('- <code>code</code>');
  });

  it('escapes HTML and leaves ordinary markdown punctuation safe', () => {
    const formatted = formatMarkdownForTelegram('Use snake_case & <tags> in files.');

    expect(formatted.text).toBe('Use snake_case &amp; &lt;tags&gt; in files.');
  });

  it('renders unsupported link schemes as plain text', () => {
    const formatted = formatMarkdownForTelegram('[email us](mailto:support@example.com) or [deep link](tg:resolve?domain=test)');

    expect(formatted.text).toBe('email us or deep link');
    expect(formatted.text).not.toContain('<a href=');
  });

  it('keeps Telegram-supported link schemes', () => {
    const formatted = formatMarkdownForTelegram('[site](https://example.com) and [bot](tg://resolve?domain=test)');

    expect(formatted.text).toContain('<a href="https://example.com">site</a>');
    expect(formatted.text).toContain('<a href="tg://resolve?domain=test">bot</a>');
  });
});

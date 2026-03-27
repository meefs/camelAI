import { describe, expect, it } from 'vitest';
import {
  FILE_SAFETY_SYSTEM_MESSAGE,
  injectFileSafetyMessage,
  isUnsafeUploadPath,
} from '../src/file-safety.js';

function withUploadRef(path: string, prefix = 'Please review this file.') {
  return `${prefix}\n\n(user uploaded file to ${path})`;
}

// Browser chat and external/email ingress both pass through
// injectFileSafetyMessage() before author attribution.
describe('injectFileSafetyMessage', () => {
  it('leaves messages without upload refs unchanged', () => {
    const content = 'Please help me summarize this note.';
    expect(injectFileSafetyMessage(content)).toBe(content);
  });

  it('leaves safe upload refs unchanged', () => {
    const content = [
      'Please analyze these.',
      '',
      '(user uploaded file to /mnt/user-uploads/data-1710000000-abc123.csv)',
      '(user uploaded file to /mnt/user-uploads/chart-1710000000-abc123.PNG)',
    ].join('\n');

    expect(injectFileSafetyMessage(content)).toBe(content);
  });

  it('prepends the warning for unsafe file extensions', () => {
    const content = withUploadRef('/mnt/user-uploads/script-1710000000-abc123.sh');
    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });

  it('prepends the warning when safe and unsafe uploads are mixed', () => {
    const content = [
      'Please inspect both files.',
      '',
      '(user uploaded file to /mnt/user-uploads/data-1710000000-abc123.csv)',
      '(user uploaded file to /mnt/user-uploads/archive-1710000000-abc123.zip)',
    ].join('\n');

    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });

  it('treats extensionless files as unsafe', () => {
    const content = withUploadRef('/mnt/user-uploads/README-1710000000-abc123');
    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });

  it('treats the last extension as authoritative for multi-dot filenames', () => {
    const content = withUploadRef('/mnt/user-uploads/archive.tar-1710000000-abc123.gz');
    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });

  it('preserves existing camelai system messages when prepending the warning', () => {
    const content = [
      '<camelai system message>Existing hidden context.</camelai system message>',
      '',
      withUploadRef('/mnt/user-uploads/payload-1710000000-abc123.py', 'Please run this.'),
    ].join('\n');

    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });

  it('treats docker compose filenames as unsafe despite safe yaml extensions', () => {
    const content = withUploadRef('/mnt/user-uploads/docker-compose_prod-1710000000-abc123.yml');
    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });

  it('treats compose.yaml uploads as unsafe despite safe yaml extensions', () => {
    const content = withUploadRef('/mnt/user-uploads/compose-1710000000-abc123.yaml');
    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });

  it('treats compose override variants as unsafe despite safe yaml extensions', () => {
    const content = withUploadRef('/mnt/user-uploads/compose.override-1710000000-abc123.yml');
    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });

  it('treats Dockerfile uploads as unsafe after stored suffixing', () => {
    const content = withUploadRef('/mnt/user-uploads/Dockerfile-1710000000-abc123');
    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });

  it('treats Makefile uploads as unsafe after stored suffixing', () => {
    const content = withUploadRef('/mnt/user-uploads/Makefile-1710000000-abc123');
    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });

  it('treats env-style filenames as unsafe despite safe json extensions', () => {
    const content = withUploadRef('/mnt/user-uploads/_env-1710000000-abc123.json');
    expect(injectFileSafetyMessage(content)).toBe(`${FILE_SAFETY_SYSTEM_MESSAGE}\n\n${content}`);
  });
});

describe('isUnsafeUploadPath', () => {
  it('is case-insensitive for extensions', () => {
    expect(isUnsafeUploadPath('/mnt/user-uploads/photo-1710000000-abc123.JpG')).toBe(false);
    expect(isUnsafeUploadPath('/mnt/user-uploads/archive-1710000000-abc123.ZIP')).toBe(true);
  });

  it('treats stored plain .env uploads as unsafe even when the stem is empty', () => {
    expect(isUnsafeUploadPath('/mnt/user-uploads/-1710000000-abc123.env')).toBe(true);
  });
});

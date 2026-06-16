import { describe, expect, it } from 'vitest';
import {
  appendUserUploadReferences,
  buildUserUploadReference,
  isUserUploadMountPath,
} from '@/lib/chat-attachment-refs';

describe('chat attachment references', () => {
  it('appends readable upload mount paths to user messages', () => {
    expect(
      appendUserUploadReferences('please analyze this', [
        'uploads/report-123-abc.csv',
      ]),
    ).toBe(
      'please analyze this\n\n(user uploaded file to uploads/report-123-abc.csv)',
    );
  });

  it('supports file-only messages', () => {
    expect(
      appendUserUploadReferences('', ['uploads/data-123-abc.csv']),
    ).toBe('(user uploaded file to uploads/data-123-abc.csv)');
  });

  it('rejects non-upload mount paths', () => {
    expect(isUserUploadMountPath('/tmp/data.csv')).toBe(false);
    expect(() => buildUserUploadReference('/tmp/data.csv')).toThrow(
      'uploads/',
    );
  });
});

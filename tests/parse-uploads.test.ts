import { describe, expect, it } from 'vitest';
import { parseUploadRefs } from '@/components/chat-file-preview/parse-uploads';

describe('parseUploadRefs', () => {
  it('extracts relative upload references and strips markers from content', () => {
    const result = parseUploadRefs('please analyze\n\n(user uploaded file to uploads/report-1710000000-abcd.csv)');

    expect(result.cleanContent).toBe('please analyze');
    expect(result.refs).toEqual([
      {
        originalText: '(user uploaded file to uploads/report-1710000000-abcd.csv)',
        mountPath: 'uploads/report-1710000000-abcd.csv',
        filename: 'report-1710000000-abcd.csv',
        originalName: 'report.csv',
      },
    ]);
  });

  it('preserves preview chips for legacy upload markers in chat history', () => {
    const result = parseUploadRefs('old message\n(user uploaded file to /mnt/user-uploads/data-1710000000-wxyz.json)');

    expect(result.cleanContent).toBe('old message');
    expect(result.refs).toEqual([
      {
        originalText: '(user uploaded file to /mnt/user-uploads/data-1710000000-wxyz.json)',
        mountPath: '/mnt/user-uploads/data-1710000000-wxyz.json',
        filename: 'data-1710000000-wxyz.json',
        originalName: 'data.json',
      },
    ]);
  });
});

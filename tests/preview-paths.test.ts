import { describe, expect, it } from 'vitest';
import { parseFilePreviewPath } from '../workers/main/src/preview-paths';

describe('parseFilePreviewPath', () => {
  it('parses user output mount paths as output preview targets', () => {
    expect(parseFilePreviewPath('/mnt/user-outputs/report.html')).toEqual({
      source: 'output',
      path: 'report.html',
      filename: 'report.html',
    });
  });

  it('parses nested user upload mount paths as upload preview targets', () => {
    expect(parseFilePreviewPath('/mnt/user-uploads/data/files/input.csv')).toEqual({
      source: 'upload',
      path: 'data/files/input.csv',
      filename: 'input.csv',
    });
  });

  it('normalizes absolute workspace paths from known workspace roots', () => {
    expect(parseFilePreviewPath('/home/claude/project/index.html')).toEqual({
      source: 'workspace',
      path: '/project/index.html',
      filename: 'index.html',
    });
  });

  it('rejects parent-directory traversal', () => {
    expect(parseFilePreviewPath('/mnt/user-outputs/../secret.txt')).toBeNull();
    expect(parseFilePreviewPath('/home/claude/../secret.txt')).toBeNull();
  });
});

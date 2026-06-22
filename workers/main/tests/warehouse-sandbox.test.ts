import { describe, expect, it } from 'vitest';
import { S3FSMountError } from '@cloudflare/sandbox';
import { isMountAlreadyPresent } from '../src/warehouse-sandbox.js';

describe('isMountAlreadyPresent', () => {
  it('treats the SDK s3fs mount error as already-mounted (branch on type, not message)', () => {
    // The warm-container remount symptom: the prefix is already mounted at the
    // kernel level and s3fs reports the mountpoint busy.
    const error = new S3FSMountError('S3FS mount failed: s3fs: MOUNTPOINT directory /warehouse/ws_1 is not empty');
    expect(isMountAlreadyPresent(error)).toBe(true);
  });

  it('does not swallow other errors (genuine mount/config failures)', () => {
    expect(isMountAlreadyPresent(new Error('R2 binding not found in Worker env'))).toBe(false);
    expect(isMountAlreadyPresent(new Error('permission denied'))).toBe(false);
    expect(isMountAlreadyPresent('not even an error')).toBe(false);
    expect(isMountAlreadyPresent(undefined)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { InvalidMountConfigError, S3FSMountError } from '@cloudflare/sandbox';
import { createSingleFlight, isMountAlreadyPresent } from '../src/warehouse-sandbox.js';

describe('isMountAlreadyPresent', () => {
  it('treats the SDK s3fs mount error as already-mounted (branch on type, not message)', () => {
    // The warm-container remount symptom: the prefix is already mounted at the
    // kernel level and s3fs reports the mountpoint busy.
    const error = new S3FSMountError('S3FS mount failed: s3fs: MOUNTPOINT directory /warehouse/ws_1 is not empty');
    expect(isMountAlreadyPresent(error)).toBe(true);
  });

  it('treats the SDK "mount path already in use" config error as already-mounted', () => {
    // A concurrent ensureExportsMounted already registered the path in the SDK's
    // in-memory mount registry, so a second mount of it is rejected.
    const error = new InvalidMountConfigError(
      'Mount path "/warehouse/ws_1" is already in use by bucket "WAREHOUSE_EXPORT_BUCKET". Unmount the existing bucket first or use a different mount path.',
    );
    expect(isMountAlreadyPresent(error)).toBe(true);
  });

  it('does NOT swallow other InvalidMountConfigError variants (different prefix / bad config)', () => {
    expect(isMountAlreadyPresent(new InvalidMountConfigError(
      'R2 binding "WAREHOUSE_EXPORT_BUCKET" is already mounted at /warehouse/ws_1 with a different prefix.',
    ))).toBe(false);
    expect(isMountAlreadyPresent(new InvalidMountConfigError('Invalid bucket name: "Bad Name".'))).toBe(false);
  });

  it('does not swallow other errors (genuine mount/config failures)', () => {
    expect(isMountAlreadyPresent(new Error('R2 binding not found in Worker env'))).toBe(false);
    expect(isMountAlreadyPresent(new Error('permission denied'))).toBe(false);
    expect(isMountAlreadyPresent('not even an error')).toBe(false);
    expect(isMountAlreadyPresent(undefined)).toBe(false);
  });
});

describe('createSingleFlight', () => {
  it('coalesces concurrent callers onto a single run', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = createSingleFlight();
    const run = () =>
      new Promise<void>((resolve) => {
        runs++;
        release = resolve;
      });

    // Two callers race before the first run settles.
    const a = gate(run);
    const b = gate(run);
    expect(runs).toBe(1); // only one run actually started
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });

  it('caches success — later callers never re-run', async () => {
    let runs = 0;
    const gate = createSingleFlight();
    const run = async () => { runs++; };
    await gate(run);
    await gate(run);
    await gate(run);
    expect(runs).toBe(1);
  });

  it('does not cache failure — the next call retries', async () => {
    let runs = 0;
    const gate = createSingleFlight();
    const run = async () => {
      runs++;
      if (runs === 1) throw new Error('boom');
    };
    await expect(gate(run)).rejects.toThrow('boom');
    await gate(run); // retries and succeeds
    expect(runs).toBe(2);
    await gate(run); // now cached — no further runs
    expect(runs).toBe(2);
  });
});

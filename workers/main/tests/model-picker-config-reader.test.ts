import { describe, expect, it, vi } from 'vitest';
import {
  readOrgModelPickerConfig,
  readWorkspaceModelPickerConfig,
} from '../src/model-picker-config-reader';

describe('model picker config RPC reads', () => {
  it('propagates unavailable RPC errors', async () => {
    const error = new Error('No such RPC method getModelPickerConfig');

    await expect(
      readOrgModelPickerConfig({
        getModelPickerConfig: vi.fn().mockRejectedValue(error),
      }),
    ).rejects.toBe(error);

    await expect(
      readWorkspaceModelPickerConfig({
        getModelPickerConfig: vi.fn().mockRejectedValue(error),
      }),
    ).rejects.toBe(error);
  });

  it('retries transient config RPC failures', async () => {
    const orgGetModelPickerConfig = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Durable Object reset because its code was updated.'),
      )
      .mockResolvedValueOnce({
        use_platform_defaults: true,
        default_model: null,
        models: [],
      });
    const workspaceGetModelPickerConfig = vi
      .fn()
      .mockRejectedValueOnce(
        new Error('Durable Object reset because its code was updated.'),
      )
      .mockResolvedValueOnce({
        use_org_defaults: true,
        use_platform_defaults: true,
        models: [],
        default_model: null,
      });

    await expect(
      readOrgModelPickerConfig({
        getModelPickerConfig: orgGetModelPickerConfig,
      }),
    ).resolves.toMatchObject({
      use_platform_defaults: true,
      default_model: null,
      models: [],
    });
    await expect(
      readWorkspaceModelPickerConfig({
        getModelPickerConfig: workspaceGetModelPickerConfig,
      }),
    ).resolves.toMatchObject({
      use_org_defaults: true,
      default_model: null,
      models: [],
    });
    expect(orgGetModelPickerConfig).toHaveBeenCalledTimes(2);
    expect(workspaceGetModelPickerConfig).toHaveBeenCalledTimes(2);
  });

  it('rethrows non-transient failures', async () => {
    const error = new Error('storage failed');

    await expect(
      readOrgModelPickerConfig({
        getModelPickerConfig: vi.fn().mockRejectedValue(error),
      }),
    ).rejects.toThrow(error);
  });
});

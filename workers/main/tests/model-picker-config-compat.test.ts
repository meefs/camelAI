import { describe, expect, it, vi } from 'vitest';
import {
  getOrgModelPickerConfigCompat,
  getWorkspaceModelPickerConfigCompat,
} from '../src/model-picker-config-compat';

describe('model picker config RPC compatibility', () => {
  it('fails when older DOs do not expose the RPC', async () => {
    const error = new Error('No such RPC method getModelPickerConfig');

    await expect(
      getOrgModelPickerConfigCompat({
        getModelPickerConfig: vi.fn().mockRejectedValue(error),
      }),
    ).rejects.toBe(error);

    await expect(
      getWorkspaceModelPickerConfigCompat({
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
      getOrgModelPickerConfigCompat({
        getModelPickerConfig: orgGetModelPickerConfig,
      }),
    ).resolves.toMatchObject({
      use_platform_defaults: true,
      default_model: null,
      models: [],
    });
    await expect(
      getWorkspaceModelPickerConfigCompat({
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

  it('rethrows non-compatibility failures', async () => {
    const error = new Error('storage failed');

    await expect(
      getOrgModelPickerConfigCompat({
        getModelPickerConfig: vi.fn().mockRejectedValue(error),
      }),
    ).rejects.toThrow(error);
  });
});

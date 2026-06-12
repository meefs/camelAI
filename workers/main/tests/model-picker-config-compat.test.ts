import { describe, expect, it, vi } from 'vitest';
import {
  getOrgModelPickerConfigCompat,
  getWorkspaceModelPickerConfigCompat,
} from '../src/model-picker-config-compat';

describe('model picker config RPC compatibility', () => {
  it('falls back to default configs when older DOs do not expose the RPC', async () => {
    await expect(
      getOrgModelPickerConfigCompat({
        getModelPickerConfig: vi
          .fn()
          .mockRejectedValue(
            new Error('No such RPC method getModelPickerConfig'),
          ),
      }),
    ).resolves.toMatchObject({
      use_platform_defaults: true,
      default_model: null,
      models: [],
    });

    await expect(
      getWorkspaceModelPickerConfigCompat({
        getModelPickerConfig: vi
          .fn()
          .mockRejectedValue(
            new Error('No such RPC method getModelPickerConfig'),
          ),
      }),
    ).resolves.toEqual({
      use_org_defaults: true,
      use_platform_defaults: true,
      models: [],
      default_model: null,
    });
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

import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceInboxAddress,
  parseWorkspaceInboxAddress,
} from '../../../src/lib/workspace-email.js';

describe('workspace email address helpers', () => {
  it('builds and parses workspace inbox addresses', () => {
    const address = buildWorkspaceInboxAddress('workspace-123', 'mail.camelai.com', {
      localPart: 'chat',
    });

    expect(address).toBe('chat+workspace-123@mail.camelai.com');

    const parsed = parseWorkspaceInboxAddress(address, {
      expectedDomain: 'mail.camelai.com',
      expectedLocalPart: 'chat',
    });
    expect(parsed).toEqual({
      workspaceId: 'workspace-123',
      domain: 'mail.camelai.com',
    });
  });

  it('rejects non-workspace/multi-detail addresses', () => {
    expect(parseWorkspaceInboxAddress('support@mail.camelai.com')).toBeNull();
    expect(parseWorkspaceInboxAddress('chat+workspace-123+extra@mail.camelai.com', {
      expectedDomain: 'mail.camelai.com',
      expectedLocalPart: 'chat',
    })).toBeNull();
  });
});

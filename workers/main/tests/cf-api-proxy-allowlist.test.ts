import { describe, expect, it } from 'vitest';
import { isAllowedCloudflareApiProxyRequest } from '../src/cf-api-proxy';

const dispatchScriptPath =
  '/client/v4/accounts/account-1/workers/dispatch/namespaces/chiridion/scripts/poll-maker';

describe('isAllowedCloudflareApiProxyRequest', () => {
  it('allows both dispatch script upload endpoints', () => {
    expect(isAllowedCloudflareApiProxyRequest(dispatchScriptPath, 'PUT')).toBe(
      true,
    );
    expect(
      isAllowedCloudflareApiProxyRequest(`${dispatchScriptPath}/content`, 'PUT'),
    ).toBe(true);
  });

  it('allows versioned deploy activation', () => {
    expect(
      isAllowedCloudflareApiProxyRequest(
        `${dispatchScriptPath}/deployments`,
        'POST',
      ),
    ).toBe(true);
  });

  it('keeps neighboring write endpoints blocked by default', () => {
    expect(
      isAllowedCloudflareApiProxyRequest(
        `${dispatchScriptPath}/bindings`,
        'PUT',
      ),
    ).toBe(false);
  });
});

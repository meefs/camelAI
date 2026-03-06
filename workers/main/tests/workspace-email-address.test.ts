import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceInboxAddress,
  parseWorkspaceInboxAddress,
  slugifyWorkspaceName,
} from '../../../src/lib/workspace-email.js';

describe('slugifyWorkspaceName', () => {
  it('converts name to lowercase slug', () => {
    expect(slugifyWorkspaceName('Default Workspace')).toBe('default-workspace');
    expect(slugifyWorkspaceName('My Cool Project')).toBe('my-cool-project');
    expect(slugifyWorkspaceName('  Spaces  ')).toBe('spaces');
  });

  it('strips special characters', () => {
    expect(slugifyWorkspaceName("Miguel's Workspace!")).toBe('miguels-workspace');
    expect(slugifyWorkspaceName('test@#$%name')).toBe('testname');
  });

  it('collapses multiple dashes', () => {
    expect(slugifyWorkspaceName('a---b')).toBe('a-b');
    expect(slugifyWorkspaceName('hello   world')).toBe('hello-world');
  });

  it('returns "workspace" for empty/invalid input', () => {
    expect(slugifyWorkspaceName('')).toBe('workspace');
    expect(slugifyWorkspaceName('!!!')).toBe('workspace');
  });
});

describe('workspace email address helpers', () => {
  it('builds and parses workspace inbox addresses', () => {
    const address = buildWorkspaceInboxAddress('acme-corp-85b', 'Default Workspace', 'mail.camelai.com', {
      localPart: 'chat',
    });

    expect(address).toBe('chat+acme-corp-85b.default-workspace@mail.camelai.com');

    const parsed = parseWorkspaceInboxAddress(address, {
      expectedDomain: 'mail.camelai.com',
      expectedLocalPart: 'chat',
    });
    expect(parsed).toEqual({
      orgSlug: 'acme-corp-85b',
      workspaceSlug: 'default-workspace',
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

  it('rejects addresses without org.workspace dot separator', () => {
    expect(parseWorkspaceInboxAddress('chat+nodotseparator@mail.camelai.com', {
      expectedDomain: 'mail.camelai.com',
      expectedLocalPart: 'chat',
    })).toBeNull();
  });

  it('rejects addresses with empty org or workspace slug', () => {
    expect(parseWorkspaceInboxAddress('chat+.workspace@mail.camelai.com')).toBeNull();
    expect(parseWorkspaceInboxAddress('chat+orgslug.@mail.camelai.com')).toBeNull();
  });
});

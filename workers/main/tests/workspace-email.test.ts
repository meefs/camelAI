import { describe, expect, it } from 'vitest';
import {
  buildFormattedEmailAddress,
  buildWorkspaceEmailAddress,
  buildWorkspaceEmailSenderAddress,
  generateEmailHandle,
  isValidEmailHandle,
  parseWorkspaceEmailAddress,
  slugifyWorkspaceName,
} from '../../../src/lib/workspace-email.js';

describe('generateEmailHandle', () => {
  it('generates three-word hyphenated handles', () => {
    const handle = generateEmailHandle();
    const parts = handle.split('-');
    expect(parts.length).toBe(3);
    expect(isValidEmailHandle(handle)).toBe(true);
  });

  it('generates unique handles', () => {
    const handles = new Set<string>();
    for (let i = 0; i < 100; i++) {
      handles.add(generateEmailHandle());
    }
    expect(handles.size).toBe(100);
  });

  it('generates lowercase handles', () => {
    for (let i = 0; i < 20; i++) {
      const handle = generateEmailHandle();
      expect(handle).toBe(handle.toLowerCase());
    }
  });
});

describe('isValidEmailHandle', () => {
  it('accepts valid three-word handles', () => {
    expect(isValidEmailHandle('swift-falcon-ridge')).toBe(true);
    expect(isValidEmailHandle('bold-oak-mist')).toBe(true);
  });

  it('rejects invalid handles', () => {
    expect(isValidEmailHandle('only-two')).toBe(false);
    expect(isValidEmailHandle('four-word-handle-here')).toBe(false);
    expect(isValidEmailHandle('UPPER-CASE-HANDLE')).toBe(false);
    expect(isValidEmailHandle('')).toBe(false);
    expect(isValidEmailHandle('has+plus@sign')).toBe(false);
  });
});

describe('buildWorkspaceEmailAddress', () => {
  it('builds handle@domain addresses', () => {
    expect(buildWorkspaceEmailAddress('swift-falcon-ridge', 'chiridion.dev'))
      .toBe('swift-falcon-ridge@chiridion.dev');
  });
});

describe('buildFormattedEmailAddress', () => {
  it('adds a display name to an email address', () => {
    expect(buildFormattedEmailAddress('Test Workspace', 'swift-falcon-ridge@chiridion.dev'))
      .toBe('Test Workspace <swift-falcon-ridge@chiridion.dev>');
  });

  it('quotes display names with address header special characters', () => {
    expect(buildFormattedEmailAddress('Acme, Inc', 'swift-falcon-ridge@chiridion.dev'))
      .toBe('"Acme, Inc" <swift-falcon-ridge@chiridion.dev>');
    expect(buildFormattedEmailAddress('Support: West', 'swift-falcon-ridge@chiridion.dev'))
      .toBe('"Support: West" <swift-falcon-ridge@chiridion.dev>');
  });

  it('falls back to a bare address when display name is empty', () => {
    expect(buildFormattedEmailAddress('  ', 'swift-falcon-ridge@chiridion.dev'))
      .toBe('swift-falcon-ridge@chiridion.dev');
  });
});

describe('buildWorkspaceEmailSenderAddress', () => {
  it('builds a simple Camel sender address', () => {
    expect(buildWorkspaceEmailSenderAddress('swift-falcon-ridge', 'chiridion.dev'))
      .toBe('Camel <swift-falcon-ridge@chiridion.dev>');
  });
});

describe('parseWorkspaceEmailAddress', () => {
  it('parses valid workspace email addresses', () => {
    const result = parseWorkspaceEmailAddress('swift-falcon-ridge@chiridion.dev', {
      expectedDomain: 'chiridion.dev',
    });
    expect(result).toEqual({
      emailHandle: 'swift-falcon-ridge',
      domain: 'chiridion.dev',
    });
  });

  it('rejects addresses with wrong domain', () => {
    expect(parseWorkspaceEmailAddress('swift-falcon-ridge@other.com', {
      expectedDomain: 'chiridion.dev',
    })).toBeNull();
  });

  it('rejects non-handle local parts', () => {
    expect(parseWorkspaceEmailAddress('support@chiridion.dev')).toBeNull();
    expect(parseWorkspaceEmailAddress('chat+something@chiridion.dev')).toBeNull();
  });

  it('handles angle-bracket format', () => {
    const result = parseWorkspaceEmailAddress('<swift-falcon-ridge@chiridion.dev>');
    expect(result).toEqual({
      emailHandle: 'swift-falcon-ridge',
      domain: 'chiridion.dev',
    });
  });
});

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

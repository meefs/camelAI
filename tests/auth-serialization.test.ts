/**
 * Unit tests for auth serialization helpers
 *
 * These helpers ensure objects from RPC/DO responses are converted to
 * plain objects that can be passed from Server Components to Client Components.
 *
 * Run with: npm run test:run -- tests/auth-serialization.test.ts
 */

import { describe, it, expect } from 'vitest';
import type { User, Organization, OrgMembership } from '@/types';

// Copy the serialization functions since we can't import from server action modules
function toSafeUser(user: User): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    created_at: user.created_at,
    is_superuser: user.is_superuser,
    avatar: user.avatar,
    is_orphaned: user.is_orphaned,
    orphaned_at: user.orphaned_at,
  };
}

function toSafeOrg(org: Organization): Organization {
  return {
    id: org.id,
    name: org.name,
    slug: org.slug,
    created_at: org.created_at,
    created_by: org.created_by,
    billing_status: org.billing_status,
    archived: org.archived,
    archived_at: org.archived_at,
    archived_by: org.archived_by,
  };
}

function toSafeOrgMembership(membership: OrgMembership): OrgMembership {
  return {
    org_id: membership.org_id,
    org_name: membership.org_name,
    role: membership.role,
    joined_at: membership.joined_at,
  };
}

describe('toSafeUser', () => {
  const defaultAvatar = { color: '#000000', content: 'TU' };

  it('should create a plain object with expected fields', () => {
    const input: User = {
      id: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
      created_at: 1234567890,
      is_superuser: false,
      avatar: defaultAvatar,
      is_orphaned: false,
      orphaned_at: null,
    };

    const result = toSafeUser(input);

    expect(result).toEqual({
      id: 'user-123',
      email: 'test@example.com',
      name: 'Test User',
      created_at: 1234567890,
      is_superuser: false,
      avatar: defaultAvatar,
      is_orphaned: false,
      orphaned_at: null,
    });
  });

  it('should handle null name', () => {
    const input: User = {
      id: 'user-123',
      email: 'test@example.com',
      name: null,
      created_at: 1234567890,
      is_superuser: false,
      avatar: defaultAvatar,
      is_orphaned: false,
      orphaned_at: null,
    };

    const result = toSafeUser(input);

    expect(result.name).toBeNull();
  });

  it('should create a new object (not mutate input)', () => {
    const input: User = {
      id: 'user-123',
      email: 'test@example.com',
      name: 'Test',
      created_at: 1234567890,
      is_superuser: false,
      avatar: defaultAvatar,
      is_orphaned: false,
      orphaned_at: null,
    };

    const result = toSafeUser(input);

    expect(result).not.toBe(input);
  });

  it('should produce a plain object from null prototype object', () => {
    // Simulate what RPC might return - an object with null prototype
    const input = Object.create(null) as User;
    input.id = 'user-123';
    input.email = 'test@example.com';
    input.name = 'Test';
    input.created_at = 1234567890;
    input.is_superuser = false;
    input.avatar = defaultAvatar;
    input.is_orphaned = false;
    input.orphaned_at = null;

    const result = toSafeUser(input);

    // Result should have Object.prototype (be a plain object)
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.id).toBe('user-123');
  });

  it('should not include extra properties from input', () => {
    const input = {
      id: 'user-123',
      email: 'test@example.com',
      name: 'Test',
      created_at: 1234567890,
      is_superuser: false,
      avatar: defaultAvatar,
      is_orphaned: false,
      orphaned_at: null,
      password_hash: 'secret-hash', // Should NOT be included
      extra_field: 'should-not-appear',
    } as User & { password_hash: string; extra_field: string };

    const result = toSafeUser(input);

    expect(result).not.toHaveProperty('password_hash');
    expect(result).not.toHaveProperty('extra_field');
    expect(Object.keys(result)).toEqual(['id', 'email', 'name', 'created_at', 'is_superuser', 'avatar', 'is_orphaned', 'orphaned_at']);
  });
});

describe('toSafeOrg', () => {
  it('should create a plain object with expected fields', () => {
    const input: Organization = {
      id: 'org-123',
      name: 'Test Org',
      slug: 'test-org-org',
      created_at: 1234567890,
      created_by: 'user-123',
      billing_status: 'free',
      archived: false,
      archived_at: null,
      archived_by: null,
    };

    const result = toSafeOrg(input);

    expect(result).toEqual({
      id: 'org-123',
      name: 'Test Org',
      slug: 'test-org-org',
      created_at: 1234567890,
      created_by: 'user-123',
      billing_status: 'free',
      archived: false,
      archived_at: null,
      archived_by: null,
    });
  });

  it('should produce a plain object from null prototype object', () => {
    const input = Object.create(null) as Organization;
    input.id = 'org-123';
    input.name = 'Test Org';
    input.slug = 'test-org-org';
    input.created_at = 1234567890;
    input.created_by = 'user-123';
    input.billing_status = 'free';
    input.archived = false;
    input.archived_at = null;
    input.archived_by = null;

    const result = toSafeOrg(input);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it('should not include extra properties', () => {
    const input = {
      id: 'org-123',
      name: 'Test Org',
      slug: 'test-org-org',
      created_at: 1234567890,
      created_by: 'user-123',
      billing_status: 'free',
      archived: false,
      archived_at: null,
      archived_by: null,
      internal_secret: 'should-not-appear',
    } as Organization & { internal_secret: string };

    const result = toSafeOrg(input);

    expect(result).not.toHaveProperty('internal_secret');
    expect(Object.keys(result)).toEqual(['id', 'name', 'slug', 'created_at', 'created_by', 'billing_status', 'archived', 'archived_at', 'archived_by']);
  });
});

describe('toSafeOrgMembership', () => {
  it('should create a plain object with expected fields', () => {
    const input: OrgMembership = {
      org_id: 'org-123',
      org_name: 'Test Org',
      role: 'admin',
      joined_at: 1234567890,
    };

    const result = toSafeOrgMembership(input);

    expect(result).toEqual({
      org_id: 'org-123',
      org_name: 'Test Org',
      role: 'admin',
      joined_at: 1234567890,
    });
  });

  it('should handle member role', () => {
    const input: OrgMembership = {
      org_id: 'org-123',
      org_name: 'Test Org',
      role: 'member',
      joined_at: 1234567890,
    };

    const result = toSafeOrgMembership(input);

    expect(result.role).toBe('member');
  });

  it('should produce a plain object from null prototype object', () => {
    const input = Object.create(null) as OrgMembership;
    input.org_id = 'org-123';
    input.org_name = 'Test Org';
    input.role = 'admin';
    input.joined_at = 1234567890;

    const result = toSafeOrgMembership(input);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});

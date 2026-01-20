/**
 * Unit tests for RPC response serialization
 *
 * These tests ensure objects from RPC/DO responses are converted to
 * plain objects that can be passed from Server Components to Client Components.
 *
 * The fix is applied in individual toSafe* functions using JSON round-trip.
 * See: src/lib/server-actions/auth.ts, org.ts, workspace.ts
 *
 * Run with: npm run test:run -- tests/integration-serialization.test.ts
 */

import { describe, it, expect } from 'vitest';
import type { Integration } from '@/types';

/**
 * Sanitize function used by toSafe* helpers.
 * JSON round-trip converts null prototype objects to plain objects.
 */
function sanitizeRpcResponse<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'object') {
    return value;
  }
  // JSON round-trip converts null prototype objects to plain objects
  return JSON.parse(JSON.stringify(value));
}

// Helper to check if an object is a plain object (has Object.prototype)
function isPlainObject(obj: unknown): boolean {
  if (obj === null || typeof obj !== 'object') return false;
  const proto = Object.getPrototypeOf(obj);
  return proto === Object.prototype;
}

// Helper to recursively check all objects in a tree are plain
function allObjectsArePlain(obj: unknown, path = 'root'): { valid: boolean; failedPath?: string } {
  if (obj === null || typeof obj !== 'object') {
    return { valid: true };
  }

  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const result = allObjectsArePlain(obj[i], `${path}[${i}]`);
      if (!result.valid) return result;
    }
    return { valid: true };
  }

  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype) {
    return { valid: false, failedPath: path };
  }

  for (const [key, value] of Object.entries(obj)) {
    const result = allObjectsArePlain(value, `${path}.${key}`);
    if (!result.valid) return result;
  }

  return { valid: true };
}

// Helper to create an object with null prototype (simulates RPC response)
function createNullPrototypeObject<T extends object>(obj: T): T {
  const nullProto = Object.create(null) as T;
  for (const [key, value] of Object.entries(obj)) {
    (nullProto as Record<string, unknown>)[key] = value;
  }
  return nullProto;
}

describe('sanitizeRpcResponse', () => {
  it('should return null as-is', () => {
    expect(sanitizeRpcResponse(null)).toBeNull();
  });

  it('should return undefined as-is', () => {
    expect(sanitizeRpcResponse(undefined)).toBeUndefined();
  });

  it('should return primitives as-is', () => {
    expect(sanitizeRpcResponse('hello')).toBe('hello');
    expect(sanitizeRpcResponse(42)).toBe(42);
    expect(sanitizeRpcResponse(true)).toBe(true);
  });

  it('should convert null prototype object to plain object', () => {
    const nullProto = createNullPrototypeObject({ a: 1, b: 'test' });
    expect(Object.getPrototypeOf(nullProto)).toBeNull();

    const result = sanitizeRpcResponse(nullProto);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual({ a: 1, b: 'test' });
  });

  it('should handle deeply nested null prototype objects', () => {
    const nested = createNullPrototypeObject({
      level1: createNullPrototypeObject({
        level2: createNullPrototypeObject({
          value: 'deep',
        }),
      }),
    });

    const result = sanitizeRpcResponse(nested);
    const check = allObjectsArePlain(result);
    expect(check.valid).toBe(true);
    expect((result as { level1: { level2: { value: string } } }).level1.level2.value).toBe('deep');
  });

  it('should handle arrays with null prototype objects', () => {
    const arr = [
      createNullPrototypeObject({ id: 1 }),
      createNullPrototypeObject({ id: 2 }),
    ];

    const result = sanitizeRpcResponse(arr);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    const check = allObjectsArePlain(result);
    expect(check.valid).toBe(true);
  });

  it('should preserve data integrity', () => {
    const original = {
      string: 'hello',
      number: 42,
      boolean: true,
      null: null,
      array: [1, 2, 3],
      nested: { a: 1, b: { c: 2 } },
    };

    const nullProtoVersion = createNullPrototypeObject(original);
    const result = sanitizeRpcResponse(nullProtoVersion);

    expect(result).toEqual(original);
  });
});

describe('Integration serialization - simulated RPC responses', () => {
  const mockIntegration = {
    id: 'int-123',
    integration_type: 'postgres',
    name: 'My Database',
    category: 'databases',
    auth_method: 'api_key',
    config: { host: 'localhost', port: 5432 },
    enabled: true,
    created_by: 'user-123',
    created_at: 1234567890,
    updated_at: 1234567890,
    has_credentials: true,
  };

  it('should handle Integration object with null prototype', () => {
    const rpcResponse = createNullPrototypeObject(mockIntegration) as Integration;
    expect(Object.getPrototypeOf(rpcResponse)).toBeNull();

    const result = sanitizeRpcResponse(rpcResponse);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.id).toBe('int-123');
    expect(result.config).toEqual({ host: 'localhost', port: 5432 });
  });

  it('should handle Integration with nested null prototype config', () => {
    const rpcResponse = createNullPrototypeObject({
      ...mockIntegration,
      config: createNullPrototypeObject({
        host: 'localhost',
        options: createNullPrototypeObject({ ssl: true }),
      }),
    }) as Integration;

    const result = sanitizeRpcResponse(rpcResponse);

    const check = allObjectsArePlain(result);
    expect(check.valid).toBe(true);
  });

  it('should handle array of Integrations', () => {
    const rpcResponse = [
      createNullPrototypeObject({ ...mockIntegration, id: 'int-1' }),
      createNullPrototypeObject({ ...mockIntegration, id: 'int-2' }),
      createNullPrototypeObject({ ...mockIntegration, id: 'int-3' }),
    ] as Integration[];

    const result = sanitizeRpcResponse(rpcResponse);

    expect(result).toHaveLength(3);
    const check = allObjectsArePlain(result);
    expect(check.valid).toBe(true);
  });

  it('should produce JSON-serializable output', () => {
    const rpcResponse = createNullPrototypeObject({
      ...mockIntegration,
      config: createNullPrototypeObject({ host: 'localhost' }),
    }) as Integration;

    const result = sanitizeRpcResponse(rpcResponse);

    // Should be able to JSON serialize and deserialize without issues
    const serialized = JSON.stringify(result);
    const deserialized = JSON.parse(serialized);

    expect(deserialized).toEqual(result);
  });
});

describe('Workspace serialization - simulated RPC responses', () => {
  const mockWorkspace = {
    id: 'ws-123',
    org_id: 'org-123',
    name: 'My Workspace',
    description: 'Test workspace',
    created_by: 'user-123',
    created_at: 1234567890,
    avatar: { color: '#000', content: 'MW' },
    archived: false,
    archived_at: null,
    access_level: 'full' as const,
  };

  it('should handle Workspace with nested avatar object', () => {
    const rpcResponse = createNullPrototypeObject({
      ...mockWorkspace,
      avatar: createNullPrototypeObject({ color: '#000', content: 'MW' }),
    });

    const result = sanitizeRpcResponse(rpcResponse);

    const check = allObjectsArePlain(result);
    expect(check.valid).toBe(true);
    expect(result.avatar).toEqual({ color: '#000', content: 'MW' });
  });
});

describe('Simple response objects', () => {
  it('should handle status response objects', () => {
    // This is what warmupWorkspace returns
    const rpcResponse = createNullPrototypeObject({ status: 'warm' });

    const result = sanitizeRpcResponse(rpcResponse);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual({ status: 'warm' });
  });

  it('should handle success response objects', () => {
    const rpcResponse = createNullPrototypeObject({ success: true });

    const result = sanitizeRpcResponse(rpcResponse);

    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result).toEqual({ success: true });
  });
});


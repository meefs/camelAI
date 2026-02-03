import { describe, it, expect } from 'vitest';
import { validateBindings, type WorkerBinding } from '../src/cf-api-proxy.js';

describe('Worker Binding Validation', () => {
  describe('validateBindings', () => {
    it('allows empty bindings array', () => {
      const result = validateBindings([]);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows plain_text environment variables', () => {
      const bindings: WorkerBinding[] = [
        { type: 'plain_text', name: 'MY_VAR' },
        { type: 'plain_text', name: 'ANOTHER_VAR' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows secret_text environment variables', () => {
      const bindings: WorkerBinding[] = [
        { type: 'secret_text', name: 'API_KEY' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows json environment variables', () => {
      const bindings: WorkerBinding[] = [
        { type: 'json', name: 'CONFIG' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows local Durable Objects (no script_name)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'durable_object_namespace', name: 'MY_DO', class_name: 'MyDurableObject' },
        { type: 'durable_object_namespace', name: 'ANOTHER_DO', class_name: 'AnotherDO' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows wasm_module bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'wasm_module', name: 'WASM' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows text_blob and data_blob bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'text_blob', name: 'TEXT_DATA' },
        { type: 'data_blob', name: 'BINARY_DATA' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows assets bindings (static assets bundled with worker)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'assets', name: 'ASSETS' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('blocks external Durable Objects (with script_name)', () => {
      const bindings: WorkerBinding[] = [
        { type: 'durable_object_namespace', name: 'EXTERNAL_DO', class_name: 'SomeClass', script_name: 'other-worker' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('EXTERNAL_DO');
      expect(result.forbiddenBindings[0]?.type).toBe('durable_object_namespace');
      expect(result.forbiddenBindings[0]?.reason).toContain('External Durable Object');
    });

    it('blocks KV namespace bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'kv_namespace', name: 'MY_KV', namespace_id: 'some-id' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('MY_KV');
      expect(result.forbiddenBindings[0]?.type).toBe('kv_namespace');
    });

    it('blocks D1 database bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'd1', name: 'MY_DB', database_id: 'some-id' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('MY_DB');
      expect(result.forbiddenBindings[0]?.type).toBe('d1');
    });

    it('blocks R2 bucket bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'r2_bucket', name: 'MY_BUCKET', bucket_name: 'some-bucket' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('MY_BUCKET');
      expect(result.forbiddenBindings[0]?.type).toBe('r2_bucket');
    });

    it('blocks queue bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'queue', name: 'MY_QUEUE' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('MY_QUEUE');
      expect(result.forbiddenBindings[0]?.type).toBe('queue');
    });

    it('blocks service bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'service', name: 'OTHER_WORKER' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('OTHER_WORKER');
      expect(result.forbiddenBindings[0]?.type).toBe('service');
    });

    it('blocks analytics_engine bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'analytics_engine', name: 'ANALYTICS' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('ANALYTICS');
      expect(result.forbiddenBindings[0]?.type).toBe('analytics_engine');
    });

    it('blocks ai bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'ai', name: 'AI' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('AI');
      expect(result.forbiddenBindings[0]?.type).toBe('ai');
    });

    it('blocks browser rendering bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'browser', name: 'BROWSER' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('BROWSER');
      expect(result.forbiddenBindings[0]?.type).toBe('browser');
    });

    it('blocks vectorize bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'vectorize', name: 'VECTORS' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('VECTORS');
      expect(result.forbiddenBindings[0]?.type).toBe('vectorize');
    });

    it('blocks hyperdrive bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'hyperdrive', name: 'HYPERDRIVE' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('HYPERDRIVE');
      expect(result.forbiddenBindings[0]?.type).toBe('hyperdrive');
    });

    it('blocks dispatch_namespace bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'dispatch_namespace', name: 'DISPATCH' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('DISPATCH');
      expect(result.forbiddenBindings[0]?.type).toBe('dispatch_namespace');
    });

    it('blocks mtls_certificate bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'mtls_certificate', name: 'CERT' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('CERT');
      expect(result.forbiddenBindings[0]?.type).toBe('mtls_certificate');
    });

    it('blocks send_email bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'send_email', name: 'EMAIL' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('EMAIL');
      expect(result.forbiddenBindings[0]?.type).toBe('send_email');
    });

    it('blocks unknown binding types', () => {
      const bindings: WorkerBinding[] = [
        { type: 'some_future_binding', name: 'UNKNOWN' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(1);
      expect(result.forbiddenBindings[0]?.name).toBe('UNKNOWN');
      expect(result.forbiddenBindings[0]?.type).toBe('some_future_binding');
      expect(result.forbiddenBindings[0]?.reason).toContain('Unknown binding type');
    });

    it('reports all forbidden bindings in a mixed set', () => {
      const bindings: WorkerBinding[] = [
        // Allowed
        { type: 'plain_text', name: 'ENV_VAR' },
        { type: 'durable_object_namespace', name: 'LOCAL_DO', class_name: 'MyClass' },
        // Forbidden
        { type: 'kv_namespace', name: 'KV1', namespace_id: 'id1' },
        { type: 'd1', name: 'DB1', database_id: 'id2' },
        { type: 'durable_object_namespace', name: 'EXTERNAL_DO', class_name: 'Class', script_name: 'other' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(false);
      expect(result.forbiddenBindings).toHaveLength(3);

      const forbiddenNames = result.forbiddenBindings.map(b => b.name);
      expect(forbiddenNames).toContain('KV1');
      expect(forbiddenNames).toContain('DB1');
      expect(forbiddenNames).toContain('EXTERNAL_DO');
    });

    it('allows a realistic worker with only valid bindings', () => {
      const bindings: WorkerBinding[] = [
        { type: 'plain_text', name: 'APP_NAME' },
        { type: 'secret_text', name: 'API_KEY' },
        { type: 'json', name: 'CONFIG' },
        { type: 'durable_object_namespace', name: 'COUNTER', class_name: 'Counter' },
        { type: 'durable_object_namespace', name: 'SESSION', class_name: 'Session' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });

    it('allows a full-stack app with assets and Durable Objects', () => {
      const bindings: WorkerBinding[] = [
        { type: 'assets', name: 'ASSETS' },
        { type: 'durable_object_namespace', name: 'ROOMS', class_name: 'ChatRoom' },
        { type: 'plain_text', name: 'PUBLIC_URL' },
        { type: 'secret_text', name: 'JWT_SECRET' },
      ];
      const result = validateBindings(bindings);
      expect(result.valid).toBe(true);
      expect(result.forbiddenBindings).toHaveLength(0);
    });
  });
});

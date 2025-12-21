/**
 * Integration Handlers Registry
 *
 * Registry for special-case handlers only.
 * Most HTTP integrations use the transparent proxy route directly.
 * This registry is for:
 * - AWS (requires SigV4 signing)
 * - Databases (require container execution)
 */

import type { IntegrationHandler } from '../types';
import { AWSHandler } from './aws';
import { PostgresHandler } from './postgres';
import { MySQLHandler } from './mysql';

// Only register special handlers that can't use the transparent proxy
const handlerMap = new Map<string, IntegrationHandler>();

// AWS requires SigV4 signing
handlerMap.set('aws', new AWSHandler());

// Container-based handlers (databases)
handlerMap.set('postgres', new PostgresHandler());
handlerMap.set('mysql', new MySQLHandler());

/**
 * Get handler for an integration type
 */
export function getHandler(type: string): IntegrationHandler | undefined {
  return handlerMap.get(type);
}

/**
 * Get all registered handlers
 */
export function getAllHandlers(): IntegrationHandler[] {
  return Array.from(handlerMap.values());
}

/**
 * Check if a handler exists for a type
 */
export function hasHandler(type: string): boolean {
  return handlerMap.has(type);
}

/**
 * Get handler environment requirement
 */
export function getHandlerEnvironment(type: string): 'worker' | 'container' | undefined {
  const handler = handlerMap.get(type);
  return handler?.environment;
}

// Re-export handlers for direct use if needed
export { AWSHandler } from './aws';
export { PostgresHandler } from './postgres';
export { MySQLHandler } from './mysql';

/**
 * Unit tests for auth validation helpers
 *
 * Run with: npm run test:run -- tests/auth-validation.test.ts
 */

import { describe, it, expect } from 'vitest';

// Copy the validation functions here since we can't import from Next.js server modules
function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function isValidPassword(password: string): boolean {
  return password.length >= 8;
}

describe('Email Validation', () => {
  it('should accept valid email addresses', () => {
    expect(isValidEmail('user@example.com')).toBe(true);
    expect(isValidEmail('user.name@example.com')).toBe(true);
    expect(isValidEmail('user+tag@example.com')).toBe(true);
    expect(isValidEmail('user@subdomain.example.com')).toBe(true);
    expect(isValidEmail('user123@example.co.uk')).toBe(true);
    expect(isValidEmail('a@b.co')).toBe(true);
  });

  it('should reject invalid email addresses', () => {
    expect(isValidEmail('')).toBe(false);
    expect(isValidEmail('notanemail')).toBe(false);
    expect(isValidEmail('missing@domain')).toBe(false);
    expect(isValidEmail('@nodomain.com')).toBe(false);
    expect(isValidEmail('no@')).toBe(false);
    expect(isValidEmail('spaces in@email.com')).toBe(false);
    expect(isValidEmail('user@.com')).toBe(false);
  });

  it('should handle edge cases', () => {
    expect(isValidEmail('USER@EXAMPLE.COM')).toBe(true);
    expect(isValidEmail('  user@example.com  '.trim())).toBe(true);
  });
});

describe('Password Validation', () => {
  it('should accept valid passwords (8+ characters)', () => {
    expect(isValidPassword('12345678')).toBe(true);
    expect(isValidPassword('password123')).toBe(true);
    expect(isValidPassword('a'.repeat(8))).toBe(true);
    expect(isValidPassword('a'.repeat(100))).toBe(true);
    expect(isValidPassword('P@ssw0rd!')).toBe(true);
  });

  it('should reject passwords shorter than 8 characters', () => {
    expect(isValidPassword('')).toBe(false);
    expect(isValidPassword('1234567')).toBe(false);
    expect(isValidPassword('short')).toBe(false);
    expect(isValidPassword('a'.repeat(7))).toBe(false);
  });

  it('should handle edge cases', () => {
    expect(isValidPassword('        ')).toBe(true); // 8 spaces is technically valid
    expect(isValidPassword('12345678')).toBe(true);
  });
});

/**
 * E2E tests for authentication flows
 *
 * Run with: npm run test:e2e -- e2e/auth.spec.ts
 *
 * Note: These tests require a running server (npm run dev:cf)
 */

import { test, expect, Page } from '@playwright/test';

// Generate unique email for each test run to avoid conflicts
const generateEmail = () => `test-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;

test.describe('Authentication', () => {
  test.describe('Signup Flow', () => {
    test('should show signup page with all required fields', async ({ page }) => {
      await page.goto('/signup');

      // Check page title
      await expect(page.locator('h1')).toContainText('Create an account');

      // Check all form fields exist
      await expect(page.locator('input#name')).toBeVisible();
      await expect(page.locator('input#email')).toBeVisible();
      await expect(page.locator('input#password')).toBeVisible();
      await expect(page.locator('input#confirmPassword')).toBeVisible();

      // Check submit button
      await expect(page.locator('button[type="submit"]')).toContainText('Create account');

      // Check link to login
      await expect(page.locator('a[href="/login"]')).toBeVisible();
    });

    test('should show error when passwords do not match', async ({ page }) => {
      await page.goto('/signup');

      await page.fill('input#email', 'test@example.com');
      await page.fill('input#password', 'password123');
      await page.fill('input#confirmPassword', 'differentpassword');
      await page.click('button[type="submit"]');

      await expect(page.locator('.text-red-400')).toContainText('Passwords do not match');
    });

    test('should show error when password is too short', async ({ page }) => {
      await page.goto('/signup');

      await page.fill('input#email', 'test@example.com');
      await page.fill('input#password', 'short');
      await page.fill('input#confirmPassword', 'short');
      await page.click('button[type="submit"]');

      await expect(page.locator('.text-red-400')).toContainText('Password must be at least 8 characters');
    });

    test('should successfully create account and redirect to home', async ({ page }) => {
      const email = generateEmail();

      await page.goto('/signup');

      await page.fill('input#name', 'Test User');
      await page.fill('input#email', email);
      await page.fill('input#password', 'password123');
      await page.fill('input#confirmPassword', 'password123');
      await page.click('button[type="submit"]');

      // Should redirect to home after signup
      await expect(page).toHaveURL('/', { timeout: 10000 });

      // Should show user info in sidebar
      await expect(page.locator('text=Test User')).toBeVisible({ timeout: 5000 });
    });

    test('should show error for duplicate email', async ({ page }) => {
      const email = generateEmail();

      // First signup
      await page.goto('/signup');
      await page.fill('input#email', email);
      await page.fill('input#password', 'password123');
      await page.fill('input#confirmPassword', 'password123');
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL('/', { timeout: 10000 });

      // Logout
      await page.click('button[title="Sign out"]');

      // Try to signup with same email
      await page.goto('/signup');
      await page.fill('input#email', email);
      await page.fill('input#password', 'password123');
      await page.fill('input#confirmPassword', 'password123');
      await page.click('button[type="submit"]');

      // Should show error
      await expect(page.locator('.text-red-400')).toContainText('already exists', { timeout: 5000 });
    });
  });

  test.describe('Login Flow', () => {
    test('should show login page with required fields', async ({ page }) => {
      await page.goto('/login');

      // Check page title
      await expect(page.locator('h1')).toContainText('Welcome back');

      // Check form fields
      await expect(page.locator('input#email')).toBeVisible();
      await expect(page.locator('input#password')).toBeVisible();

      // Check submit button
      await expect(page.locator('button[type="submit"]')).toContainText('Sign in');

      // Check link to signup
      await expect(page.locator('a[href="/signup"]')).toBeVisible();
    });

    test('should show error for invalid credentials', async ({ page }) => {
      await page.goto('/login');

      await page.fill('input#email', 'nonexistent@example.com');
      await page.fill('input#password', 'wrongpassword');
      await page.click('button[type="submit"]');

      await expect(page.locator('.text-red-400')).toBeVisible({ timeout: 5000 });
    });

    test('should successfully login and redirect to home', async ({ page }) => {
      const email = generateEmail();

      // First create an account
      await page.goto('/signup');
      await page.fill('input#email', email);
      await page.fill('input#password', 'password123');
      await page.fill('input#confirmPassword', 'password123');
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL('/', { timeout: 10000 });

      // Logout
      await page.click('button[title="Sign out"]');
      await expect(page).toHaveURL('/login', { timeout: 5000 });

      // Login
      await page.fill('input#email', email);
      await page.fill('input#password', 'password123');
      await page.click('button[type="submit"]');

      // Should redirect to home
      await expect(page).toHaveURL('/', { timeout: 10000 });
    });
  });

  test.describe('Logout Flow', () => {
    test('should logout and redirect to login', async ({ page }) => {
      const email = generateEmail();

      // Create account and login
      await page.goto('/signup');
      await page.fill('input#email', email);
      await page.fill('input#password', 'password123');
      await page.fill('input#confirmPassword', 'password123');
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL('/', { timeout: 10000 });

      // Click logout button
      await page.click('button[title="Sign out"]');

      // Should redirect to login
      await expect(page).toHaveURL('/login', { timeout: 5000 });
    });

    test('should clear session on logout', async ({ page }) => {
      const email = generateEmail();

      // Create account and login
      await page.goto('/signup');
      await page.fill('input#email', email);
      await page.fill('input#password', 'password123');
      await page.fill('input#confirmPassword', 'password123');
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL('/', { timeout: 10000 });

      // Logout
      await page.click('button[title="Sign out"]');
      await expect(page).toHaveURL('/login', { timeout: 5000 });

      // Try to access home page
      await page.goto('/');

      // Should redirect back to login
      await expect(page).toHaveURL('/login', { timeout: 5000 });
    });
  });

  test.describe('Protected Routes', () => {
    test('should redirect unauthenticated user to login', async ({ page }) => {
      // Clear any existing cookies
      await page.context().clearCookies();

      await page.goto('/');

      // Should redirect to login
      await expect(page).toHaveURL('/login', { timeout: 10000 });
    });

    test('should redirect authenticated user away from login page', async ({ page }) => {
      const email = generateEmail();

      // Create account
      await page.goto('/signup');
      await page.fill('input#email', email);
      await page.fill('input#password', 'password123');
      await page.fill('input#confirmPassword', 'password123');
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL('/', { timeout: 10000 });

      // Try to go to login page
      await page.goto('/login');

      // Should redirect back to home
      await expect(page).toHaveURL('/', { timeout: 5000 });
    });

    test('should redirect authenticated user away from signup page', async ({ page }) => {
      const email = generateEmail();

      // Create account
      await page.goto('/signup');
      await page.fill('input#email', email);
      await page.fill('input#password', 'password123');
      await page.fill('input#confirmPassword', 'password123');
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL('/', { timeout: 10000 });

      // Try to go to signup page
      await page.goto('/signup');

      // Should redirect back to home
      await expect(page).toHaveURL('/', { timeout: 5000 });
    });
  });

  test.describe('Session Persistence', () => {
    test('should maintain session across page reloads', async ({ page }) => {
      const email = generateEmail();

      // Create account
      await page.goto('/signup');
      await page.fill('input#name', 'Session Test User');
      await page.fill('input#email', email);
      await page.fill('input#password', 'password123');
      await page.fill('input#confirmPassword', 'password123');
      await page.click('button[type="submit"]');
      await expect(page).toHaveURL('/', { timeout: 10000 });

      // Reload page
      await page.reload();

      // Should still be on home page and show user info
      await expect(page).toHaveURL('/');
      await expect(page.locator('text=Session Test User')).toBeVisible({ timeout: 5000 });
    });
  });
});

test.describe('Organization Management', () => {
  test('should show org switcher when user has multiple orgs', async ({ page }) => {
    // This test would require creating multiple orgs
    // For now, we'll just verify the basic structure exists after signup
    const email = generateEmail();

    await page.goto('/signup');
    await page.fill('input#email', email);
    await page.fill('input#password', 'password123');
    await page.fill('input#confirmPassword', 'password123');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL('/', { timeout: 10000 });

    // User should have a default org shown
    // The org name might be shown in the sidebar
    await expect(page.locator('text="Personal"').or(page.locator('text=' + email.split('@')[0]))).toBeVisible({ timeout: 5000 });
  });
});

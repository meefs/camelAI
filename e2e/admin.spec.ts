/**
 * E2E tests for admin panel
 *
 * Run with: npm run test:e2e -- e2e/admin.spec.ts
 *
 * Note: These tests require a running server (npm run dev)
 *
 * Superuser tests require an account with an email in the SUPERUSER_EMAILS allowlist
 * (defined in worker/auth.ts). For local testing, add a test email to that list.
 */

import { test, expect, Page } from '@playwright/test';

// Generate unique email for each test run
const generateEmail = () =>
  `test-${Date.now()}-${Math.random().toString(36).substring(7)}@example.com`;

// Superuser email - must be in SUPERUSER_EMAILS allowlist in worker/auth.ts
// For CI, add 'admin-test@example.com' to the allowlist or use env var
const SUPERUSER_EMAIL = process.env.SUPERUSER_TEST_EMAIL || 'admin-test@example.com';
const SUPERUSER_PASSWORD = 'testpassword123';

/**
 * Helper to create a regular (non-superuser) account and login
 */
async function loginAsRegularUser(page: Page): Promise<string> {
  const email = generateEmail();

  await page.goto('/signup');
  await page.fill('input#email', email);
  await page.fill('input#password', 'password123');
  await page.fill('input#confirmPassword', 'password123');
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/', { timeout: 10000 });

  return email;
}

/**
 * Helper to login as superuser
 * Assumes the superuser account already exists (created manually or in test setup)
 */
async function loginAsSuperuser(page: Page): Promise<void> {
  await page.goto('/login');
  await page.fill('input#email', SUPERUSER_EMAIL);
  await page.fill('input#password', SUPERUSER_PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/', { timeout: 10000 });
}

/**
 * Helper to ensure superuser account exists
 */
async function ensureSuperuserExists(page: Page): Promise<boolean> {
  // Try to login first
  await page.goto('/login');
  await page.fill('input#email', SUPERUSER_EMAIL);
  await page.fill('input#password', SUPERUSER_PASSWORD);
  await page.click('button[type="submit"]');

  // Check if login succeeded or if we need to create account
  try {
    await expect(page).toHaveURL('/', { timeout: 5000 });
    // Logout so tests start fresh
    await page.click('button[title="Sign out"]');
    await expect(page).toHaveURL('/login', { timeout: 5000 });
    return true;
  } catch {
    // Login failed, try to create account
    await page.goto('/signup');
    await page.fill('input#email', SUPERUSER_EMAIL);
    await page.fill('input#password', SUPERUSER_PASSWORD);
    await page.fill('input#confirmPassword', SUPERUSER_PASSWORD);
    await page.click('button[type="submit"]');

    try {
      await expect(page).toHaveURL('/', { timeout: 10000 });
      await page.click('button[title="Sign out"]');
      await expect(page).toHaveURL('/login', { timeout: 5000 });
      return true;
    } catch {
      // Could not create account either
      return false;
    }
  }
}

test.describe('Admin Panel - Access Control', () => {
  test('non-superuser should get 404 when accessing admin panel', async ({ page }) => {
    // Login as regular user
    await loginAsRegularUser(page);

    // Try to access admin panel
    const response = await page.goto('/qaml-backdoor');

    // Should get 404 Not Found
    expect(response?.status()).toBe(404);
  });

  test('non-superuser should get 404 on all admin routes', async ({ page }) => {
    await loginAsRegularUser(page);

    // Test all admin routes return 404
    const adminRoutes = [
      '/qaml-backdoor',
      '/qaml-backdoor/users',
      '/qaml-backdoor/orgs',
      '/qaml-backdoor/projects',
      '/qaml-backdoor/threads',
    ];

    for (const route of adminRoutes) {
      const response = await page.goto(route);
      expect(response?.status(), `Expected 404 for ${route}`).toBe(404);
    }
  });

  test('unauthenticated user should be redirected to login', async ({ page }) => {
    // Clear cookies
    await page.context().clearCookies();

    await page.goto('/qaml-backdoor');

    // Should redirect to login
    await expect(page).toHaveURL('/login', { timeout: 10000 });
  });
});

test.describe('Admin Panel - Superuser Access', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const exists = await ensureSuperuserExists(page);
    await page.close();

    if (!exists) {
      test.skip();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsSuperuser(page);
  });

  test('superuser can access admin dashboard', async ({ page }) => {
    await page.goto('/qaml-backdoor');

    // Should see the admin dashboard
    await expect(page.locator('h1')).toContainText('QAML Backdoor');

    // Should see stat cards
    await expect(page.locator('text=Users')).toBeVisible();
    await expect(page.locator('text=Organizations')).toBeVisible();
    await expect(page.locator('text=Projects')).toBeVisible();
    await expect(page.locator('text=Threads')).toBeVisible();
  });

  test('superuser can navigate to users page', async ({ page }) => {
    await page.goto('/qaml-backdoor');

    // Click on Users card
    await page.click('a:has-text("Users")');

    await expect(page).toHaveURL('/qaml-backdoor/users');
    await expect(page.locator('h1')).toContainText('Users');
  });

  test('superuser can navigate to orgs page', async ({ page }) => {
    await page.goto('/qaml-backdoor');

    await page.click('a:has-text("Organizations")');

    await expect(page).toHaveURL('/qaml-backdoor/orgs');
    await expect(page.locator('h1')).toContainText('Organizations');
  });

  test('superuser can navigate to projects page', async ({ page }) => {
    await page.goto('/qaml-backdoor');

    await page.click('a:has-text("Projects")');

    await expect(page).toHaveURL('/qaml-backdoor/projects');
    await expect(page.locator('h1')).toContainText('Projects');
  });

  test('superuser can navigate to threads page', async ({ page }) => {
    await page.goto('/qaml-backdoor');

    await page.click('a:has-text("Threads")');

    await expect(page).toHaveURL('/qaml-backdoor/threads');
    await expect(page.locator('h1')).toContainText('Threads');
  });
});

test.describe('Admin Panel - User Detail and Edit', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const exists = await ensureSuperuserExists(page);
    await page.close();

    if (!exists) {
      test.skip();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsSuperuser(page);
  });

  test('can view user detail page', async ({ page }) => {
    await page.goto('/qaml-backdoor/users');

    // Click on first user in the table
    await page.click('table tbody tr:first-child a');

    // Should be on user detail page
    await expect(page.locator('text=User Details')).toBeVisible();
    await expect(page.locator('text=Edit User')).toBeVisible();
  });

  test('can edit user name', async ({ page }) => {
    await page.goto('/qaml-backdoor/users');

    // Click on first user
    await page.click('table tbody tr:first-child a');

    // Find the name input and update it
    const nameInput = page.locator('input[name="name"]');
    const originalName = await nameInput.inputValue();
    const newName = `Test User ${Date.now()}`;

    await nameInput.fill(newName);
    await page.click('button:has-text("Save Changes")');

    // Should see success state (page refreshes or shows confirmation)
    await expect(page.locator(`text=${newName}`)).toBeVisible({ timeout: 5000 });

    // Restore original name
    await nameInput.fill(originalName || '');
    await page.click('button:has-text("Save Changes")');
  });
});

test.describe('Admin Panel - Organization Detail', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const exists = await ensureSuperuserExists(page);
    await page.close();

    if (!exists) {
      test.skip();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsSuperuser(page);
  });

  test('can view org detail page with members', async ({ page }) => {
    await page.goto('/qaml-backdoor/orgs');

    // Click on first org in the table
    await page.click('table tbody tr:first-child a');

    // Should see org detail sections
    await expect(page.locator('text=Organization Details')).toBeVisible();
    await expect(page.locator('text=Members')).toBeVisible();
  });

  test('org detail shows member links to user pages', async ({ page }) => {
    await page.goto('/qaml-backdoor/orgs');
    await page.click('table tbody tr:first-child a');

    // Find a member link
    const memberLink = page.locator('text=Members').locator('..').locator('a[href*="/qaml-backdoor/users/"]').first();

    if (await memberLink.isVisible()) {
      await memberLink.click();
      await expect(page).toHaveURL(/\/qaml-backdoor\/users\/.+/);
    }
  });
});

test.describe('Admin Panel - Pagination', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const exists = await ensureSuperuserExists(page);
    await page.close();

    if (!exists) {
      test.skip();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsSuperuser(page);
  });

  test('pagination controls are visible when there are items', async ({ page }) => {
    await page.goto('/qaml-backdoor/users');

    // Check for pagination info text (e.g., "Showing 1-50 of X")
    const paginationText = page.locator('text=/Showing \\d+/');
    await expect(paginationText).toBeVisible();
  });

  test('can navigate pages if multiple pages exist', async ({ page }) => {
    await page.goto('/qaml-backdoor/users');

    // Look for next button
    const nextButton = page.locator('a:has-text("Next")');

    if (await nextButton.isVisible() && !(await nextButton.isDisabled())) {
      await nextButton.click();
      await expect(page).toHaveURL(/offset=/);
    }
  });
});

test.describe('Admin Panel - Cross-entity Links', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const exists = await ensureSuperuserExists(page);
    await page.close();

    if (!exists) {
      test.skip();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsSuperuser(page);
  });

  test('project detail links to associated org', async ({ page }) => {
    await page.goto('/qaml-backdoor/projects');

    // Skip if no projects
    const projectRow = page.locator('table tbody tr:first-child');
    if (!(await projectRow.isVisible())) {
      test.skip();
      return;
    }

    await projectRow.locator('a').first().click();

    // Should be on project detail
    await expect(page.locator('text=Project Details')).toBeVisible();

    // Should have link to org
    const orgLink = page.locator('a[href*="/qaml-backdoor/orgs/"]').first();
    await expect(orgLink).toBeVisible();
  });

  test('thread detail links to associated project', async ({ page }) => {
    await page.goto('/qaml-backdoor/threads');

    // Skip if no threads
    const threadRow = page.locator('table tbody tr:first-child');
    if (!(await threadRow.isVisible())) {
      test.skip();
      return;
    }

    await threadRow.locator('a').first().click();

    // Should be on thread detail
    await expect(page.locator('text=Thread Details')).toBeVisible();

    // Should have link to project
    const projectLink = page.locator('a[href*="/qaml-backdoor/projects/"]').first();
    if (await projectLink.isVisible()) {
      await expect(projectLink).toBeVisible();
    }
  });
});

test.describe('Admin Panel - Sidebar Navigation', () => {
  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    const exists = await ensureSuperuserExists(page);
    await page.close();

    if (!exists) {
      test.skip();
    }
  });

  test.beforeEach(async ({ page }) => {
    await loginAsSuperuser(page);
  });

  test('sidebar is visible and contains navigation links', async ({ page }) => {
    await page.goto('/qaml-backdoor');

    // Check sidebar links exist
    await expect(page.locator('aside a:has-text("Dashboard")')).toBeVisible();
    await expect(page.locator('aside a:has-text("Users")')).toBeVisible();
    await expect(page.locator('aside a:has-text("Organizations")')).toBeVisible();
    await expect(page.locator('aside a:has-text("Projects")')).toBeVisible();
    await expect(page.locator('aside a:has-text("Threads")')).toBeVisible();
  });

  test('sidebar navigation works', async ({ page }) => {
    await page.goto('/qaml-backdoor');

    // Navigate via sidebar
    await page.click('aside a:has-text("Users")');
    await expect(page).toHaveURL('/qaml-backdoor/users');

    await page.click('aside a:has-text("Organizations")');
    await expect(page).toHaveURL('/qaml-backdoor/orgs');

    await page.click('aside a:has-text("Dashboard")');
    await expect(page).toHaveURL('/qaml-backdoor');
  });

  test('has link back to main app', async ({ page }) => {
    await page.goto('/qaml-backdoor');

    // Should have link to exit admin
    const exitLink = page.locator('aside a[href="/"]');
    await expect(exitLink).toBeVisible();
  });
});

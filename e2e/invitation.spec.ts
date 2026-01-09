import { test, expect, Page } from '@playwright/test';

const PASSWORD = 'password123';

const generateEmail = () =>
  `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function signup(page: Page, email = generateEmail()) {
  await page.goto('/signup');
  await page.fill('input#email', email);
  await page.fill('input#password', PASSWORD);
  await page.fill('input#confirmPassword', PASSWORD);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL('/', { timeout: 10000 });
  return email;
}

async function getSessionCookie(page: Page) {
  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((cookie) => cookie.name === 'chiridion_session');
  if (!sessionCookie) {
    throw new Error('Missing chiridion_session cookie');
  }
  return `${sessionCookie.name}=${sessionCookie.value}`;
}

async function getCurrentOrgId(page: Page, sessionCookie: string) {
  const response = await page.request.get('/api/auth/me', {
    headers: { Cookie: sessionCookie },
  });
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { currentOrg: { id: string } };
  return payload.currentOrg.id;
}

async function createInvitation(
  page: Page,
  orgId: string,
  email: string,
  sessionCookie: string
) {
  const response = await page.request.post(`/api/orgs/${orgId}/invite`, {
    headers: {
      'Content-Type': 'application/json',
      Cookie: sessionCookie,
    },
    data: { email, role: 'member' },
  });
  expect(response.ok()).toBe(true);
  const payload = await response.json() as { id: string };
  return payload.id;
}

test.describe('Invitation landing page', () => {
  test('full invitation accept flow - new user', async ({ page }) => {
    await signup(page);
    const ownerSession = await getSessionCookie(page);
    const orgId = await getCurrentOrgId(page, ownerSession);
    const inviteeEmail = generateEmail();
    const invitationId = await createInvitation(page, orgId, inviteeEmail, ownerSession);

    await page.context().clearCookies();
    await page.goto(`/invitations/${orgId}/${invitationId}`);

    const signInLink = page.getByRole('link', { name: /sign in to accept/i });
    await expect(signInLink).toBeVisible({ timeout: 10000 });
    await signInLink.click();

    await expect(page).toHaveURL(/\/login/);
    await page.getByRole('link', { name: /sign up/i }).click();

    await expect(page).toHaveURL(/\/signup/);
    await page.fill('input#email', inviteeEmail);
    await page.fill('input#password', PASSWORD);
    await page.fill('input#confirmPassword', PASSWORD);
    await page.click('button[type="submit"]');

    await expect(page).toHaveURL(new RegExp(`/invitations/${orgId}/${invitationId}`), {
      timeout: 10000,
    });

    const acceptButton = page.getByRole('button', { name: /accept invitation/i });
    await expect(acceptButton).toBeVisible({ timeout: 10000 });
    await acceptButton.click();

    await expect(page).toHaveURL('/', { timeout: 10000 });
  });

  test('full invitation accept flow - existing user', async ({ page }) => {
    await signup(page);
    const ownerSession = await getSessionCookie(page);
    const orgId = await getCurrentOrgId(page, ownerSession);

    await page.context().clearCookies();
    const inviteeEmail = await signup(page);

    const invitationId = await createInvitation(page, orgId, inviteeEmail, ownerSession);

    await page.goto(`/invitations/${orgId}/${invitationId}`);

    const acceptButton = page.getByRole('button', { name: /accept invitation/i });
    await expect(acceptButton).toBeVisible({ timeout: 10000 });
    await acceptButton.click();

    await expect(page).toHaveURL('/', { timeout: 10000 });
  });

  test('decline invitation flow', async ({ page }) => {
    await signup(page);
    const ownerSession = await getSessionCookie(page);
    const orgId = await getCurrentOrgId(page, ownerSession);

    await page.context().clearCookies();
    const inviteeEmail = await signup(page);

    const invitationId = await createInvitation(page, orgId, inviteeEmail, ownerSession);

    await page.goto(`/invitations/${orgId}/${invitationId}`);

    await page.getByRole('button', { name: 'Decline' }).click();
    const confirmButton = page.getByRole('button', { name: /decline invitation/i });
    await expect(confirmButton).toBeVisible({ timeout: 10000 });
    await confirmButton.click();

    await expect(page).toHaveURL('/', { timeout: 10000 });
  });

  test('invalid invitation shows error', async ({ page }) => {
    await page.goto('/invitations/invalid-org/invalid-invite');
    await expect(page.getByText('Invitation not found')).toBeVisible({ timeout: 10000 });
  });
});

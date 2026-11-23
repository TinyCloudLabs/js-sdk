/**
 * Space Creation E2E tests for TinyCloud web-sdk-example.
 *
 * Tests the space creation modal that appears when signing in
 * with an address that doesn't have an existing space.
 */
import { test, expect, TEST_ADDRESS, TINYCLOUD_HOST, waitForAppReady, configureTinyCloudHost, clearTinyCloudSession } from '../fixtures/test-fixtures';

test.describe('Space Creation', () => {
  test.beforeEach(async ({ mockWalletPage: page }) => {
    await page.goto('/');
    // Clear any persisted sessions to ensure clean state and force fresh sign-in flow
    // This prevents session auto-resume from skipping the invoke → 404 → create space flow
    await clearTinyCloudSession(page);
    await waitForAppReady(page);
    await configureTinyCloudHost(page, TINYCLOUD_HOST);
  });

  test('should show Create TinyCloud Space modal content', async ({ mockWalletPage: page }) => {
    // Click sign-in button
    const signInButton = page.locator('#signInButton');
    await signInButton.click();

    // Handle ConnectKit wallet selection
    await page.waitForTimeout(1500);
    const metaMaskOption = page.getByText('MetaMask', { exact: false });
    if (await metaMaskOption.isVisible().catch(() => false)) {
      await metaMaskOption.click();
    }

    // Wait for SIWE signing
    await page.waitForTimeout(3000);

    // Check if space creation modal appears
    const spaceModal = page.locator('tinycloud-space-modal');

    if (await spaceModal.isVisible().catch(() => false)) {
      // Modal should contain "Create" text and explanatory content
      const modalText = await spaceModal.textContent();

      // Check for expected content in modal
      expect(modalText).toContain('TinyCloud');

      // Look for create button
      const createButton = spaceModal.locator('button').filter({ hasText: /create/i });
      await expect(createButton).toBeVisible();
    } else {
      // If modal didn't appear, user already has a space - this is also valid
      const signOutButton = page.locator('#signOutButton');
      await expect(signOutButton).toBeVisible({ timeout: 10000 });
    }
  });

  test('should create space when clicking create button', async ({ mockWalletPage: page }) => {
    // Click sign-in button
    const signInButton = page.locator('#signInButton');
    await signInButton.click();

    // Handle ConnectKit wallet selection
    await page.waitForTimeout(1500);
    const metaMaskOption = page.getByText('MetaMask', { exact: false });
    if (await metaMaskOption.isVisible().catch(() => false)) {
      await metaMaskOption.click();
    }

    // Wait for SIWE signing
    await page.waitForTimeout(3000);

    // Check if space creation modal appears
    const spaceModal = page.locator('tinycloud-space-modal');

    if (await spaceModal.isVisible().catch(() => false)) {
      // Click create button
      const createButton = spaceModal.locator('button').filter({ hasText: /create/i });
      await createButton.click();

      // Wait for space creation (requires second signature)
      // This will sign another message to create the space
      await page.waitForTimeout(5000);

      // After space creation, modal should close and user should be signed in
      const signOutButton = page.locator('#signOutButton');
      await expect(signOutButton).toBeVisible({ timeout: 15000 });

      // Modal should no longer be visible
      await expect(spaceModal).not.toBeVisible();
    } else {
      // Already have a space - should be signed in
      const signOutButton = page.locator('#signOutButton');
      await expect(signOutButton).toBeVisible({ timeout: 10000 });
    }
  });
});

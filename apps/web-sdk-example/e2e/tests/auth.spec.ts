/**
 * Authentication E2E tests for TinyCloud web-sdk-example.
 *
 * Tests wallet connection and SIWE sign-in flow using mock wallet
 * with REAL cryptographic signatures.
 */
import { test, expect, TEST_ADDRESS, TINYCLOUD_HOST, waitForAppReady, configureTinyCloudHost, clearTinyCloudSession } from '../fixtures/test-fixtures';

test.describe('Authentication', () => {
  test.beforeEach(async ({ mockWalletPage: page }) => {
    await page.goto('/');
    // Clear any persisted sessions to ensure clean state and force fresh sign-in flow
    await clearTinyCloudSession(page);
    await waitForAppReady(page);
  });

  test('should show sign-in button when not connected', async ({ mockWalletPage: page }) => {
    // Check sign-in button is visible
    const signInButton = page.locator('#signInButton');
    await expect(signInButton).toBeVisible();

    // Should show "Connect Wallet & Sign-In" text
    await expect(signInButton).toContainText(/connect.*wallet|sign.*in/i);
  });

  test('should show account info after sign-in', async ({ mockWalletPage: page }) => {
    // Configure and sign in
    await configureTinyCloudHost(page, TINYCLOUD_HOST);

    const signInButton = page.locator('#signInButton');
    await signInButton.click();

    await page.waitForTimeout(1500);
    const metaMaskOption = page.getByText('MetaMask', { exact: false });
    if (await metaMaskOption.isVisible().catch(() => false)) {
      await metaMaskOption.click();
    }

    await page.waitForTimeout(5000);

    // Handle space creation if needed
    const spaceModal = page.locator('tinycloud-space-modal');
    if (await spaceModal.isVisible().catch(() => false)) {
      const createButton = spaceModal.locator('button').filter({ hasText: /create/i });
      if (await createButton.isVisible().catch(() => false)) {
        await createButton.click();
        await page.waitForTimeout(5000);
      }
    }

    // Wait for sign-in to complete
    const signOutButton = page.locator('#signOutButton');
    await signOutButton.waitFor({ timeout: 15000 });

    // Account info should show the test address
    const accountInfo = page.getByText(TEST_ADDRESS.slice(0, 6));
    await expect(accountInfo).toBeVisible({ timeout: 5000 });
  });
});

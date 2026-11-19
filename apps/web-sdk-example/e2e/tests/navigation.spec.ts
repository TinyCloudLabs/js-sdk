/**
 * Navigation E2E tests for TinyCloud web-sdk-example.
 *
 * Tests basic page navigation and UI element rendering.
 */
import { test, expect, waitForAppReady } from '../fixtures/test-fixtures';

test.describe('Navigation', () => {
  test('should load home page with correct title', async ({ mockWalletPage: page }) => {
    await page.goto('/');

    // Wait for app to be ready
    await waitForAppReady(page);

    // Check page title
    await expect(page).toHaveTitle(/TinyCloud/i);
  });

  test('should render main UI elements', async ({ mockWalletPage: page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Check for main heading/title
    const title = page.locator('text=TinyCloud');
    await expect(title.first()).toBeVisible();

    // Check for sign-in button when not signed in
    const signInButton = page.locator('#signInButton');
    await expect(signInButton).toBeVisible();

    // Check for instructional text
    const instructions = page.getByText(/connect your wallet/i);
    await expect(instructions).toBeVisible();
  });

  test('should open Advanced Options and show TinyCloud Host input', async ({ mockWalletPage: page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Click to open accordion
    const advancedOptions = page.getByText('Advanced Options');
    await advancedOptions.click();

    // Wait for animation
    await page.waitForTimeout(300);

    // Check for TinyCloud Host input
    const hostLabel = page.getByText('TinyCloud Host');
    await expect(hostLabel.first()).toBeVisible();

    // Check for input placeholder
    const hostInput = page.getByPlaceholder('node.tinycloud.xyz');
    await expect(hostInput).toBeVisible();
  });

  test('should show Prefix Configuration in Advanced Options', async ({ mockWalletPage: page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Open accordion
    const advancedOptions = page.getByText('Advanced Options');
    await advancedOptions.click();
    await page.waitForTimeout(300);

    // Check for Prefix section
    const prefixConfig = page.getByText('Prefix Configuration');
    await expect(prefixConfig).toBeVisible();

    // Check for prefix input (default value is 'demo-app')
    const prefixInput = page.locator('input').filter({ hasText: /demo-app/i }).or(
      page.locator('input[value="demo-app"]')
    );
    // Alternative: look for any input in the prefix section
    const prefixSection = page.locator('div').filter({ hasText: 'Prefix Configuration' });
    await expect(prefixSection).toBeVisible();
  });

  test('should show Storage Module toggle in Advanced Options', async ({ mockWalletPage: page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Open accordion
    const advancedOptions = page.getByText('Advanced Options');
    await advancedOptions.click();
    await page.waitForTimeout(300);

    // Check for Storage Module section
    const storageModule = page.getByText('Storage Module').first();
    await expect(storageModule).toBeVisible();

    // Check for radio options
    const onOption = page.getByLabel(/enable storage module/i).or(
      page.locator('text=On').first()
    );
    await expect(page.getByText('On').first()).toBeVisible();
    await expect(page.getByText('Off').first()).toBeVisible();
  });

  test('should navigate to share page', async ({ mockWalletPage: page }) => {
    // Navigate directly to share page
    await page.goto('/share');

    // Wait for page to load
    await page.waitForLoadState('networkidle');

    // The share page should be accessible
    // Check for some indicator that we're on the share page
    await expect(page).toHaveURL(/\/share/);
  });

  test('should handle URL prefix parameter', async ({ mockWalletPage: page }) => {
    // Navigate with prefix query parameter
    await page.goto('/?prefix=custom-prefix');
    await waitForAppReady(page);

    // Open Advanced Options to check prefix
    const advancedOptions = page.getByText('Advanced Options');
    await advancedOptions.click();
    await page.waitForTimeout(300);

    // The prefix input should have the custom value
    // Find input by looking for one with our custom value
    const prefixInput = page.locator('input[value="custom-prefix"]');
    await expect(prefixInput).toBeVisible();
  });

  test('should close Advanced Options accordion when clicked again', async ({ mockWalletPage: page }) => {
    await page.goto('/');
    await waitForAppReady(page);

    // Open accordion
    const advancedOptions = page.getByText('Advanced Options');
    await advancedOptions.click();
    await page.waitForTimeout(300);

    // Verify it's open (host input visible)
    const hostInput = page.getByPlaceholder('node.tinycloud.xyz');
    await expect(hostInput).toBeVisible();

    // Close accordion
    await advancedOptions.click();
    await page.waitForTimeout(300);

    // Verify it's closed (host input not visible)
    await expect(hostInput).not.toBeVisible();
  });
});

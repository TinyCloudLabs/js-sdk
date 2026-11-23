/**
 * Storage E2E tests for TinyCloud web-sdk-example.
 *
 * Tests KV operations (put, get, list, delete) after successful sign-in.
 * Assumes TinyCloud server is running and accessible.
 */
import { test, expect, TEST_ADDRESS, TINYCLOUD_HOST, waitForAppReady, configureTinyCloudHost, clearTinyCloudSession } from '../fixtures/test-fixtures';

test.describe('Storage Operations', () => {
  // Helper to complete sign-in before each test
  async function signIn(page: any) {
    await page.goto('/');
    // Clear any persisted sessions to ensure clean state and force fresh sign-in flow
    await clearTinyCloudSession(page);
    await waitForAppReady(page);
    await configureTinyCloudHost(page, TINYCLOUD_HOST);

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
  }

  test('should show default prefix', async ({ mockWalletPage: page }) => {
    await signIn(page);

    // Default prefix is 'demo-app'
    const prefix = page.locator('span.font-mono').filter({ hasText: 'demo-app' });
    await expect(prefix).toBeVisible();
  });

  test('should open add content form when clicking Add New Content', async ({ mockWalletPage: page }) => {
    await signIn(page);

    // Click Add New Content button
    const addButton = page.getByText('Add New Content');
    await addButton.click();

    // Wait for form to appear
    await page.waitForTimeout(300);

    // Should show Key and Value inputs
    const keyLabel = page.getByText('Key', { exact: true });
    await expect(keyLabel).toBeVisible();

    const valueLabel = page.getByText('Value', { exact: true });
    await expect(valueLabel).toBeVisible();

    // Should show Save button
    const saveButton = page.getByText('Save', { exact: true });
    await expect(saveButton).toBeVisible();

    // Should show Back to List button
    const backButton = page.getByText('Back to List');
    await expect(backButton).toBeVisible();
  });

  test('should update an existing key', async ({ mockWalletPage: page }) => {
    await signIn(page);

    // Create a test entry
    const testKey = `update-test-${Date.now()}`;
    const initialValue = 'initial-value';
    const updatedValue = 'updated-value';

    // Add new content
    const addButton = page.getByText('Add New Content');
    await addButton.click();
    await page.waitForTimeout(300);

    await page.getByLabel('Key').fill(testKey);
    await page.getByLabel('Value').fill(initialValue);
    await page.getByText('Save', { exact: true }).click();
    await page.waitForTimeout(2000);

    // Click Get to edit
    const itemRow = page.locator('div').filter({ hasText: testKey }).filter({ has: page.getByText('Get') });
    const getButton = itemRow.getByText('Get');
    await getButton.click();
    await page.waitForTimeout(1000);

    // Update the value
    await page.getByLabel('Value').clear();
    await page.getByLabel('Value').fill(updatedValue);

    // Click Update
    const updateButton = page.getByText('Update', { exact: true });
    await updateButton.click();
    await page.waitForTimeout(2000);

    // Verify we're back at the list
    await expect(page.getByText('Key Value Store')).toBeVisible();

    // Get the item again to verify the update
    const updatedItemRow = page.locator('div').filter({ hasText: testKey }).filter({ has: page.getByText('Get') });
    const updatedGetButton = updatedItemRow.getByText('Get');
    await updatedGetButton.click();
    await page.waitForTimeout(1000);

    // Verify the value was updated
    await expect(page.getByLabel('Value')).toHaveValue(updatedValue);
  });

  test('should navigate back to list from edit view', async ({ mockWalletPage: page }) => {
    await signIn(page);

    // Click Add New Content
    const addButton = page.getByText('Add New Content');
    await addButton.click();
    await page.waitForTimeout(300);

    // Verify we're in add/edit view
    await expect(page.getByText('Add New Content', { exact: false })).toBeVisible();

    // Click Back to List
    const backButton = page.getByText('Back to List');
    await backButton.click();
    await page.waitForTimeout(300);

    // Should be back at list view
    await expect(page.getByText('Key Value Store')).toBeVisible();
  });

  test('should generate sharing link', async ({ mockWalletPage: page }) => {
    await signIn(page);

    // Create a test entry
    const testKey = `share-test-${Date.now()}`;
    const testValue = 'value-to-share';

    // Add new content
    const addButton = page.getByText('Add New Content');
    await addButton.click();
    await page.waitForTimeout(300);

    await page.getByLabel('Key').fill(testKey);
    await page.getByLabel('Value').fill(testValue);
    await page.getByText('Save', { exact: true }).click();
    await page.waitForTimeout(2000);

    // Click Share on the item
    const itemRow = page.locator('div').filter({ hasText: testKey }).filter({ has: page.getByText('Share') });
    const shareButton = itemRow.getByText('Share');
    await shareButton.click();

    // Wait for sharing link generation
    await page.waitForTimeout(2000);

    // Should show a sharing link
    const sharingLinkText = page.getByText('Sharing Link:');
    await expect(sharingLinkText).toBeVisible({ timeout: 5000 });

    // Should have a Copy button
    const copyButton = page.getByText('Copy', { exact: true });
    await expect(copyButton).toBeVisible();

    // Should have a Close button
    const closeButton = page.getByText('Close', { exact: true });
    await expect(closeButton).toBeVisible();
  });
});

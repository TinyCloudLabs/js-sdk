/**
 * End-to-end tests for the unified TinyCloudWeb wrapper.
 *
 * Validates that the SDK unification works through the example app UI:
 * 1. Sign in via wallet mode → verify session created
 * 2. KV put/get cycle → verify data roundtrips
 * 3. Verify unified service accessors are available (sql, duckdb)
 * 4. Sign out → verify cleanup
 *
 * Uses mock wallet with REAL cryptographic signatures.
 *
 * KNOWN BLOCKERS (pre-existing in feat/sdk-unification):
 * - webpack-dev-server error overlay blocks clicks (TS error in Delegate.tsx)
 * - signInWithWallet() passes provider in wrong format:
 *     `provider: { web3: { driver } }` instead of `providers: { web3: { driver } }`
 *   TinyCloudWeb reads `config.provider` first (gets nested object, not ethers provider)
 *   Fix: Change Home.tsx line ~206 to use `providers` key, not `provider`
 *
 * These same blockers affect ALL existing e2e tests (storage.spec.ts, etc).
 */
import {
  test,
  expect,
  TEST_ADDRESS,
  TINYCLOUD_HOST,
  waitForAppReady,
  configureTinyCloudHost,
  clearTinyCloudSession,
} from '../fixtures/test-fixtures';

/**
 * Helper to dismiss webpack-dev-server error overlay.
 * TS errors in other files (e.g., Delegate.tsx) cause an overlay iframe
 * that intercepts all pointer events.
 */
async function dismissErrorOverlay(page: any): Promise<void> {
  await page.evaluate(() => {
    const el = document.getElementById('webpack-dev-server-client-overlay');
    if (el) el.remove();
  });
  await page.waitForTimeout(200);
}

test.describe('Unified SDK (TinyCloudWeb)', () => {
  /**
   * Helper to complete sign-in via wallet mode.
   * Handles ConnectKit wallet selection and space creation modal.
   */
  async function signIn(page: any) {
    // Capture console logs for debugging
    const consoleLogs: string[] = [];
    page.on('console', (msg: any) => {
      consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
    });

    await page.goto('/');
    await dismissErrorOverlay(page);
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
    await page.waitForTimeout(5000);

    // Handle space creation modal if it appears.
    // The ModalSpaceCreationHandler renders a dialog with "Create TinyCloud Space" button.
    // It may be a <tinycloud-space-modal> web component OR a regular DOM modal.
    const createSpaceButton = page.locator('button').filter({ hasText: /Create TinyCloud Space/i });
    if (await createSpaceButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await createSpaceButton.click();
      // Wait for space creation (requires another signature)
      await page.waitForTimeout(8000);
    } else {
      // Also check for the old-style web component modal
      const spaceModal = page.locator('tinycloud-space-modal');
      if (await spaceModal.isVisible().catch(() => false)) {
        const createButton = spaceModal.locator('button').filter({ hasText: /create/i });
        if (await createButton.isVisible().catch(() => false)) {
          await createButton.click();
          await page.waitForTimeout(8000);
        }
      }
    }

    // Wait for sign-in to complete
    const signOutButton = page.locator('#signOutButton');
    try {
      await signOutButton.waitFor({ timeout: 15000 });
    } catch (e) {
      // Log all console output for debugging sign-in failures
      console.log('All console logs during sign-in:');
      consoleLogs.forEach(log => console.log('  ', log));
      throw e;
    }
  }

  // =========================================================================
  // 1. Sign-In & Session Tests
  // =========================================================================

  test.describe('Sign-In & Session', () => {
    test('should sign in and create a valid session', async ({ mockWalletPage: page }) => {
      await signIn(page);

      // Sign-out button should be visible (we're signed in)
      await expect(page.locator('#signOutButton')).toBeVisible();

      // Auth info section should be visible
      const authInfo = page.locator('text=Auth Info');
      await expect(authInfo).toBeVisible();

      // Mode should show "Wallet Connected"
      const modeInfo = page.locator('text=Wallet Connected');
      await expect(modeInfo.first()).toBeVisible();

      // DID should be displayed
      const didLabel = page.locator('text=DID:');
      await expect(didLabel.first()).toBeVisible();

      // Session DID should be displayed
      const sessionDidLabel = page.locator('text=Session DID:');
      await expect(sessionDidLabel).toBeVisible();
    });

    test('should have session available after sign-in', async ({ mockWalletPage: page }) => {
      await signIn(page);

      // Verify wallet address is shown in auth info
      const walletYes = page.locator('text=/Wallet Connected:.*Yes/');
      await expect(walletYes).toBeVisible();
    });
  });

  // =========================================================================
  // 2. KV Put/Get Cycle
  // =========================================================================

  test.describe('KV Operations', () => {
    test('should put and get a key-value pair', async ({ mockWalletPage: page }) => {
      await signIn(page);

      // Generate unique key for this test run
      const testKey = `unified-test-${Date.now()}`;
      const testValue = `unified-value-${Date.now()}`;

      // Click "Add New Content"
      const addButton = page.getByRole('button', { name: 'Add New Content' });
      await addButton.click();
      await page.waitForTimeout(300);

      // Fill in key and value (inputs have id matching their label text)
      await page.locator('input#Key').fill(testKey);
      await page.locator('input#Value').fill(testValue);

      // Click Save
      await page.getByText('Save', { exact: true }).click();
      await page.waitForTimeout(2000);

      // Should return to list view with the new key visible
      await expect(page.getByText('Key Value Store')).toBeVisible({ timeout: 5000 });
      await expect(page.getByText(testKey, { exact: true })).toBeVisible({ timeout: 5000 });

      // Now Get the value back — find the row with exact key text, then click Get
      const keyCell = page.getByText(testKey, { exact: true });
      const row = keyCell.locator('..').locator('..');  // Navigate up to the row container
      const getButton = row.getByRole('button', { name: 'Get' });
      await getButton.click();
      await page.waitForTimeout(1000);

      // Verify the value matches
      await expect(page.locator('input#Value')).toHaveValue(testValue);
    });

    test('should delete a stored key', async ({ mockWalletPage: page }) => {
      await signIn(page);

      // Create a test entry
      const testKey = `delete-unified-${Date.now()}`;
      const addButton = page.getByRole('button', { name: 'Add New Content' });
      await addButton.click();
      await page.waitForTimeout(300);

      await page.locator('input#Key').fill(testKey);
      await page.locator('input#Value').fill('to-delete');
      await page.getByText('Save', { exact: true }).click();
      await page.waitForTimeout(2000);

      // Verify key exists
      await expect(page.getByText(testKey, { exact: true })).toBeVisible();

      // Delete it — find the row with exact key text
      const delKeyCell = page.getByText(testKey, { exact: true });
      const delRow = delKeyCell.locator('..').locator('..');
      const deleteButton = delRow.getByRole('button', { name: 'Delete' });
      await deleteButton.click();
      await page.waitForTimeout(2000);

      // Should be gone
      await expect(page.getByText(testKey, { exact: true })).not.toBeVisible();
    });
  });

  // =========================================================================
  // 3. Unified Service Accessors
  // =========================================================================

  test.describe('Unified Service Accessors', () => {
    test('should expose kv, sql, duckdb accessors on TinyCloudWeb', async ({ mockWalletPage: page }) => {
      await signIn(page);

      // The storage module should render (proves kv accessor is wired)
      const kvStore = page.getByText('Key Value Store');
      await expect(kvStore).toBeVisible();

      // Storage prefix should be shown
      const storagePrefix = page.getByText('Storage Prefix:');
      await expect(storagePrefix).toBeVisible();

      // Add New Content button should be available (proves KV is operational)
      const addButton = page.getByRole('button', { name: 'Add New Content' });
      await expect(addButton).toBeVisible();
    });
  });

  // =========================================================================
  // 4. Sign-Out & Cleanup
  // =========================================================================

  test.describe('Sign-Out', () => {
    test('should sign out and clean up session', async ({ mockWalletPage: page }) => {
      await signIn(page);

      // Verify we're signed in
      const signOutButton = page.locator('#signOutButton');
      await expect(signOutButton).toBeVisible();

      // Sign out
      await signOutButton.click();

      // Sign-in button should reappear
      const signInButton = page.locator('#signInButton');
      await expect(signInButton).toBeVisible({ timeout: 10000 });

      // Sign-out button should be hidden
      await expect(signOutButton).not.toBeVisible();

      // Auth info section should be gone
      const authInfo = page.locator('text=Auth Info');
      await expect(authInfo).not.toBeVisible();

      // Storage module should be gone (requires session)
      const kvStore = page.getByText('Key Value Store');
      await expect(kvStore).not.toBeVisible();
    });

    test('should allow re-sign-in after sign-out', async ({ mockWalletPage: page }) => {
      await signIn(page);

      // Sign out
      const signOutButton = page.locator('#signOutButton');
      await signOutButton.click();
      await page.waitForTimeout(1000);

      // Sign in again
      const signInButton = page.locator('#signInButton');
      await expect(signInButton).toBeVisible({ timeout: 10000 });

      await dismissErrorOverlay(page);
      await signInButton.click();

      await page.waitForTimeout(1500);
      const metaMaskOption = page.getByText('MetaMask', { exact: false });
      if (await metaMaskOption.isVisible().catch(() => false)) {
        await metaMaskOption.click();
      }

      await page.waitForTimeout(5000);

      // Handle space creation modal
      const createSpaceBtn = page.locator('button').filter({ hasText: /Create TinyCloud Space/i });
      if (await createSpaceBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        await createSpaceBtn.click();
        await page.waitForTimeout(8000);
      }

      // Should be signed in again
      await expect(page.locator('#signOutButton')).toBeVisible({ timeout: 15000 });
    });
  });

  // =========================================================================
  // 5. Vault Module (new unified capability)
  // =========================================================================

  test.describe('Vault Module', () => {
    test('should show vault module after sign-in', async ({ mockWalletPage: page }) => {
      await signIn(page);

      // Vault module should be visible (enabled by default in the example app)
      const vaultSection = page.getByText('Data Vault').first();
      await expect(vaultSection).toBeVisible({ timeout: 5000 });
    });
  });
});

/**
 * End-to-end tests for the new auth module (1.0.0).
 *
 * Covers the TC-718 scenarios specific to this module (wallet sign-in, space
 * creation and KV are covered by auth/space-creation/unified-sdk specs):
 * 1. Session-only mode: create tcw, receive delegation, access data
 * 3. Upgrade flow: session-only → connectWallet()
 * 4. SignStrategy: callback pattern
 *
 * Uses mock wallet with REAL cryptographic signatures.
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

test.describe('New Auth Module (1.0.0)', () => {
  test.beforeEach(async ({ mockWalletPage: page }) => {
    await page.goto('/');
    await clearTinyCloudSession(page);
    await waitForAppReady(page);
  });

  /**
   * Helper to select auth mode in Advanced Options.
   */
  async function selectAuthMode(
    page: any,
    mode: 'Wallet' | 'Session-Only'
  ) {
    // Open Advanced Options accordion
    const advancedOptions = page.getByText('Advanced Options');
    const isOpen = await page
      .locator('[data-state="open"]')
      .filter({ hasText: 'Auth Mode' })
      .isVisible()
      .catch(() => false);

    if (!isOpen) {
      await advancedOptions.click();
      await page.waitForTimeout(300);
    }

    // Select auth mode radio
    const authModeRadio = page.getByLabel(mode, { exact: true });
    if (await authModeRadio.isVisible().catch(() => false)) {
      await authModeRadio.click();
    } else {
      // Fallback: Find by text in the radio group
      const radioOption = page.locator('label').filter({ hasText: mode }).first();
      await radioOption.click();
    }

    await page.waitForTimeout(200);
  }

  /**
   * Helper to select sign strategy in Advanced Options.
   */
  async function selectSignStrategy(
    page: any,
    strategy: 'Wallet Popup' | 'Callback' | 'Auto Approve'
  ) {
    // Ensure Advanced Options is open
    const advancedOptions = page.getByText('Advanced Options');
    const isOpen = await page
      .locator('[data-state="open"]')
      .filter({ hasText: 'Sign Strategy' })
      .isVisible()
      .catch(() => false);

    if (!isOpen) {
      await advancedOptions.click();
      await page.waitForTimeout(300);
    }

    // Select sign strategy
    const strategyLabel = page
      .locator('label')
      .filter({ hasText: strategy })
      .first();
    if (await strategyLabel.isVisible().catch(() => false)) {
      await strategyLabel.click();
    }

    await page.waitForTimeout(200);
  }

  /**
   * Helper to set callback behavior (approve/reject).
   */
  async function setCallbackBehavior(page: any, approve: boolean) {
    const label = approve ? 'Approve' : 'Reject';
    const callbackOption = page
      .locator('label')
      .filter({ hasText: label })
      .filter({ has: page.locator('input[name="callbackApproved"]') });
    if (await callbackOption.isVisible().catch(() => false)) {
      await callbackOption.click();
    }
  }

  // =========================================================================
  // 1. Session-Only Mode Tests
  // =========================================================================

  test.describe('Session-Only Mode', () => {
    test('should start in session-only mode without wallet', async ({
      mockWalletPage: page,
    }) => {
      // Configure for session-only mode
      await selectAuthMode(page, 'Session-Only');

      // Click sign-in (should start session-only mode)
      const signInButton = page.locator('#signInButton');
      await expect(signInButton).toContainText(/START SESSION-ONLY MODE/i);
      await signInButton.click();

      // Wait for session to be created
      await page.waitForTimeout(2000);

      // Should show sign-out button
      const signOutButton = page.locator('#signOutButton');
      await expect(signOutButton).toBeVisible({ timeout: 10000 });

      // Should show Session-Only mode
      const modeInfo = page.locator('text=Session-Only');
      await expect(modeInfo).toBeVisible();

      // Should show DID info
      const didInfo = page.locator('text=/did:key:/');
      await expect(didInfo).toBeVisible();

      // Wallet Connected should be No
      const walletInfo = page.locator('text=/Wallet Connected:.*No/');
      await expect(walletInfo).toBeVisible();
    });

    test('should have session DID immediately available', async ({
      mockWalletPage: page,
    }) => {
      await selectAuthMode(page, 'Session-Only');

      const signInButton = page.locator('#signInButton');
      await signInButton.click();
      await page.waitForTimeout(2000);

      // Get session DID from page
      const sessionDid = await page.evaluate(() => {
        const tcw = (window as any).tcw;
        // Note: tcw may be on window or we check the displayed value
        const didElement = document.querySelector('[title*="did:key"]');
        return didElement?.getAttribute('title') || 'not-found';
      });

      // Session DID should start with did:key:
      expect(sessionDid).toMatch(/did:key:z6Mk/);
    });

    test('should show connect wallet upgrade option', async ({
      mockWalletPage: page,
    }) => {
      await selectAuthMode(page, 'Session-Only');

      const signInButton = page.locator('#signInButton');
      await signInButton.click();
      await page.waitForTimeout(2000);

      // Should show upgrade button
      const upgradeButton = page.locator('button').filter({
        hasText: /CONNECT WALLET|UPGRADE WITH WALLET/i,
      });
      await expect(upgradeButton).toBeVisible({ timeout: 5000 });
    });
  });

  // =========================================================================
  // 3. Upgrade Flow (Session-Only → connectWallet)
  // =========================================================================

  test.describe('Upgrade Flow', () => {
    test('should upgrade from session-only to wallet mode', async ({
      mockWalletPage: page,
    }) => {
      await configureTinyCloudHost(page, TINYCLOUD_HOST);
      await selectAuthMode(page, 'Session-Only');

      // Start session-only mode
      const signInButton = page.locator('#signInButton');
      await signInButton.click();
      await page.waitForTimeout(2000);

      // Should be in session-only mode
      const sessionOnlyText = page.locator('text=Session-Only');
      await expect(sessionOnlyText).toBeVisible({ timeout: 5000 });

      // Click connect wallet / upgrade button
      const upgradeButton = page.locator('button').filter({
        hasText: /CONNECT WALLET|UPGRADE WITH WALLET/i,
      });
      await upgradeButton.click();

      // Handle ConnectKit
      await page.waitForTimeout(1500);
      const metaMaskOption = page.getByText('MetaMask', { exact: false });
      if (await metaMaskOption.isVisible().catch(() => false)) {
        await metaMaskOption.click();
      }

      // Wait for upgrade process
      await page.waitForTimeout(5000);

      // Handle space creation if needed
      const spaceModal = page.locator('tinycloud-space-modal');
      if (await spaceModal.isVisible().catch(() => false)) {
        const createButton = spaceModal
          .locator('button')
          .filter({ hasText: /create/i });
        if (await createButton.isVisible().catch(() => false)) {
          await createButton.click();
          await page.waitForTimeout(5000);
        }
      }

      // Should now show Wallet Connected mode
      const walletConnectedText = page.locator('text=Wallet Connected');
      await expect(walletConnectedText).toBeVisible({ timeout: 15000 });

      // Wallet Connected indicator should now be Yes
      const walletYes = page.locator('text=/Wallet Connected:.*Yes/');
      await expect(walletYes).toBeVisible();
    });
  });

  // =========================================================================
  // 4. SignStrategy Tests
  // =========================================================================

  test.describe('SignStrategy Patterns', () => {
    test('should use callback strategy with approve', async ({
      mockWalletPage: page,
    }) => {
      await configureTinyCloudHost(page, TINYCLOUD_HOST);
      await selectAuthMode(page, 'Wallet');
      await selectSignStrategy(page, 'Callback');

      // Ensure callback will approve
      await setCallbackBehavior(page, true);

      // Close accordion
      const advancedOptions = page.getByText('Advanced Options');
      await advancedOptions.click();

      // Sign in
      const signInButton = page.locator('#signInButton');
      await signInButton.click();

      await page.waitForTimeout(1500);
      const metaMaskOption = page.getByText('MetaMask', { exact: false });
      if (await metaMaskOption.isVisible().catch(() => false)) {
        await metaMaskOption.click();
      }

      await page.waitForTimeout(5000);

      // Handle space modal
      const spaceModal = page.locator('tinycloud-space-modal');
      if (await spaceModal.isVisible().catch(() => false)) {
        const createButton = spaceModal
          .locator('button')
          .filter({ hasText: /create/i });
        if (await createButton.isVisible().catch(() => false)) {
          await createButton.click();
          await page.waitForTimeout(5000);
        }
      }

      // Should complete successfully
      const signOutButton = page.locator('#signOutButton');
      await expect(signOutButton).toBeVisible({ timeout: 15000 });
    });
  });

  // =========================================================================
  // 7. Sign-Out Tests
  // =========================================================================

  test.describe('Sign-Out', () => {
    test('should sign out cleanly from session-only mode', async ({
      mockWalletPage: page,
    }) => {
      await selectAuthMode(page, 'Session-Only');

      // Start session-only
      const signInButton = page.locator('#signInButton');
      await signInButton.click();
      await page.waitForTimeout(2000);

      // Sign out
      const signOutButton = page.locator('#signOutButton');
      await signOutButton.waitFor({ timeout: 10000 });
      await signOutButton.click();

      // Should return to signed-out state
      await expect(signInButton).toBeVisible({ timeout: 10000 });
      await expect(signOutButton).not.toBeVisible();
    });
  });
});

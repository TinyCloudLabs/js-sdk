import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { TinyCloudWeb } from "@tinycloud/web-sdk";
import Title from "../components/Title";
import RadioGroup from "../components/RadioGroup";
import Input from "../components/Input";
import Button from "../components/Button";
import AccountInfo from "../components/AccountInfo";
import { lazy } from "react";
import { useAccount } from "wagmi";
import { useModal } from "connectkit";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../components/ui/accordian";
import Footer from "../components/Footer";
import Header from "../components/Header";
import VaultModule from "../pages/VaultModule";
import { getWalletProvider } from "../utils/getWalletProvider";

const StorageModule = lazy(() => import("../pages/StorageModule"));
const SpaceModule = lazy(() => import("../pages/SpaceModule"));
const DelegationModule = lazy(() => import("../pages/DelegationModule"));
const PublicSpaceModule = lazy(() => import("../pages/PublicSpaceModule"));
declare global {
  interface Window {
    tcw: TinyCloudWeb;
  }
}

/**
 * Auth mode options for the example app.
 * - wallet: Uses WebUserAuthorization with wallet-popup strategy
 * - session-only: Uses WebUserAuthorization in session-only mode (no wallet initially)
 */
type AuthMode = "wallet" | "session-only";

/**
 * Sign strategy options (only for new auth modes).
 */
type SignStrategyOption = "wallet-popup" | "callback" | "auto-approve";

function Home() {
  const location = useLocation();
  const { address, isConnected, connector } = useAccount();
  const { setOpen } = useModal();

  const [loading, setLoading] = useState(false);

  const [tcw, setTinyCloudWeb] = useState<TinyCloudWeb | null>(null);
  const [resolveEns, setResolveEns] = useState<string>("On");
  const [siweConfig, setSiweConfig] = useState<string>("Off");

  // Auth mode options
  const [authMode, setAuthMode] = useState<AuthMode>("wallet");
  const [signStrategyOption, setSignStrategyOption] = useState<SignStrategyOption>("wallet-popup");
  const [callbackApproved, setCallbackApproved] = useState<boolean>(true); // For demo callback strategy
  // siweConfig Fields
  const [siweAddress, setSiweAddress] = useState<string>("");
  const [chainId, setChainId] = useState<string>("");
  const [domain, setDomain] = useState<string>("");
  const [nonce, setNonce] = useState<string>("");
  const [issuedAt, setIssuedAt] = useState<string>("");
  const [expirationTime, setExpirationTime] = useState<string>("");
  const [requestId, setRequestId] = useState<string>("");
  const [notBefore, setNotBefore] = useState<string>("");
  const [resources, setResources] = useState<string>("");
  const [statement, setStatement] = useState<string>("");
  // tcw module config
  const [storageEnabled, setStorageEnabled] = useState<string>("On");
  const [spaceManagementEnabled, setSpaceManagementEnabled] = useState<string>("Off");
  const [delegationEnabled, setDelegationEnabled] = useState<string>("Off");
  const [publicSpaceEnabled, setPublicSpaceEnabled] = useState<string>("Off");
  const [vaultEnabled, setVaultEnabled] = useState<string>("On");
  const [prefix, setPrefix] = useState<string>("demo-app");
  const [tinyCloudHost, setTinyCloudHost] = useState<string>(
    window.__DEV_MODE__ ? "http://localhost:8000" : ""
  );

  // Parse URL parameters on component mount
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);

    // Handle prefix parameter
    const urlPrefix = queryParams.get("prefix");
    if (urlPrefix) {
      setPrefix(urlPrefix);
    }
  }, [location.search]);

  /**
   * Build a sign strategy based on the current selection.
   * Demonstrates different SignStrategy patterns for the new auth module.
   */
  const buildSignStrategy = (): any => {
    switch (signStrategyOption) {
      case "wallet-popup":
        // Default: shows browser wallet popup
        return { type: "wallet-popup" };

      case "callback":
        // Callback strategy: custom approval logic
        return {
          type: "callback",
          handler: async (req: { address: string; message: string }) => {
            // In a real app, you might show a custom modal here
            console.log("Callback strategy: Sign request received", {
              address: req.address,
              message: req.message.substring(0, 100) + "...",
            });
            // Use the callbackApproved state to simulate user decision
            if (callbackApproved) {
              // Return approved without signature - wallet popup will be used
              return { approved: true };
            } else {
              return { approved: false, reason: "User rejected via callback demo" };
            }
          },
        };

      case "auto-approve":
        // Note: auto-approve requires an ISigner, which we don't have in web context
        // Falling back to wallet-popup for this demo
        console.log("Auto-approve selected - using wallet-popup in web context");
        return { type: "wallet-popup" };

      default:
        return { type: "wallet-popup" };
    }
  };

  const getTinyCloudWebConfig = (tcwConfig: Record<string, any> = {}) => {
    // Set sign strategy
    tcwConfig.signStrategy = buildSignStrategy();

    if (siweConfig === "On") {
      const siweConfig: Record<string, any> = {};
      if (siweAddress) siweConfig.address = siweAddress;
      if (chainId) siweConfig.chainId = chainId;
      if (domain) siweConfig.domain = domain;
      if (nonce) siweConfig.nonce = nonce;
      if (issuedAt) siweConfig.issuedAt = issuedAt;
      if (expirationTime) siweConfig.expirationTime = expirationTime;
      if (requestId) siweConfig.requestId = requestId;
      if (notBefore) siweConfig.notBefore = notBefore;
      if (resources)
        siweConfig.resources = resources.split(",").map((r) => r.trim());
      if (statement) siweConfig.statement = statement;
      tcwConfig = {
        ...tcwConfig,
        ...(siweConfig && { siweConfig }),
      };
    }

    if (resolveEns === "On") {
      tcwConfig = {
        ...tcwConfig,
        resolveEns: true,
      };
    }

    const modules: Record<string, any> = {};

    if (storageEnabled === "Off") {
      modules.storage = false;
    } else {
      // Configure storage with bucket
      const storageConfig: Record<string, any> = {
        prefix: prefix.trim(),
      };

      // Add TinyCloud host if provided
      if (tinyCloudHost.trim()) {
        storageConfig.hosts = [tinyCloudHost.trim()];
      }

      modules.storage = storageConfig;
    }

    tcwConfig = {
      ...tcwConfig,
      modules,
    };

    // Add TinyCloud hosts at top level
    if (tinyCloudHost.trim()) {
      tcwConfig.tinycloudHosts = [tinyCloudHost.trim()];
    }

    // KV prefix for the new auth module
    tcwConfig.kvPrefix = prefix.trim();

    return tcwConfig;
  };

  const signInWithWallet = async () => {
    if (!connector || tcw) return;

    setLoading(true);

    try {
      const provider = await getWalletProvider(connector);
      const tcwConfig = getTinyCloudWebConfig({
        provider,
      });

      const tcwProvider = new TinyCloudWeb(tcwConfig);

      // Proceed with sign-in
      // signIn() will initialize KV service automatically
      await tcwProvider.signIn();
      setTinyCloudWeb(tcwProvider);

      // Log auth info
      console.log("Auth Info:");
      console.log("  - DID:", tcwProvider.did);
      console.log("  - Session DID:", tcwProvider.sessionDid);
      console.log("  - Is Session Only:", tcwProvider.isSessionOnly);
      console.log("  - Is Wallet Connected:", tcwProvider.isWalletConnected);
    } catch (err) {
      console.error("Sign-in failed:", err);
    }
    setLoading(false);
  };

  /**
   * Create a TinyCloudWeb instance in session-only mode.
   * This demonstrates starting without a wallet.
   */
  const startSessionOnlyMode = () => {
    if (tcw) return;

    setLoading(true);

    try {
      const tcwConfig = getTinyCloudWebConfig();

      const tcwProvider = new TinyCloudWeb(tcwConfig);

      // In session-only mode, we don't sign in yet
      // The session key DID is immediately available
      setTinyCloudWeb(tcwProvider);

      console.log("Session-Only Mode Started:");
      console.log("  - Session DID:", tcwProvider.sessionDid);
      console.log("  - Is Session Only:", tcwProvider.isSessionOnly);
      console.log("  - Is Wallet Connected:", tcwProvider.isWalletConnected);
    } catch (err) {
      console.error("Failed to start session-only mode:", err);
    }
    setLoading(false);
  };

  /**
   * Connect a wallet to an existing session-only TinyCloudWeb instance.
   * This demonstrates the connectWallet() upgrade pattern.
   */
  const connectWalletAndSignIn = async () => {
    if (!connector || !tcw) return;

    setLoading(true);

    try {
      const provider = await getWalletProvider(connector);
      // Upgrade from session-only mode using the connector's EIP-1193 provider.
      tcw.connectWallet(provider);

      console.log("Wallet connected! Now signing in...");
      console.log("  - Is Session Only:", tcw.isSessionOnly);
      console.log("  - Is Wallet Connected:", tcw.isWalletConnected);

      // Now sign in with the connected wallet
      await tcw.signIn();

      console.log("Signed in successfully:");
      console.log("  - DID:", tcw.did);
      console.log("  - Session DID:", tcw.sessionDid);

      // Force re-render to update UI
      setTinyCloudWeb({ ...tcw } as unknown as TinyCloudWeb);
    } catch (err) {
      console.error("Connect wallet failed:", err);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (!isConnected) {
      tcw?.signOut?.();
      setTinyCloudWeb(null);
    }
    // eslint-disable-next-line
  }, [isConnected]);

  const tcwHandler = async () => {
    // Handle session-only mode differently
    if (authMode === "session-only") {
      if (!tcw) {
        // Start in session-only mode
        startSessionOnlyMode();
        return;
      }

      // If we have a tcw in session-only mode but no wallet, prompt to connect
      if (tcw.isSessionOnly) {
        if (!isConnected || !connector) {
          setOpen(true);
          return;
        }
        // Wallet connected, upgrade and sign in
        await connectWalletAndSignIn();
        return;
      }
    }

    // Standard flow (wallet mode)
    if (!isConnected || !connector) {
      // User wants to sign in, so first connect the wallet
      setOpen(true);
      return;
    }

    if (tcw) {
      // Already signed in
      return;
    }

    // Sign in with TinyCloud using connected wallet
    await signInWithWallet();
  };

  const tcwLogoutHandler = async () => {
    tcw?.signOut?.();
    setTinyCloudWeb(null);
    // Note: Wallet remains connected - user can disconnect via header button if desired
  };

  const displayAdvancedOptions = () => {
    return (
      <Accordion type="single" collapsible className="w-full mt-4">
        <AccordionItem value="advancedOptions">
          <AccordionTrigger>
            <div className="flex items-center gap-2">Advanced Options</div>
          </AccordionTrigger>
          <AccordionContent>
            <div className="space-y-4">
              {/* Auth Mode Selection */}
              <div className="space-y-4 border-b border-border/20 pb-4">
                <h4 className="text-md font-heading text-text">
                  Auth Mode
                </h4>
                <p className="text-sm text-text/70">
                  Choose the authentication mode. Wallet mode connects a wallet
                  for signing. Session-only mode starts without a wallet.
                </p>
                <RadioGroup
                  name="authMode"
                  options={["Wallet", "Session-Only"]}
                  value={
                    authMode === "wallet"
                      ? "Wallet"
                      : "Session-Only"
                  }
                  onChange={(v) =>
                    setAuthMode(
                      v === "Wallet"
                        ? "wallet"
                        : "session-only"
                    )
                  }
                  label="Select auth mode"
                />

                {/* Sign Strategy */}
                <div className="mt-4 p-3 bg-bg rounded border">
                  <h5 className="text-sm font-heading text-text mb-2">
                    Sign Strategy
                  </h5>
                  <p className="text-xs text-text/70 mb-2">
                    Control how signing requests are handled.
                  </p>
                  <RadioGroup
                    name="signStrategy"
                    options={["Wallet Popup", "Callback", "Auto Approve"]}
                    value={
                      signStrategyOption === "wallet-popup"
                        ? "Wallet Popup"
                        : signStrategyOption === "callback"
                        ? "Callback"
                        : "Auto Approve"
                    }
                    onChange={(v) =>
                      setSignStrategyOption(
                        v === "Wallet Popup"
                          ? "wallet-popup"
                          : v === "Callback"
                          ? "callback"
                          : "auto-approve"
                      )
                    }
                    label="Sign strategy"
                  />

                  {/* Callback demo control */}
                  {signStrategyOption === "callback" && (
                    <div className="mt-3 p-2 bg-main/10 rounded">
                      <p className="text-xs text-text/70 mb-1">
                        Demo: Callback will {callbackApproved ? "approve" : "reject"} sign requests
                      </p>
                      <RadioGroup
                        name="callbackApproved"
                        options={["Approve", "Reject"]}
                        value={callbackApproved ? "Approve" : "Reject"}
                        onChange={(v) => setCallbackApproved(v === "Approve")}
                        label="Callback response"
                      />
                    </div>
                  )}
                </div>

                {/* Session-Only mode info */}
                {authMode === "session-only" && (
                  <div className="mt-3 p-3 bg-main/10 rounded border border-main/30">
                    <p className="text-sm text-text font-medium">Session-Only Mode</p>
                    <p className="text-xs text-text/70 mt-1">
                      Start without a wallet. Get a session DID immediately.
                      Later, connect a wallet to create your own space using the
                      connectWallet() upgrade pattern.
                    </p>
                  </div>
                )}
              </div>

              {/* Host settings */}
              <div className="space-y-4 border-b border-border/20 pb-4">
                <h4 className="text-md font-heading text-text">
                  TinyCloud Host
                </h4>
                <Input
                  label="TinyCloud Host (Optional)"
                  value={tinyCloudHost}
                  onChange={setTinyCloudHost}
                  className="w-full"
                  placeholder="node.tinycloud.xyz"
                  helperText="The location where your TinyCloud data is hosted. You can host your own data by setting this to your own host."
                />
              </div>
              {/* Bucket/Prefix settings */}
              <div className="space-y-4 border-b border-border/20 pb-4">
                <h4 className="text-md font-heading text-text">
                  Prefix Configuration
                </h4>
                <p className="text-sm text-text/70">
                  Set the prefix that you want to access in your TinyCloud
                  storage.
                </p>
                <Input
                  label="Prefix"
                  value={prefix}
                  onChange={setPrefix}
                  className="w-full"
                  helperText="This will request access to the root directory if empty"
                  placeholder="/"
                />
              </div>
              {/* Storage Module toggle */}
              <div className="space-y-4 border-b border-border/20 pb-4">
                <h4 className="text-md font-heading text-text">
                  Storage Module
                </h4>
                <p className="text-sm text-text/70">
                  Control whether the TinyCloud storage module is enabled. This
                  allows you to store and retrieve data.
                </p>
                <RadioGroup
                  name="storageEnabled"
                  options={["On", "Off"]}
                  value={storageEnabled}
                  onChange={setStorageEnabled}
                  label="Enable storage module"
                />
              </div>

              {/* Space Management toggle */}
              <div className="space-y-4 border-b border-border/20 pb-4">
                <h4 className="text-md font-heading text-text">
                  Space Management
                </h4>
                <p className="text-sm text-text/70">
                  Enable space-scoped KV operations. This shows the space API
                  which provides access to your space's data.
                </p>
                <RadioGroup
                  name="spaceManagementEnabled"
                  options={["On", "Off"]}
                  value={spaceManagementEnabled}
                  onChange={setSpaceManagementEnabled}
                  label="Enable space management"
                />
              </div>

              {/* Delegation Management toggle */}
              <div className="space-y-4 border-b border-border/20 pb-4">
                <h4 className="text-md font-heading text-text">
                  Delegation Management
                </h4>
                <p className="text-sm text-text/70">
                  Enable delegation management to create, list, and revoke
                  delegations. This allows you to share access with other users.
                </p>
                <RadioGroup
                  name="delegationEnabled"
                  options={["On", "Off"]}
                  value={delegationEnabled}
                  onChange={setDelegationEnabled}
                  label="Enable delegation management"
                />
              </div>

              {/* Public Space toggle */}
              <div className="space-y-4 border-b border-border/20 pb-4">
                <h4 className="text-md font-heading text-text">
                  Public Space
                </h4>
                <p className="text-sm text-text/70">
                  Enable the public space demo. Read anyone's public data
                  without authentication, or write to your own public space
                  after signing in.
                </p>
                <RadioGroup
                  name="publicSpaceEnabled"
                  options={["On", "Off"]}
                  value={publicSpaceEnabled}
                  onChange={setPublicSpaceEnabled}
                  label="Enable public space demo"
                />
              </div>

              {/* Data Vault toggle */}
              <div className="space-y-4 border-b border-border/20 pb-4">
                <h4 className="text-md font-heading text-text">
                  Data Vault
                </h4>
                <p className="text-sm text-text/70">
                  Enable the Data Vault demo for client-side encrypted KV storage.
                  Data is encrypted before leaving the device using keys derived
                  from wallet signatures.
                </p>
                <RadioGroup
                  name="vaultEnabled"
                  options={["On", "Off"]}
                  value={vaultEnabled}
                  onChange={setVaultEnabled}
                  label="Enable data vault demo"
                />
              </div>

              {/* ENS Resolution toggle */}
              <div className="space-y-4 border-b border-border/20 pb-4">
                <h4 className="text-md font-heading text-text">Resolve ENS</h4>
                <p className="text-sm text-text/70">
                  When enabled, the TinyCloud Web SDK will resolve Ethereum Name
                  Service (ENS) records for your address. This includes avatars
                  and domain names.
                </p>
                <RadioGroup
                  name="resolveEns"
                  options={["On", "Off"]}
                  value={resolveEns}
                  onChange={setResolveEns}
                  label="Enable ENS resolution"
                />
              </div>

              {/* SIWE Configuration */}
              <div className="space-y-4">
                <h4 className="text-md font-heading text-text">
                  SIWE Configuration
                </h4>
                <p className="text-sm text-text/70">
                  Sign-In With Ethereum (SIWE) allows for secure authentication
                  using your Ethereum wallet. Advanced configuration options are
                  available here.
                </p>
                <RadioGroup
                  name="siweConfig"
                  options={["On", "Off"]}
                  value={siweConfig}
                  onChange={setSiweConfig}
                  label="Enable custom SIWE configuration"
                />

                {siweConfig === "On" && (
                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <Input
                      label="Address"
                      value={siweAddress}
                      onChange={setSiweAddress}
                      helperText="Wallet address to be confirmed in the message"
                    />
                    <Input
                      label="Chain ID"
                      value={chainId}
                      onChange={setChainId}
                      helperText="Chain ID to be confirmed in the message"
                    />
                    <Input
                      label="Domain"
                      value={domain}
                      onChange={setDomain}
                      helperText="The domain that is requesting the signing"
                    />
                    <Input
                      label="Nonce"
                      value={nonce}
                      onChange={setNonce}
                      helperText="Random string to prevent replay attacks"
                    />
                    <Input
                      label="Issued At"
                      value={issuedAt}
                      onChange={setIssuedAt}
                      helperText="ISO 8601 datetime string of when the message was created"
                    />
                    <Input
                      label="Expiration Time"
                      value={expirationTime}
                      onChange={setExpirationTime}
                      helperText="ISO 8601 datetime string of when the message expires"
                    />
                    <Input
                      label="Request ID"
                      value={requestId}
                      onChange={setRequestId}
                      helperText="Request identifier for the signing request"
                    />
                    <Input
                      label="Not Before"
                      value={notBefore}
                      onChange={setNotBefore}
                      helperText="ISO 8601 datetime string of when the message starts being valid"
                    />
                    <Input
                      className="md:col-span-2"
                      label="Resources"
                      value={resources}
                      onChange={setResources}
                      helperText="List of resources the user wishes to access (comma separated)"
                    />
                    <Input
                      className="md:col-span-2"
                      label="Statement"
                      value={statement}
                      onChange={setStatement}
                      helperText="Statement that the user is signing (e.g. 'I accept the Terms of Service')"
                    />
                  </div>
                )}
              </div>
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    );
  };

  return (
    <>
      <Header />
      <div className="flex min-h-screen flex-col items-center bg-bg pt-20">
        <div className="w-full max-w-4xl px-4 mb-6">
          <Title />

          <div className="mx-auto max-w-2xl rounded-base border-2 border-border bg-bw p-6 shadow-shadow">
            <div className="space-y-6">
              {tcw ? (
                <>
                  <Button
                    id="signOutButton"
                    onClick={tcwLogoutHandler}
                    loading={loading}
                    variant="default"
                    className="w-full"
                  >
                    SIGN-OUT FROM TINYCLOUD
                  </Button>

                  {/* Auth Info Section */}
                  <div className="p-4 bg-main/10 rounded-base border border-main/30">
                    <h4 className="text-sm font-heading text-text mb-2">
                      Auth Info
                    </h4>
                      <div className="space-y-2 text-xs">
                        <div className="flex justify-between">
                          <span className="text-text/70">Mode:</span>
                          <span className="font-mono">
                            {tcw.isSessionOnly ? "Session-Only" : "Wallet Connected"}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text/70">DID:</span>
                          <span className="font-mono truncate max-w-[200px]" title={tcw.did}>
                            {tcw.did.substring(0, 20)}...
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text/70">Session DID:</span>
                          <span className="font-mono truncate max-w-[200px]" title={tcw.sessionDid}>
                            {tcw.sessionDid.substring(0, 20)}...
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-text/70">Wallet Connected:</span>
                          <span className="font-mono">
                            {tcw.isWalletConnected ? "Yes" : "No"}
                          </span>
                        </div>
                      </div>

                      {/* Connect wallet button for session-only mode */}
                      {tcw.isSessionOnly && (
                        <div className="mt-3 pt-3 border-t border-main/30">
                          <p className="text-xs text-text/70 mb-2">
                            Connect a wallet to create your own space:
                          </p>
                          <Button
                            onClick={() => {
                              if (!isConnected) {
                                setOpen(true);
                              } else {
                                connectWalletAndSignIn();
                              }
                            }}
                            loading={loading}
                            variant="neutral"
                            size="sm"
                            className="w-full"
                          >
                            {isConnected ? "UPGRADE WITH WALLET" : "CONNECT WALLET"}
                          </Button>
                        </div>
                      )}
                  </div>

                  <AccountInfo
                    address={address || tcw?.address()}
                    session={tcw?.session()}
                    className="mt-6"
                  />
                </>
              ) : (
                <div className="space-y-4">
                  {/* Instructions based on auth mode */}
                  {authMode === "session-only" ? (
                    <div className="text-sm text-text/70 text-center p-3 bg-main/10 rounded border border-main/30">
                      <p className="font-medium text-text">Session-Only Mode</p>
                      <p className="mt-1">
                        Click below to start in session-only mode. You'll get a
                        session DID immediately without connecting a wallet.
                      </p>
                    </div>
                  ) : !isConnected ? (
                    <div className="text-sm text-text/70 text-center p-3 bg-bg rounded border">
                      <p>
                        Click the button below to connect your wallet and sign
                        into TinyCloud
                      </p>
                    </div>
                  ) : null}

                  <Button
                    id="signInButton"
                    onClick={tcwHandler}
                    loading={loading}
                    variant="default"
                    className="w-full"
                  >
                    {authMode === "session-only"
                      ? "START SESSION-ONLY MODE"
                      : isConnected
                      ? "SIGN-IN TO TINYCLOUD"
                      : "CONNECT WALLET & SIGN-IN"}
                  </Button>

                  {displayAdvancedOptions()}
                </div>
              )}

              {/* This section is removed as content is now in the Advanced Options accordion */}
            </div>
          </div>

          {/* Storage module - only show when signed in (has session) */}
          {storageEnabled === "On" && tcw && tcw.session() && (
            <div className="mt-8 rounded-base border-2 border-border bg-bw p-6 shadow-shadow">
              <StorageModule tcw={tcw} />
            </div>
          )}

          {/* Space Management module - only show when signed in */}
          {spaceManagementEnabled === "On" && tcw && tcw.session() && (
            <div className="mt-8 rounded-base border-2 border-border bg-bw p-6 shadow-shadow">
              <SpaceModule tcw={tcw} />
            </div>
          )}

          {/* Delegation Management module - only show when signed in */}
          {delegationEnabled === "On" && tcw && tcw.session() && (
            <div className="mt-8 rounded-base border-2 border-border bg-bw p-6 shadow-shadow">
              <DelegationModule tcw={tcw} />
            </div>
          )}

          {/* Public Space module - show when toggle is on (read works without auth) */}
          {publicSpaceEnabled === "On" && (
            <div className="mt-8 rounded-base border-2 border-border bg-bw p-6 shadow-shadow">
              <PublicSpaceModule tcw={tcw} tinyCloudHost={tinyCloudHost} />
            </div>
          )}

          {/* Vault module - only show when signed in */}
          {vaultEnabled === "On" && tcw && tcw.session() && (
            <div className="mt-8 rounded-base border-2 border-border bg-bw p-6 shadow-shadow">
              <VaultModule tcw={tcw} />
            </div>
          )}

          {/* Session-only mode storage info */}
          {storageEnabled === "On" && tcw && tcw.isSessionOnly && !tcw.session() && (
            <div className="mt-8 rounded-base border-2 border-border bg-bw p-6 shadow-shadow">
              <div className="text-center p-4">
                <p className="text-sm text-text/70 mb-2">
                  Storage requires signing in. In session-only mode, connect a wallet first.
                </p>
                <p className="text-xs text-text/50">
                  Your session DID can receive delegations from other users,
                  allowing you to access their shared data.
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="mt-auto w-full">
          <Footer />
        </div>
      </div>
    </>
  );
}

export default Home;

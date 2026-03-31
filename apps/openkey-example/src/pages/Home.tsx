// @ts-nocheck
import { useEffect, useState, lazy, Suspense } from "react";
import { useLocation } from "react-router-dom";
import { TinyCloudWeb } from "@tinycloud/web-sdk";
import { OpenKey, OpenKeyProvider } from "@openkey/sdk";
import { providers } from "ethers";
import Header from "../components/Header";
import Footer from "../components/Footer";
import { DocumentSidebar } from "../components/documents/DocumentSidebar";
import { EditorLayout } from "../components/editor/EditorLayout";
import { useDocuments } from "../hooks/useDocuments";

// Lazy load heavy components
const ShareModal = lazy(() => import("../components/sharing/ShareModal").then(m => ({ default: m.ShareModal })));
const SettingsPanel = lazy(() => import("../components/settings/SettingsPanel").then(m => ({ default: m.SettingsPanel })));

function Home() {
  const location = useLocation();

  const [loading, setLoading] = useState(false);
  const [tcw, setTinyCloudWeb] = useState<TinyCloudWeb | null>(null);
  const [openKeyAddress, setOpenKeyAddress] = useState<string | null>(null);
  const [web3Provider, setWeb3Provider] = useState<providers.Web3Provider | null>(null);

  // Configuration
  const [storageEnabled, setStorageEnabled] = useState<string>("On");
  const [spaceManagementEnabled, setSpaceManagementEnabled] = useState<string>("Off");
  const [delegationEnabled, setDelegationEnabled] = useState<string>("Off");
  const [vaultEnabled, setVaultEnabled] = useState<string>("On");
  const [prefix, setPrefix] = useState<string>("demo-app");
  const [tinyCloudHost, setTinyCloudHost] = useState<string>(
    window.__DEV_MODE__ ? "http://localhost:8000" : ""
  );
  const [openKeyHost, setOpenKeyHost] = useState<string>(
    window.__DEV_MODE__ ? "http://localhost:5173" : "https://openkey.so"
  );

  // UI state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [shareModalOpen, setShareModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Documents (pass web3Provider for vault support)
  const {
    documents,
    activeDocument,
    loading: docsLoading,
    saving,
    error: docsError,
    vaultUnlocked,
    loadDocuments,
    openDocument,
    createNewDocument,
    saveDocument,
    deleteDocument,
    updateContent,
    unlockVault,
  } = useDocuments(tcw, web3Provider);

  // Parse URL parameters on component mount
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const urlPrefix = queryParams.get("prefix");
    if (urlPrefix) {
      setPrefix(urlPrefix);
    }
  }, [location.search]);

  // Load documents on sign-in
  useEffect(() => {
    if (tcw) {
      loadDocuments();
    }
  }, [tcw, loadDocuments]);

  const getTinyCloudWebConfig = (tcwConfig: Record<string, any> = {}) => {
    const modules: Record<string, any> = {};

    if (storageEnabled === "Off") {
      modules.storage = false;
    } else {
      const storageConfig: Record<string, any> = {
        prefix: prefix.trim(),
      };
      if (tinyCloudHost.trim()) {
        storageConfig.hosts = [tinyCloudHost.trim()];
      }
      modules.storage = storageConfig;
    }

    tcwConfig = {
      ...tcwConfig,
      modules,
    };

    if (tinyCloudHost.trim()) {
      tcwConfig.tinycloudHosts = [tinyCloudHost.trim()];
    }

    tcwConfig.kvPrefix = prefix.trim();

    return tcwConfig;
  };

  const connectAndSignIn = async () => {
    if (tcw) return;
    setLoading(true);

    try {
      const openkey = new OpenKey({ host: openKeyHost });
      const authResult = await openkey.connect();
      setOpenKeyAddress(authResult.address);

      const eip1193Provider = new OpenKeyProvider(openkey, authResult);
      const ethersProvider = new providers.Web3Provider(eip1193Provider as any);

      const tcwConfig = getTinyCloudWebConfig({
        providers: {
          web3: {
            driver: ethersProvider,
          },
        },
      });

      const tcwProvider = new TinyCloudWeb(tcwConfig);
      await tcwProvider.signIn();
      setTinyCloudWeb(tcwProvider);
      setWeb3Provider(ethersProvider);
    } catch (err) {
      console.error("Sign-in failed:", err);
    }
    setLoading(false);
  };

  const signOut = async () => {
    tcw?.signOut?.();
    setTinyCloudWeb(null);
    setOpenKeyAddress(null);
    setWeb3Provider(null);
  };

  // Pre-auth: Landing-styled login card
  if (!tcw) {
    return (
      <>
        <div className="flex min-h-screen flex-col items-center bg-bg relative">
          <div className="hero-glow" />

          {/* Pre-auth settings gear */}
          <button
            onClick={() => setSettingsOpen(true)}
            className="fixed top-4 right-4 z-50 p-2 rounded-base text-text/30 hover:text-text/60 transition-colors"
            title="Settings"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>

          <div className="flex-1 flex items-center justify-center w-full">
            <div className="relative z-10 w-full max-w-2xl mx-4">
              <div className="flex flex-col items-center mb-6">
                <div className="relative mb-5 inline-block w-full">
                  <a href="https://tinycloud.xyz/protocol">
                    <img
                      src="/tinycloudheader.png"
                      alt="TinyCloud"
                      className="w-full rounded-base border border-border bg-bw shadow-card"
                    />
                  </a>
                </div>
                <h1 className="text-3xl font-heading text-text text-center mb-2">
                  TinyCloud Markdown Editor
                </h1>
                <p className="text-sm text-text/60 max-w-xl text-center px-4">
                  Create, edit, and share markdown documents powered by{' '}
                  <a className="font-bold underline" target="_blank" rel="noopener noreferrer" href="https://tinycloud.xyz/protocol">TinyCloud</a>{' '}
                  decentralized storage. Sign in with{' '}
                  <a className="font-bold underline" target="_blank" rel="noopener noreferrer" href="https://openkey.so">OpenKey</a>{' '}
                  to get started.
                </p>
              </div>

              <div className="mx-auto max-w-md rounded-base border border-border bg-bw p-6 shadow-card">
                <div className="space-y-4">
                  <button
                    onClick={connectAndSignIn}
                    disabled={loading}
                    className="w-full h-11 rounded-base bg-main text-mtext font-medium text-sm border border-border shadow-card hover:shadow-card-hover transition-all disabled:opacity-50"
                  >
                    {loading ? "Connecting..." : "CONNECT WITH OPENKEY"}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="w-full">
            <Footer />
          </div>
        </div>

        {/* Pre-auth settings panel (hosts config only) */}
        <Suspense fallback={null}>
          {settingsOpen && (
            <SettingsPanel
              open={settingsOpen}
              onClose={() => setSettingsOpen(false)}
              address={null}
              session={undefined}
              tcw={null}
              web3Provider={null}
              openKeyHost={openKeyHost}
              onOpenKeyHostChange={setOpenKeyHost}
              tinyCloudHost={tinyCloudHost}
              onTinyCloudHostChange={setTinyCloudHost}
              prefix={prefix}
              onPrefixChange={setPrefix}
              storageEnabled={storageEnabled}
              onStorageEnabledChange={setStorageEnabled}
              spaceManagementEnabled={spaceManagementEnabled}
              onSpaceManagementEnabledChange={setSpaceManagementEnabled}
              delegationEnabled={delegationEnabled}
              onDelegationEnabledChange={setDelegationEnabled}
              vaultEnabled={vaultEnabled}
              onVaultEnabledChange={setVaultEnabled}
              onSignOut={() => {}}
            />
          )}
        </Suspense>
      </>
    );
  }

  // Post-auth: Full editor
  return (
    <>
      <Header
        address={openKeyAddress || undefined}
        docTitle={activeDocument?.doc.title}
        onDocTitleChange={(title) => {
          if (activeDocument) {
            const updated = { ...activeDocument.doc, title, updatedAt: new Date().toISOString() };
            saveDocument(activeDocument.key, updated);
          }
        }}
        onSidebarToggle={() => setSidebarOpen(!sidebarOpen)}
        onShare={() => setShareModalOpen(true)}
        onSettings={() => setSettingsOpen(true)}
        hasActiveDoc={!!activeDocument}
        isEncrypted={activeDocument?.doc.encrypted}
      />
      <div className="flex h-screen pt-14">
        <DocumentSidebar
          documents={documents}
          activeKey={activeDocument?.key || null}
          onOpen={openDocument}
          onNew={(encrypted) => createNewDocument(undefined, encrypted)}
          onDelete={deleteDocument}
          loading={docsLoading}
          open={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          vaultUnlocked={vaultUnlocked}
          onUnlockVault={unlockVault}
        />
        <div className="flex-1 flex flex-col min-h-0">
          {docsError && (
            <div className="px-4 py-2 bg-red-50 border-b border-red-200 text-sm text-red-700">
              {docsError}
            </div>
          )}
          {activeDocument ? (
            <EditorLayout
              content={activeDocument.doc.content}
              onChange={updateContent}
              saving={saving}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <h2 className="text-xl font-display text-text/30 mb-2">NO DOCUMENT SELECTED</h2>
                <p className="text-sm text-text/30 mb-4">Select a document from the sidebar or create a new one.</p>
                <button
                  onClick={() => createNewDocument()}
                  className="px-4 py-2 rounded-base bg-main text-mtext text-sm font-medium shadow-card hover:shadow-card-hover transition-all"
                >
                  New Document
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      <Suspense fallback={null}>
        {shareModalOpen && tcw && activeDocument && (
          <ShareModal
            tcw={tcw}
            documentKey={activeDocument.key}
            document={activeDocument.doc}
            tinyCloudHost={tinyCloudHost}
            open={shareModalOpen}
            onClose={() => setShareModalOpen(false)}
          />
        )}
        {settingsOpen && (
          <SettingsPanel
            open={settingsOpen}
            onClose={() => setSettingsOpen(false)}
            address={openKeyAddress}
            session={tcw?.session()}
            tcw={tcw}
            web3Provider={web3Provider}
            openKeyHost={openKeyHost}
            onOpenKeyHostChange={setOpenKeyHost}
            tinyCloudHost={tinyCloudHost}
            onTinyCloudHostChange={setTinyCloudHost}
            prefix={prefix}
            onPrefixChange={setPrefix}
            storageEnabled={storageEnabled}
            onStorageEnabledChange={setStorageEnabled}
            spaceManagementEnabled={spaceManagementEnabled}
            onSpaceManagementEnabledChange={setSpaceManagementEnabled}
            delegationEnabled={delegationEnabled}
            onDelegationEnabledChange={setDelegationEnabled}
            vaultEnabled={vaultEnabled}
            onVaultEnabledChange={setVaultEnabled}
            onSignOut={signOut}
          />
        )}
      </Suspense>
    </>
  );
}

export default Home;

import { useEffect, useState, lazy, Suspense } from "react";
import { useLocation } from "react-router-dom";
import { TinyCloudWeb, type Manifest } from "@tinycloud/web-sdk";
import { OpenKey } from "@openkey/sdk";
import { providers } from "ethers";
import { OpenKeyEIP1193Provider } from "@/lib/openkey-provider";
import Input from "@/components/Input";
import Button from "@/components/Button";
import Header from "@/components/Header";

const StorageModule = lazy(() => import("@/pages/StorageModule"));

/**
 * StorageModule reads, writes, lists and deletes KV keys at the root of the
 * `default` space and shares them with get + list links.
 */
const MANIFEST: Manifest = {
  app_id: "xyz.tinycloud.examples.openkey-vite",
  name: "TinyCloud OpenKey Vite Example",
  space: "default",
  prefix: "",
  defaults: false,
  permissions: [
    { service: "tinycloud.kv", path: "", actions: ["get", "put", "del", "list"] },
  ],
};

declare global {
  interface Window {
    tcw: TinyCloudWeb;
  }
}

function Home() {
  const location = useLocation();

  const [loading, setLoading] = useState(false);
  const [tcw, setTinyCloudWeb] = useState<TinyCloudWeb | null>(null);
  const [openKeyAddress, setOpenKeyAddress] = useState<string | null>(null);

  // Configuration
  const [prefix, setPrefix] = useState<string>("demo-app");
  const [tinyCloudHost, setTinyCloudHost] = useState<string>("");
  const [openKeyHost, setOpenKeyHost] = useState<string>("https://openkey.so");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Parse URL parameters on component mount
  useEffect(() => {
    const queryParams = new URLSearchParams(location.search);
    const urlPrefix = queryParams.get("prefix");
    if (urlPrefix) {
      setPrefix(urlPrefix);
    }
  }, [location.search]);

  const getTinyCloudWebConfig = (tcwConfig: Record<string, any> = {}) => {
    const storageConfig: Record<string, any> = {
      prefix: prefix.trim(),
    };
    if (tinyCloudHost.trim()) {
      storageConfig.hosts = [tinyCloudHost.trim()];
    }

    tcwConfig = {
      ...tcwConfig,
      modules: {
        storage: storageConfig,
      },
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
      // 1. Connect to OpenKey - opens popup for auth + key selection
      const openkey = new OpenKey({ host: openKeyHost });
      const authResult = await openkey.connect();
      setOpenKeyAddress(authResult.address);

      // 2. Create EIP-1193 provider that routes signing to OpenKey
      const eip1193Provider = new OpenKeyEIP1193Provider(openkey, authResult);

      // 3. Wrap in ethers Web3Provider for TinyCloudWeb compatibility
      const web3Provider = new providers.Web3Provider(eip1193Provider as any);

      // 4. Configure and create TinyCloudWeb
      const tcwConfig = getTinyCloudWebConfig({
        providers: {
          web3: {
            driver: web3Provider,
          },
        },
        manifest: MANIFEST,
      });

      const tcwProvider = new TinyCloudWeb(tcwConfig);

      // 5. Sign in - SIWE signing routed through OpenKey popup
      await tcwProvider.signIn();
      setTinyCloudWeb(tcwProvider);
    } catch (err) {
      console.error("Sign-in failed:", err);
    }
    setLoading(false);
  };

  const signOut = async () => {
    tcw?.signOut?.();
    setTinyCloudWeb(null);
    setOpenKeyAddress(null);
  };

  return (
    <>
      <Header address={openKeyAddress || undefined} />
      <div className="flex min-h-screen flex-col items-center pt-20">
        <div className="w-full max-w-4xl px-4 mb-6">
          <h1 className="mb-6 text-center text-3xl font-bold">
            TinyCloud + OpenKey
          </h1>

          <div className="mx-auto max-w-2xl rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
            <div className="space-y-6">
              {tcw ? (
                <>
                  <Button
                    id="signOutButton"
                    onClick={signOut}
                    loading={loading}
                    variant="default"
                    className="w-full"
                  >
                    SIGN-OUT FROM TINYCLOUD
                  </Button>

                  <div className="rounded-md border border-blue-200 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950">
                    <h4 className="mb-2 text-sm font-semibold">
                      Connected via OpenKey
                    </h4>
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between">
                        <span className="text-zinc-500 dark:text-zinc-400">
                          Address:
                        </span>
                        <span
                          className="max-w-[200px] truncate font-mono"
                          title={openKeyAddress || ""}
                        >
                          {openKeyAddress}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-zinc-500 dark:text-zinc-400">
                          OpenKey Host:
                        </span>
                        <span className="max-w-[200px] truncate font-mono">
                          {openKeyHost}
                        </span>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="space-y-4">
                  <div className="rounded border border-zinc-200 bg-zinc-50 p-3 text-center text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-400">
                    <p>
                      Click the button below to connect with OpenKey and sign
                      into TinyCloud. Signing requests will be routed through
                      OpenKey popups.
                    </p>
                  </div>

                  <Button
                    id="signInButton"
                    onClick={connectAndSignIn}
                    loading={loading}
                    variant="default"
                    className="w-full"
                  >
                    CONNECT WITH OPENKEY
                  </Button>

                  {/* Advanced Options */}
                  <div className="mt-4">
                    <button
                      onClick={() => setShowAdvanced(!showAdvanced)}
                      className="flex w-full items-center justify-between rounded-md border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                    >
                      <span>Advanced Options</span>
                      <span className="text-xs">
                        {showAdvanced ? "▲" : "▼"}
                      </span>
                    </button>

                    {showAdvanced && (
                      <div className="mt-3 space-y-4 rounded-md border border-zinc-200 p-4 dark:border-zinc-700">
                        {/* OpenKey Host */}
                        <div className="space-y-2 border-b border-zinc-100 pb-4 dark:border-zinc-800">
                          <h4 className="text-sm font-semibold">
                            OpenKey Host
                          </h4>
                          <Input
                            label="OpenKey Host"
                            value={openKeyHost}
                            onChange={setOpenKeyHost}
                            className="w-full"
                            placeholder="https://openkey.so"
                            helperText="The OpenKey instance to use for signing."
                          />
                        </div>

                        {/* TinyCloud Host */}
                        <div className="space-y-2 border-b border-zinc-100 pb-4 dark:border-zinc-800">
                          <h4 className="text-sm font-semibold">
                            TinyCloud Host
                          </h4>
                          <Input
                            label="TinyCloud Host (Optional)"
                            value={tinyCloudHost}
                            onChange={setTinyCloudHost}
                            className="w-full"
                            placeholder="node.tinycloud.xyz"
                            helperText="The location where your TinyCloud data is hosted."
                          />
                        </div>

                        {/* Prefix */}
                        <div className="space-y-2">
                          <h4 className="text-sm font-semibold">
                            Prefix Configuration
                          </h4>
                          <p className="text-xs text-zinc-500 dark:text-zinc-400">
                            Set the prefix for your TinyCloud storage access.
                          </p>
                          <Input
                            label="Prefix"
                            value={prefix}
                            onChange={setPrefix}
                            className="w-full"
                            helperText="Empty requests access to the root directory"
                            placeholder="/"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Storage module */}
          {tcw && tcw.session() && (
            <div className="mt-8 rounded-lg border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-700 dark:bg-zinc-900">
              <Suspense fallback={<div>Loading storage...</div>}>
                <StorageModule tcw={tcw} />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

export default Home;

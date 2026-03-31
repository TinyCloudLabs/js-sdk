// @ts-nocheck
import React, { useState, useEffect, useRef, useCallback, lazy, Suspense } from 'react';
import { useLocation, Link as RouterLink } from 'react-router-dom';
import { TinyCloudWeb } from '@tinycloud/web-sdk';
import { OpenKey, OpenKeyProvider } from '@openkey/sdk';
import { providers } from 'ethers';
import { Eye, Edit3, Save, Check, Columns, Code } from 'lucide-react';

const MarkdownPreview = lazy(() => import('../components/editor/MarkdownPreview').then(m => ({ default: m.MarkdownPreview })));
const MarkdownEditor = lazy(() => import('../components/editor/MarkdownEditor').then(m => ({ default: m.MarkdownEditor })));

interface DocumentEnvelope {
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  encrypted?: boolean;
}

function tryParseDocumentEnvelope(data: any): DocumentEnvelope | null {
  let obj = data;
  if (typeof data === 'string') {
    try { obj = JSON.parse(data); } catch { return null; }
  }
  if (obj && typeof obj === 'object' && obj.title && obj.content !== undefined && obj.createdAt) {
    return obj as DocumentEnvelope;
  }
  return null;
}

function parseShareMeta(token: string): { actions: string[] } | null {
  try {
    let encoded = token;
    if (encoded.startsWith('tc1:')) encoded = encoded.slice(4);
    encoded = decodeURIComponent(encoded);
    const decoded = atob(encoded);
    const parsed = JSON.parse(decoded);
    return { actions: parsed.delegation?.actions || [] };
  } catch {
    return null;
  }
}

const Shared = () => {
  const location = useLocation();
  const queryParams = new URLSearchParams(location.search);
  const shareToken = queryParams.get('share') || queryParams.get('data') || '';

  const [content, setContent] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [envelope, setEnvelope] = useState<DocumentEnvelope | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'read' | 'edit' | 'split'>('read');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Auth state for write access
  const [tcw, setTcw] = useState<TinyCloudWeb | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [signingIn, setSigningIn] = useState(false);

  const kvRef = useRef<any>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Parse permissions client-side (no network)
  const meta = shareToken ? parseShareMeta(shareToken) : null;
  const canWrite = meta?.actions?.includes('tinycloud.kv/put') ?? false;
  const isSignedIn = !!tcw;

  // Fetch content using static receiveShare (works without auth, single /delegate call)
  useEffect(() => {
    if (!shareToken) return;
    let cancelled = false;

    const fetchContent = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const result = await TinyCloudWeb.receiveShare(shareToken);
        if (cancelled) return;

        if (result.ok) {
          const raw = result.data.data;
          const env = tryParseDocumentEnvelope(raw);
          if (env) {
            setEnvelope(env);
            setTitle(env.title);
            setContent(env.content);
          } else {
            setContent(typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2));
          }
        } else {
          setError(result.error?.message || 'Failed to load content');
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      }

      if (!cancelled) setIsLoading(false);
    };

    fetchContent();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After sign-in, set up writable KV via sharing.receive()
  useEffect(() => {
    if (!tcw || !shareToken) return;
    let cancelled = false;

    const setupWrite = async () => {
      try {
        const result = await tcw.sharing.receive(shareToken);
        if (cancelled) return;
        if (result.ok) {
          kvRef.current = result.data.kv;
        }
      } catch (e) {
        console.error('Failed to set up write access:', e);
      }
    };

    setupWrite();
    return () => { cancelled = true; };
  }, [tcw, shareToken]);

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleSignIn = async () => {
    setSigningIn(true);
    try {
      const openkey = new OpenKey({ host: 'https://openkey.so' });
      const authResult = await openkey.connect();
      const eip1193Provider = new OpenKeyProvider(openkey, authResult);
      const ethersProvider = new providers.Web3Provider(eip1193Provider as any);

      const tcwInstance = new TinyCloudWeb({
        providers: { web3: { driver: ethersProvider } },
      });
      await tcwInstance.signIn();
      setTcw(tcwInstance);
    } catch (err) {
      console.error('Sign-in failed:', err);
    }
    setSigningIn(false);
  };

  const handleSave = useCallback(async () => {
    if (!kvRef.current || !envelope) return;
    setSaving(true);
    const updated: DocumentEnvelope = {
      ...envelope,
      content,
      updatedAt: new Date().toISOString(),
    };
    const result = await kvRef.current.put('', JSON.stringify(updated));
    if (result.ok) {
      setEnvelope(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  }, [content, envelope]);

  const handleContentChange = useCallback((newContent: string) => {
    setContent(newContent);
    setSaved(false);
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      if (kvRef.current && envelope) {
        handleSave();
      }
    }, 2000);
  }, [envelope, handleSave]);

  // No token
  if (!shareToken) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="text-center max-w-md px-4">
          <h1 className="text-2xl font-heading text-text mb-3">No Share Link</h1>
          <p className="text-sm text-text/60 mb-4">You need a share link to view content here.</p>
          <RouterLink to="/" className="text-sm text-main hover:underline">Go to editor</RouterLink>
        </div>
      </div>
    );
  }

  // Loading
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="text-center">
          <div className="h-6 w-6 border-2 border-main border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-text/50">Loading...</p>
        </div>
      </div>
    );
  }

  // Error
  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg">
        <div className="w-full max-w-lg px-4">
          <div className="rounded-base border border-red-300 bg-red-50 dark:bg-red-950/30 dark:border-red-800 p-6 text-center">
            <h2 className="text-lg font-heading text-red-800 dark:text-red-300 mb-2">Unable to load content</h2>
            <p className="text-sm text-red-700 dark:text-red-400 mb-4">{error}</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 rounded-base bg-main text-mtext text-sm font-medium"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Content loaded
  if (content !== null) {
    const isEditing = mode === 'edit' || mode === 'split';

    return (
      <div className="min-h-screen bg-bg flex flex-col">
        {/* Toolbar */}
        <div className="sticky top-0 z-10 bg-bw/80 backdrop-blur-sm border-b border-border">
          <div className="w-full max-w-5xl mx-auto px-6 h-12 flex items-center justify-between">
            <div className="flex items-center gap-3">
              {title && (
                <span className="text-sm font-heading text-text truncate max-w-[200px] sm:max-w-[400px]">{title}</span>
              )}
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-bg-surface text-text/50">
                {canWrite ? (
                  <><Edit3 className="h-3 w-3" /> Read & Write</>
                ) : (
                  <><Eye className="h-3 w-3" /> Read only</>
                )}
              </span>
            </div>

            <div className="flex items-center gap-1">
              {/* Write mode: signed in with write permissions */}
              {canWrite && isSignedIn && (
                <>
                  <button
                    onClick={() => setMode('read')}
                    className={`p-1.5 rounded-base transition-colors ${mode === 'read' ? 'bg-main/10 text-main' : 'text-text/40 hover:text-text/60'}`}
                    title="Read"
                  >
                    <Eye className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setMode('split')}
                    className={`p-1.5 rounded-base transition-colors hidden md:block ${mode === 'split' ? 'bg-main/10 text-main' : 'text-text/40 hover:text-text/60'}`}
                    title="Split view"
                  >
                    <Columns className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setMode('edit')}
                    className={`p-1.5 rounded-base transition-colors ${mode === 'edit' ? 'bg-main/10 text-main' : 'text-text/40 hover:text-text/60'}`}
                    title="Edit"
                  >
                    <Code className="h-4 w-4" />
                  </button>
                  {isEditing && (
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="ml-2 inline-flex items-center gap-1 px-2.5 py-1 rounded-base text-xs font-medium transition-colors bg-main/10 text-main hover:bg-main/20 disabled:opacity-50"
                    >
                      {saved ? <Check className="h-3 w-3" /> : <Save className="h-3 w-3" />}
                      {saving ? 'Saving...' : saved ? 'Saved' : 'Save'}
                    </button>
                  )}
                </>
              )}

              {/* Write permissions but not signed in: show sign-in prompt */}
              {/* TODO: re-enable once sharing.receive() write-back is wired up
              {canWrite && !isSignedIn && (
                <button
                  onClick={handleSignIn}
                  disabled={signingIn}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-base text-xs font-medium bg-main text-mtext border border-border shadow-card hover:shadow-card-hover transition-all disabled:opacity-50"
                >
                  <LogIn className="h-3 w-3" />
                  {signingIn ? 'Signing in...' : 'Sign in to edit'}
                </button>
              )}
              */}
            </div>
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 flex min-h-0">
          {mode === 'read' && (
            <div className="w-full max-w-3xl mx-auto px-6 py-8 overflow-auto">
              {title && (
                <h1 className="text-3xl font-heading tracking-tight text-text mb-6">{title}</h1>
              )}
              <Suspense fallback={<div className="text-text/50">Loading...</div>}>
                <MarkdownPreview content={content} />
              </Suspense>
            </div>
          )}

          {mode === 'edit' && (
            <div className="flex-1 overflow-auto">
              <Suspense fallback={<div className="p-4 text-text/50">Loading editor...</div>}>
                <MarkdownEditor content={content} onChange={handleContentChange} />
              </Suspense>
            </div>
          )}

          {mode === 'split' && (
            <>
              <div className="w-1/2 border-r border-border overflow-auto">
                <Suspense fallback={<div className="p-4 text-text/50">Loading editor...</div>}>
                  <MarkdownEditor content={content} onChange={handleContentChange} />
                </Suspense>
              </div>
              <div className="w-1/2 overflow-auto">
                <div className="max-w-none px-6 py-8">
                  <Suspense fallback={<div className="text-text/50">Loading...</div>}>
                    <MarkdownPreview content={content} />
                  </Suspense>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return null;
};

export default Shared;

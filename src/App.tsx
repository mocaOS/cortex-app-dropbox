import { useEffect, useState } from "react";
import SyncPanel from "./components/SyncPanel";
import { copyText } from "./lib/copy";
import {
  beginConnect,
  completeConnect,
  currentAccount,
  disconnect,
  getAppKey,
  isConnected,
} from "./lib/dropbox";

type Status =
  | { kind: "checking" }
  | { kind: "unconfigured" }
  | { kind: "disconnected"; appKey: string }
  | { kind: "error"; message: string }
  | { kind: "ready"; appKey: string; account: string };

/** Copy/paste PKCE connect flow — a sandboxed iframe can't host an OAuth
 * redirect or open popups, so the authorize URL (built WITHOUT redirect_uri)
 * makes Dropbox display the code on-screen for pasting back here. */
function ConnectFlow({
  appKey,
  onConnected,
}: {
  appKey: string;
  onConnected: () => void;
}) {
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setAuthorizeUrl(await beginConnect(appKey));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function complete() {
    setBusy(true);
    setError(null);
    try {
      await completeConnect(appKey, code);
      onConnected();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="border border-[var(--color-line)] bg-[var(--color-card)] p-6">
      <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-accent)]">
        Connect your Dropbox
      </h2>
      <ol className="mt-4 max-w-xl list-decimal space-y-3 pl-5 text-sm leading-relaxed text-[var(--color-muted)]">
        <li>
          Generate your personal authorization link and open it in a new
          browser tab (this sandboxed app cannot open tabs itself).
        </li>
        <li>
          Approve access in Dropbox — it will display an{" "}
          <span className="text-[var(--color-fg)]">authorization code</span>.
        </li>
        <li>Paste the code below. Nothing but you and Dropbox see it.</li>
      </ol>
      <p className="mt-4 max-w-xl border border-[var(--color-line)] px-4 py-3 text-xs leading-relaxed text-[var(--color-faint)]">
        The connection is checked for file access when you complete it: the
        Dropbox app must have <code className="font-mono">files.metadata.read</code>{" "}
        and <code className="font-mono">files.content.read</code> enabled on its
        App Console Permissions tab. Dropbox bakes permissions into tokens at
        connect time — if they change later, disconnect and connect again.
      </p>

      <div className="mt-5 space-y-4">
        {!authorizeUrl ? (
          <button
            onClick={() => void begin()}
            disabled={busy}
            className="border border-[var(--color-accent)] px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg)] disabled:opacity-40"
          >
            Generate connect link
          </button>
        ) : (
          <>
            <div className="space-y-3">
              <button
                onClick={() => {
                  void copyText(authorizeUrl).then((ok) => {
                    setCopyState(ok ? "copied" : "failed");
                    setTimeout(() => setCopyState("idle"), 2500);
                  });
                }}
                className="border border-[var(--color-accent)] px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg)]"
              >
                {copyState === "copied"
                  ? "Copied — open it in a new tab"
                  : copyState === "failed"
                    ? "Copy blocked — select below"
                    : "Copy authorize link"}
              </button>
              <input
                readOnly
                value={authorizeUrl}
                onFocus={(e) => e.currentTarget.select()}
                onClick={(e) => e.currentTarget.select()}
                className="w-full border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-[10px] text-[var(--color-muted)] outline-none focus:border-[var(--color-accent)]"
                aria-label="Dropbox authorize URL"
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="paste the authorization code"
                className="min-w-64 border border-[var(--color-line)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs outline-none focus:border-[var(--color-accent)]"
              />
              <button
                onClick={() => void complete()}
                disabled={busy || !code.trim()}
                className="border border-[var(--color-accent)] px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)] hover:text-[var(--color-bg)] disabled:opacity-40"
              >
                Complete connection
              </button>
            </div>
          </>
        )}
        {error && <p className="font-mono text-xs text-red-400">{error}</p>}
      </div>
    </div>
  );
}

export default function App() {
  const [status, setStatus] = useState<Status>({ kind: "checking" });

  async function check() {
    setStatus({ kind: "checking" });
    try {
      const appKey = await getAppKey();
      if (!appKey) {
        setStatus({ kind: "unconfigured" });
        return;
      }
      if (!(await isConnected())) {
        setStatus({ kind: "disconnected", appKey });
        return;
      }
      const account = await currentAccount(appKey);
      setStatus({ kind: "ready", appKey, account });
    } catch (err) {
      setStatus({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  useEffect(() => {
    void check();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-6 py-12">
      <header className="mb-10">
        <p className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-accent)]">
          Cortex App
        </p>
        <h1 className="mt-3 text-5xl font-bold tracking-[-0.04em] md:text-6xl">
          Dropbox Sync
        </h1>
        <p className="mt-4 max-w-xl text-[var(--color-muted)]">
          Pick folders in your Dropbox and Cortex keeps them in the knowledge
          graph: new and edited files flow in through Dropbox's delta cursors
          on a schedule — server-side, even with this tab closed.
        </p>
      </header>

      <div className="space-y-6">
        {status.kind === "checking" && (
          <p className="font-mono text-xs uppercase tracking-[0.1em] text-[var(--color-faint)]">
            checking connection…
          </p>
        )}

        {status.kind === "unconfigured" && (
          <div className="border border-[var(--color-line)] bg-[var(--color-card)] p-6">
            <h2 className="font-mono text-xs font-semibold uppercase tracking-[0.2em] text-[var(--color-accent)]">
              Setup required
            </h2>
            <ol className="mt-3 max-w-xl list-decimal space-y-3 pl-5 text-sm leading-relaxed text-[var(--color-muted)]">
              <li>
                Create a free <em>scoped</em> app at{" "}
                <code className="font-mono text-xs">dropbox.com/developers/apps</code>{" "}
                (PKCE flow — no app secret is needed anywhere).
              </li>
              <li>
                <span className="text-[var(--color-fg)]">
                  Open its Permissions tab and enable{" "}
                  <code className="font-mono text-xs">files.metadata.read</code>,{" "}
                  <code className="font-mono text-xs">files.content.read</code> and{" "}
                  <code className="font-mono text-xs">account_info.read</code>, then
                  Submit
                </span>{" "}
                — do this <em>before</em> connecting an account. Dropbox bakes the
                permissions into tokens when they are minted, so anyone already
                connected before a permissions change must disconnect and connect
                again to pick it up.
              </li>
              <li>
                Paste the app key into{" "}
                <code className="font-mono text-xs">DROPBOX_APP_KEY</code> under{" "}
                <span className="text-[var(--color-fg)]">
                  Settings → Apps → Dropbox Sync → Configure
                </span>
                .
              </li>
            </ol>
            <button
              onClick={() => void check()}
              className="mt-5 border border-[var(--color-line)] px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Re-check
            </button>
          </div>
        )}

        {status.kind === "disconnected" && (
          <ConnectFlow appKey={status.appKey} onConnected={() => void check()} />
        )}

        {status.kind === "error" && (
          <div className="border border-[var(--color-line)] bg-[var(--color-card)] p-6">
            <p className="font-mono text-xs text-red-400">{status.message}</p>
            <button
              onClick={() => void check()}
              className="mt-5 border border-[var(--color-line)] px-5 py-2 font-mono text-xs font-semibold uppercase tracking-[0.1em] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
            >
              Retry
            </button>
          </div>
        )}

        {status.kind === "ready" && (
          <>
            <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border border-[var(--color-line)] bg-[var(--color-card)] p-4">
              <span className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--color-muted)]">
                Connected
              </span>
              <span className="font-mono text-sm">{status.account}</span>
              <button
                onClick={() => {
                  void disconnect().then(() => void check());
                }}
                className="ml-auto font-mono text-xs text-[var(--color-faint)] transition-colors hover:text-red-400"
              >
                disconnect
              </button>
            </div>
            <SyncPanel appKey={status.appKey} />
          </>
        )}
      </div>

      <footer className="mt-10 font-mono text-xs text-[var(--color-faint)]">
        POWERED BY CORTEX — SYNC RUNS SERVER-SIDE, EVEN WITH THIS TAB CLOSED
      </footer>
    </div>
  );
}

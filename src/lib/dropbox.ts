/**
 * Dropbox client — browser-direct via OAuth 2 + PKCE.
 *
 * Dropbox's API is fully CORS-enabled, so the interactive parts (connect
 * flow, folder browsing) run straight from the browser against
 * api.dropboxapi.com (declared in `externalHosts`). No app secret exists
 * anywhere: PKCE public-client flow, and refresh-token refreshes need only
 * the app key.
 *
 * Connect flow without a redirect server (sandboxed iframes can't host an
 * OAuth callback): the authorize URL is opened WITHOUT redirect_uri, so
 * Dropbox displays the authorization code on-screen for copy/paste. The
 * app exchanges code + PKCE verifier for tokens and keeps the (non-expiring)
 * refresh token in app storage — where the scheduled server-side sync task
 * refreshes it into short-lived access tokens on every run.
 */

import { platform } from "./cortex";
import { storageDelete, storageGet, storagePut } from "./platform";

export const REFRESH_TOKEN_KEY = "auth/refresh_token";
const VERIFIER_KEY = "auth/pkce_verifier";

/** The admin-configured Dropbox app key, or null if not configured yet. */
export async function getAppKey(): Promise<string | null> {
  const res = await platform("config");
  if (!res.ok) return null;
  const data = await res.json();
  return data.values?.DROPBOX_APP_KEY ?? null;
}

export interface DropboxEntry {
  tag: "file" | "folder" | "deleted";
  id: string;
  name: string;
  pathDisplay: string;
  rev?: string;
  size?: number;
  isDownloadable?: boolean;
}

// ---------------------------------------------------------------------------
// PKCE connect flow
// ---------------------------------------------------------------------------

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Create a verifier + challenge, persist the verifier (app storage — the
 * sandboxed iframe has no localStorage), return the authorize URL. */
export async function beginConnect(appKey: string): Promise<string> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  const challenge = base64url(new Uint8Array(digest));
  await storagePut(VERIFIER_KEY, verifier);
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    token_access_type: "offline",
  });
  return `https://www.dropbox.com/oauth2/authorize?${params}`;
}

/** Exchange the pasted code for tokens and persist the refresh token. */
export async function completeConnect(appKey: string, code: string): Promise<void> {
  const verifier = await storageGet<string>(VERIFIER_KEY);
  if (!verifier) {
    throw new Error("Connect flow state lost — hit Connect again and retry.");
  }
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: code.trim(),
      grant_type: "authorization_code",
      client_id: appKey,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(
      `Dropbox rejected the code: ${detail?.error_description ?? res.status}`,
    );
  }
  const data = await res.json();
  if (!data.refresh_token) {
    throw new Error("Dropbox returned no refresh token — retry the connect flow.");
  }
  // The token response lists the actually-granted scopes. A missing file
  // scope means the App Console's Permissions tab wasn't set up — refuse the
  // connection with instructions NOW instead of failing on every later call
  // (Dropbox binds scopes at mint time; fixing permissions requires a fresh
  // connect anyway, so storing this token would only wedge the app).
  const granted = String(data.scope ?? "");
  if (granted) {
    const missing = ["files.metadata.read", "files.content.read"].filter(
      (scope) => !granted.split(/\s+/).includes(scope),
    );
    if (missing.length > 0) {
      throw new Error(
        `Dropbox granted no file access — enable ${missing.join(" + ")} on the ` +
          "App Console's Permissions tab (dropbox.com/developers/apps), then " +
          "Connect again. (Scope changes only apply to newly minted tokens.)",
      );
    }
  }
  await storagePut(REFRESH_TOKEN_KEY, data.refresh_token);
  await storageDelete(VERIFIER_KEY);
  cachedAccess = { token: data.access_token, expiresAt: Date.now() + 10 * 60_000 };
}

export async function isConnected(): Promise<boolean> {
  return (await storageGet<string>(REFRESH_TOKEN_KEY)) !== null;
}

export async function disconnect(): Promise<void> {
  await storageDelete(REFRESH_TOKEN_KEY);
  cachedAccess = null;
}

// ---------------------------------------------------------------------------
// Access tokens (browser side, for the interactive folder browser)
// ---------------------------------------------------------------------------

let cachedAccess: { token: string; expiresAt: number } | null = null;

async function accessToken(appKey: string): Promise<string> {
  if (cachedAccess && Date.now() < cachedAccess.expiresAt - 60_000) {
    return cachedAccess.token;
  }
  const refresh = await storageGet<string>(REFRESH_TOKEN_KEY);
  if (!refresh) throw new Error("Not connected to Dropbox.");
  const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refresh,
      client_id: appKey,
    }),
  });
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      await disconnect();
      throw new Error("Dropbox session revoked — connect again.");
    }
    throw new Error(`Dropbox token refresh failed: ${res.status}`);
  }
  const data = await res.json();
  cachedAccess = {
    token: data.access_token,
    expiresAt: Date.now() + (Number(data.expires_in) || 14400) * 1000,
  };
  return cachedAccess.token;
}

async function rpc(appKey: string, endpoint: string, body: unknown): Promise<any> {
  const token = await accessToken(appKey);
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    // Dropbox ships structured errors as JSON (error_summary) but request /
    // scope problems as text/plain — surface whichever arrived, the text
    // ones carry the actionable message (e.g. missing App Console scope).
    const raw = await res.text().catch(() => "");
    let summary = "";
    try {
      summary = JSON.parse(raw)?.error_summary ?? "";
    } catch {
      summary = raw.slice(0, 300);
    }
    throw new Error(`${endpoint} failed: ${summary || res.status}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Account + folder browsing (interactive)
// ---------------------------------------------------------------------------

export async function currentAccount(appKey: string): Promise<string> {
  const data = await rpc(appKey, "users/get_current_account", null);
  return data?.name?.display_name ?? data?.email ?? "connected";
}

/** Immediate children of a path ("" = root) for the picker: sub-folders
 * (selectable) and files (context — a folders-only listing looks broken). */
export async function listEntries(
  appKey: string,
  path: string,
): Promise<{ folders: DropboxEntry[]; files: DropboxEntry[] }> {
  const folders: DropboxEntry[] = [];
  const files: DropboxEntry[] = [];
  let data = await rpc(appKey, "files/list_folder", {
    path: path || "",
    recursive: false,
    limit: 500,
  });
  for (;;) {
    for (const entry of data.entries ?? []) {
      const tag = entry[".tag"];
      if (tag !== "folder" && tag !== "file") continue;
      (tag === "folder" ? folders : files).push({
        tag,
        id: entry.id,
        name: entry.name,
        pathDisplay: entry.path_display ?? entry.path_lower ?? "",
        rev: entry.rev,
        size: entry.size,
        isDownloadable: entry.is_downloadable,
      });
    }
    if (!data.has_more) break;
    data = await rpc(appKey, "files/list_folder/continue", { cursor: data.cursor });
  }
  const byName = (a: DropboxEntry, b: DropboxEntry) => a.name.localeCompare(b.name);
  return { folders: folders.sort(byName), files: files.sort(byName) };
}

export interface SelectionSurvey {
  fileCount: number;
  /** true when a root had more entries than the page budget — the count is
   * a floor, not an exact number */
  truncated: boolean;
}

/**
 * Project how many files the selected roots would sync: recursive
 * list_folder per root (Dropbox recurses server-side), counting entries the
 * caller's filter keeps. Page-capped so huge trees answer fast — beyond the
 * cap the count is reported as a floor.
 */
export async function surveySelection(
  appKey: string,
  paths: string[],
  keep: (entry: DropboxEntry) => boolean,
  maxPagesPerRoot = 4,
): Promise<SelectionSurvey> {
  let fileCount = 0;
  let truncated = false;
  for (const path of paths) {
    let data = await rpc(appKey, "files/list_folder", {
      path: path || "",
      recursive: true,
      limit: 500,
      include_deleted: false,
      include_non_downloadable_files: true,
    });
    for (let page = 0; ; page++) {
      for (const entry of data.entries ?? []) {
        if (entry[".tag"] !== "file") continue;
        const candidate: DropboxEntry = {
          tag: "file",
          id: entry.id,
          name: entry.name,
          pathDisplay: entry.path_display ?? "",
          rev: entry.rev,
          size: entry.size,
          isDownloadable: entry.is_downloadable,
        };
        if (keep(candidate)) fileCount += 1;
      }
      if (!data.has_more) break;
      if (page + 1 >= maxPagesPerRoot) {
        truncated = true;
        break;
      }
      data = await rpc(appKey, "files/list_folder/continue", { cursor: data.cursor });
    }
  }
  return { fileCount, truncated };
}

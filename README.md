# Dropbox Sync — a Cortex App

Sync selected [Dropbox](https://www.dropbox.com/) folders into the
[Cortex](https://github.com/mocaOS/cortex-app) knowledge graph — on demand
or on a schedule, fully server-side, with OAuth 2 + PKCE (no app secret
anywhere).

Pick folders in a built-in browser; Cortex tracks changes through Dropbox's
own delta cursors (`list_folder` / `continue`), downloads new and edited
files server-side and runs its normal ingestion pipeline on each. Edited
files replace their previous Cortex document instead of duplicating it.

Built from [cortex-app-template](https://github.com/mocaOS/cortex-app-template).
Type: `platform` — the sync itself runs **inside Cortex** as a declarative
platform task, not in your browser. Close the tab and it keeps going; give
it a schedule and it becomes a standing sync daemon with no browser anywhere.

> Requires a Cortex instance with dynamic task auth and binary passthrough
> upload (cortex-app ≥ 2.1 / July 2026 platform extensions).

## Install

1. Create a free **Dropbox scoped app** at
   [dropbox.com/developers/apps](https://www.dropbox.com/developers/apps):
   scoped access, the folders you want visible (Full Dropbox typically).
   Then — **before anyone connects** — open the app's **Permissions tab**,
   enable `files.metadata.read` + `files.content.read` + `account_info.read`,
   and Submit. Dropbox bakes permissions into tokens at mint time, so a
   permissions change after connecting requires a disconnect + reconnect
   (the app verifies granted scopes at connect time and refuses a file-blind
   token with instructions). You only need the **app key** — PKCE means the
   secret never leaves Dropbox. Below 50 linked users no production review
   is required.
2. `npm install && npm run package` → `dropbox-sync-{version}.zip`
3. Cortex admin → **Settings → Apps → Install**, upload the zip.
   (Requires `ENABLE_APPS=true` on the instance.)
4. Configure the app (Settings → Apps → Configure): `DROPBOX_APP_KEY`.
5. Open the app (`/apps` → Dropbox Sync) and **connect your Dropbox**:
   copy the generated authorize link into a new tab, approve, paste the
   code Dropbox shows you back into the app. The sandboxed iframe can't
   host an OAuth redirect — the copy/paste code flow replaces it.
6. Select folders, pick a schedule (or stay manual) and a target
   collection, and hit **Sync**.

## How the sync works

The app submits one declarative task (`tasks` capability) that Cortex
executes in its own async loop:

- **setup** — reads the (non-expiring) refresh token from app storage and
  exchanges it for a short-lived access token; then, per selected folder
  (max 8): first run `list_folder` (recursive, so sub-folders are always
  covered), afterwards `list_folder/continue` with the persisted cursor —
  Dropbox's delta feed returns exactly what changed.
- **per file** (2 in flight, per-item error isolation) — listings are
  concatenated and deduped against app storage (`synced/{id}:{rev}`).
  Folder/deleted entries, non-downloadable files (Paper docs), non-document
  extensions (optional) and files over ~19 MB are skipped with visible
  reasons. Changed files first delete their previous Cortex document
  (`docmap/{id}` remembers it), then a **binary passthrough upload**:
  Cortex POSTs `content.dropboxapi.com/2/files/download` server-side and
  streams the bytes straight into `POST /api/upload` (`source=dropbox-sync`).
- **finally** — persists each folder's new cursor, only when nothing
  failed, so failed files are re-listed and retried by the next run.
  Large first-time backlogs drain across runs (~200 entries per folder per
  run) — just let the schedule work or hit Sync now repeatedly.

The app UI is just a dashboard: live progress, pause / cancel /
retry-failed, and per-file errors. Runs survive Cortex restarts.

### Token custody

- The **refresh token** lives in the app's private storage inside your
  Cortex instance (per-app SQLite, no cross-app access; `sharing.links`
  is off). It never expires but can be revoked anytime in Dropbox →
  Settings → Connected apps.
- **Access tokens** are minted per run server-side (and per browser session
  for the folder picker, via CORS — Dropbox's API is browser-callable).
- There is **no app secret**: PKCE public-client flow; refreshes need only
  the app key.

### v1 limitations

- Deleting a file in Dropbox does **not** delete it in Cortex
  (`include_deleted` is off).
- Dropbox Paper / cloud-only docs are skipped (they need `files/export`).
- Files larger than ~19 MB are skipped (platform transfer cap).
- A revoked connection surfaces as a failed run — reconnect in the app.

## Manifest notes

- `keyScope: read_write` — uploads and replace-on-change deletes need MANAGE
- `endpoints: ["upload", "documents", "collections"]` — everything else 403s
- `capabilities: http` (hosts `api.dropboxapi.com` + `content.dropboxapi.com`
  for the server-side task), `tasks`, `storage`
- `externalHosts: ["https://api.dropboxapi.com"]` — the browser talks to
  Dropbox directly for connect + folder browsing (CORS-clean)

## Dev loop

```
cp .env.example .env   # CORTEX_DEV_URL + a cortex_rw_… key
npm run dev
```

The Vite proxy plays the hosting proxy's role in dev; platform calls hit
your configured dev instance.

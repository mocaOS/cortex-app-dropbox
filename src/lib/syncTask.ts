/**
 * The sync, as a Cortex platform task.
 *
 * Instead of a browser-side loop, the whole Dropbox → Cortex pipeline is a
 * declarative step-queue that Cortex executes server-side:
 *
 *   setup    read the refresh token from app storage → exchange it for a
 *            fresh access token (http step, PKCE public client — app key
 *            only) → per selected folder: read the persisted delta cursor,
 *            then EITHER list_folder (first run, recursive) OR
 *            list_folder/continue (incremental, Dropbox's own change feed)
 *   items    all listings concatenated (`fromEach`), deduped against storage
 *            keys synced/{id}:{rev} — the rev IS the change marker
 *   steps    skip folders/deleted/non-downloadable entries, optional
 *            extension filter, size cap → binary passthrough upload (Cortex
 *            POSTs content.dropboxapi.com/2/files/download server-side and
 *            streams the bytes into /api/upload) that REPLACES the file's
 *            existing Cortex document in place (source_key +
 *            replace_document_id from docmap — same document id, only the
 *            changed parts are re-extracted) → record docmap + marker
 *   finally  persist each folder's new cursor — only when nothing failed,
 *            so failed files are re-listed and retried by the next run
 *
 * Submit it once with a schedule and the sync runs forever, headless —
 * the browser tab is just a dashboard.
 */

import { storageGet, storagePut } from "./platform";

export const SYNC_TASK_NAME = "dropbox-sync";

/** Max selected root folders — each costs 3 setup steps (cursor + two
 * listing variants) against the platform's 50-step section cap, and the
 * per-run item budget below. */
export const MAX_ROOTS = 8;

/** list_folder page budget per folder per run: 8 folders × 200 stays well
 * under the 2000-item task cap even with Dropbox's "approximate" limits.
 * Backlogs beyond it are drained cursor-wise across runs. */
const PAGE_LIMIT = 200;

/** Files above this are skipped — the platform's server-side fetch caps
 * responses at 20 MB; leave headroom. */
const MAX_FILE_BYTES = 19_000_000;

/** Extensions Cortex ingestion handles well — the "documents only" filter.
 * Space-padded exact matching: {name|ext} of "report.pdf" → " pdf " ∈ list. */
const DOC_EXTS_LIST = [
  "pdf", "docx", "xlsx", "pptx", "doc", "md", "markdown", "txt", "text",
  "html", "htm", "csv", "epub", "png", "jpg", "jpeg", "tiff", "webp",
];
const DOC_EXTS = ` ${DOC_EXTS_LIST.join(" ")} `;

/** Client-side mirror of the task's per-item skip rules — drives the "~N
 * files will sync" projection so it matches what a run would actually do. */
export function wouldSync(
  entry: { name: string; size?: number; isDownloadable?: boolean },
  docsOnly: boolean,
): boolean {
  if (entry.isDownloadable === false) return false;
  if ((entry.size ?? 0) > MAX_FILE_BYTES) return false;
  if (!docsOnly) return true;
  const name = entry.name.replace(/^\.+/, "");
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return DOC_EXTS_LIST.includes(ext);
}

export interface SyncFolder {
  /** Dropbox path, e.g. "/Work/Reports" ("" = entire Dropbox) */
  path: string;
}

export interface SyncTaskOptions {
  folders: SyncFolder[];
  collectionId?: string;
  everyMinutes?: number;
  docsOnly?: boolean;
}

function folderKey(path: string): string {
  const slug = path.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "root";
}

/** Old backends (no in-place replace) answer an upload without a "replaced"
 * field and mint a new document — then remove the superseded one, exactly
 * like the pre-replace delete-then-upload flow did. */
const REPLACE_FALLBACK_STEPS = [
  {
    cortex: { method: "DELETE", path: "documents/{prev.value.docId}" },
    when: {
      and: [
        { notEmpty: "$prev.value.docId" },
        { eq: ["{up.body.replaced}", ""] },
        { neq: ["{up.body.document_id}", "{prev.value.docId}"] },
      ],
    },
  },
];

export function buildSyncTask(opts: SyncTaskOptions): Record<string, unknown> {
  const uploadParams = new URLSearchParams({
    start_processing: "true",
    source: "dropbox-sync",
  });
  if (opts.collectionId) uploadParams.set("collection_id", opts.collectionId);
  // Dropbox file ids ("id:…") are stable across renames and moves
  const uploadPath =
    `upload?${uploadParams.toString()}` +
    `&source_key=dropbox%3A{vars.id|urlencode}` +
    `&replace_document_id={prev.value.docId|urlencode}`;

  const auth = { bearer: "$tok.body.access_token" };
  const setup: Array<Record<string, unknown>> = [
    { id: "rt", store: { get: "auth/refresh_token" } },
    {
      id: "tok",
      http: {
        method: "POST",
        url: "https://api.dropboxapi.com/oauth2/token",
        contentType: "application/x-www-form-urlencoded",
        body:
          "grant_type=refresh_token&refresh_token={rt.value|urlencode}" +
          "&client_id={config.DROPBOX_APP_KEY|urlencode}",
        responseType: "json",
      },
    },
  ];
  const fromEach: string[] = [];
  const finallySteps: Array<Record<string, unknown>> = [];

  opts.folders.slice(0, MAX_ROOTS).forEach((folder, i) => {
    const key = folderKey(folder.path);
    setup.push(
      { id: `cur${i}`, store: { get: `cursor/${key}` } },
      {
        id: `l${i}a`,
        when: { empty: `$cur${i}.value` },
        http: {
          method: "POST",
          url: "https://api.dropboxapi.com/2/files/list_folder",
          body: {
            path: folder.path,
            recursive: true,
            limit: PAGE_LIMIT,
            include_deleted: false,
            include_non_downloadable_files: true,
          },
          auth,
        },
      },
      {
        id: `l${i}b`,
        when: { notEmpty: `$cur${i}.value` },
        http: {
          method: "POST",
          url: "https://api.dropboxapi.com/2/files/list_folder/continue",
          body: { cursor: `{cur${i}.value}` },
          auth,
        },
      },
    );
    fromEach.push(`$l${i}a.body.entries`, `$l${i}b.body.entries`);
    for (const variant of ["a", "b"]) {
      finallySteps.push({
        store: { put: `cursor/${key}`, value: `$l${i}${variant}.body.cursor` },
        when: {
          and: [
            { eq: ["$run.failedCount", 0] },
            { notEmpty: `$l${i}${variant}.body.cursor` },
          ],
        },
      });
    }
  });

  return {
    name: SYNC_TASK_NAME,
    ...(opts.everyMinutes ? { schedule: { everyMinutes: opts.everyMinutes } } : {}),
    concurrency: 2,
    setup,
    items: {
      fromEach,
      vars: {
        id: "{item.id}",
        name: "{item.name}",
        path: "{item.path_display}",
        rev: "{item.rev}",
        size: "{item.size}",
        dl: "{item.is_downloadable}",
      },
      skipIfStored: "synced/{item.id}:{item.rev}",
    },
    steps: [
      // folders and deleted entries carry no rev
      {
        skipItem: {
          when: { empty: "$vars.rev" },
          reason: "folder or deleted entry",
        },
      },
      {
        skipItem: {
          when: { eq: ["{vars.dl}", "False"] },
          reason: "not downloadable (Paper/cloud doc)",
        },
      },
      ...(opts.docsOnly !== false
        ? [
            {
              skipItem: {
                when: { not: { contains: [DOC_EXTS, " {vars.name|ext} "] } },
                reason: "not a document type (.{vars.name|ext})",
              },
            },
          ]
        : []),
      {
        skipItem: {
          when: { gt: ["{vars.size}", MAX_FILE_BYTES] },
          reason: "larger than the 19 MB transfer cap",
        },
      },
      // previous sync state for this file (edit tracking by Dropbox file id)
      { id: "prev", store: { get: "docmap/{vars.id}" } },
      // binary passthrough: server-side Dropbox download → Cortex upload. A
      // changed file REPLACES its document in place (same id — Cortex
      // re-extracts only what changed): source_key finds it,
      // replace_document_id adopts documents synced before source keys
      // existed. Empty when new.
      {
        id: "up",
        cortex: {
          method: "POST",
          path: uploadPath,
          multipart: {
            fromUrl: "https://content.dropboxapi.com/2/files/download",
            method: "POST",
            headers: { "Dropbox-API-Arg": '{{"path": "{vars.id}"}}' },
            auth,
            filename: "dropbox-{vars.name}",
          },
        },
      },
      // compatibility: a Cortex backend without in-place replace ignores the
      // replace params and creates a new document (its response has no
      // "replaced" field) — delete the previous one as older app versions did
      ...REPLACE_FALLBACK_STEPS,
      {
        store: {
          put: "docmap/{vars.id}",
          value: {
            rev: "{vars.rev}",
            docId: "{up.body.document_id}",
            name: "{vars.name}",
            path: "{vars.path}",
            at: "{run.startedAt}",
          },
        },
      },
      {
        store: {
          put: "synced/{vars.id}:{vars.rev}",
          value: { at: "{run.startedAt}" },
        },
      },
    ],
    finally: finallySteps,
  };
}

// UI preferences, persisted server-side so every device sees the same setup.
export interface SyncPrefs {
  folders?: SyncFolder[];
  collectionId?: string;
  everyMinutes?: number;
  docsOnly?: boolean;
}

const PREFS_KEY = "settings/prefs";

export async function loadPrefs(): Promise<SyncPrefs> {
  return (await storageGet<SyncPrefs>(PREFS_KEY)) ?? {};
}

export async function savePrefs(prefs: SyncPrefs): Promise<void> {
  await storagePut(PREFS_KEY, prefs);
}

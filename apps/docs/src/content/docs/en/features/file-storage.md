---
title: Files and storage
description: File manager with previews on local disk or S3-compatible storage (Apache OpenDAL), instant upload by hash, parallel chunks and resume after refresh.
sidebar:
  order: 5
---

The file module is a file manager (grid or list view, category rail, in-browser previews) on top of a storage layer that puts local disk and any S3-compatible bucket behind one [Apache OpenDAL](https://opendal.apache.org/) interface. Every upload goes through one global queue: the browser hashes the file with SHA-256 first and skips the transfer if the same file already exists; files of 16 MiB or more go up in 8 MiB chunks, three at a time, and resume after a page refresh. You can try it in the [live demo](https://fra.wubunan.com/sign-in) (`admin` / `123456`).

## Where is it in the UI?

| Screen | Path | Permission code | What it does |
|---|---|---|---|
| **System → Files** | `/system/file` | `sys:file:list` | File list, preview, download; recycle bin |
| Same page, upload | — | `sys:file:upload` | Every single and chunked upload endpoint, plus attaching / detaching files on records |
| Same page, **Delete** / **Revert** / **Delete permanently** / **Empty recycle bin** | — | `sys:file:del` | |
| **System → Storage** | `/system/storage` | `sys:storage:list` · `add` · `edit` · `del` | Create local / S3 storage, test the connection, set the default, enable or disable; `edit` covers testing and setting the default |
| Attachment panel on any page | — | Reading needs only a sign-in; attaching needs `sys:file:upload` | See [How do I attach files to a record?](#how-do-i-attach-files-to-a-record) |
| Upload tray, bottom right | — | — | The global upload queue; see [What is the upload tray?](#what-is-the-upload-tray) |

Download, preview, direct-link and instant-upload checks only require a sign-in; whether a given file can be read is decided by the rules in [How do downloads work?](#how-do-downloads-work).

## What can the file manager preview?

PDF, Word (`docx`/`doc`/`odt`), spreadsheets (`xlsx`/`xls`/`csv`), `pptx`, images, text and code files, archives (`zip`/`rar`/`7z`/`tar`/`gz`) and audio/video. The renderers come from the `@file-viewer` packages (Apache-2.0). The page fetches the bytes with the user's token and hands the viewer a buffer, so there is no unauthenticated URL. Two limits come from measurements in the repo:

- **Images are gated by pixel count, not bytes.** A 400-megapixel PNG froze the main thread for 5.2 s when handed to the viewer; images above 150 MP are download-only. The check reads only the file header.
- Audio and video above 100 MB are download-only, because playback starts only after the whole file has been downloaded.

Grid thumbnails use the original image only for non-SVG images of 1 MB or less, loaded lazily.

## Where can files be stored?

- **Built-in local storage**: files with `sys_file.storage_id = NULL`, under `apps/api/backend/upload/`. This is deliberately outside `backend/static/`, which is served without auth.
- **Storages you add** on the Storage page, type `local` or `s3`, with *Test connection* (writes, reads back and deletes a probe object) and *Set as default*.
- Every storage has a **private** and a **public** subtree. Public uploads must be images; they are meant for inline pictures in rich text, because an `<img src>` can't send an auth header. They are served without auth at `/uploads/{key}`, or through `public_base_url` if you put a CDN in front.

Switching the default only affects new uploads. Reads, deletes and signed URLs always use the storage recorded on the file. A storage that still holds files, including ones in the recycle bin, cannot be deleted. The S3 SecretKey is encrypted with `STORAGE_ENCRYPT_SECRET_KEY`; if that key is empty, saving an S3 storage fails instead of storing plaintext.

Every OpenDAL S3 operator is built with these two options, and both are needed:

```python
'disable_config_load': 'true',   # otherwise an empty AK signs with the server's own AWS_ACCESS_KEY_ID
'disable_ec2_metadata': 'true',  # otherwise empty credentials stall ~30 s probing 169.254.169.254
```

Saving a storage rejects endpoints that resolve to link-local, unspecified or multicast addresses such as `169.254.169.254`. *Test connection* sends requests from the server, so without this check it could be used for SSRF. Private-network hosts are allowed, because MinIO on the LAN is the most common setup.

:::note
Addressing `auto` switches to virtual-host style for Alibaba OSS, Tencent COS, Qiniu, Huawei OBS and Volcengine endpoints. That rule follows the vendors' documentation. It has not been tested against real accounts on those clouds; the S3 tests run against moto and RustFS.
:::

## How do downloads work?

Private files are read through `GET /api/v1/sys/files/{id}/download`, which needs a token and streams from the backend. For files on a storage row, the download button first calls `GET /api/v1/sys/files/{id}/link`. On S3 this returns a pre-signed URL valid for `STORAGE_PRESIGN_EXPIRE_SECONDS` (default 300), and the browser downloads straight from the bucket. Local storage returns `url: null`, because OpenDAL's fs backend can't pre-sign. In that case, and for built-in storage, the frontend fetches `/download` with the token and saves the Blob. Previews always stream through the backend, so the bucket needs no CORS rules.

A user can read a file if it is public, they uploaded it, they hold `sys:file:list`, or a business module (notices, approvals) says they can. Everyone else gets **404**, not 403, so the response doesn't confirm that the ID exists. Checking only for a signed-in user would not be enough, because snowflake IDs show up in URLs, logs and approval form data.

## How does instant upload work?

The browser hashes the file incrementally with `hash-wasm`. `crypto.subtle` needs the whole file in memory and is `undefined` on plain-HTTP LAN addresses. It then calls `GET /api/v1/sys/files/check`. If the same user already uploaded the same name with the same content to the same storage, zero bytes are sent and the existing record is reused. The file name is part of the key, so a renamed copy becomes a separate record. Files in the recycle bin are never reused.

## How are large files uploaded?

Files below the threshold go up in one `POST /upload`. Larger ones use five endpoints, all requiring `sys:file:upload`:

| Step | Endpoint |
|---|---|
| start (same extension / size / public-image checks as `/upload`) | `POST /api/v1/sys/files/multipart` |
| send part *n*, raw bytes, 3 in parallel | `PUT /api/v1/sys/files/multipart/{upload_id}/{n}` |
| which parts the server has | `GET /api/v1/sys/files/multipart/{upload_id}` |
| merge, hash and save (checks run again) | `POST /api/v1/sys/files/multipart/{upload_id}/complete` |
| cancel and delete parts | `DELETE /api/v1/sys/files/multipart/{upload_id}` |

The session lives in Redis and expires after 24 hours without activity. Each part renews it. Parts are stored in the target storage under `_multipart/{upload_id}/`, so any backend replica can accept any part. This was checked with two uvicorn processes taking alternate parts against RustFS. The server counts bytes while a part streams in and cuts the connection as soon as a part goes over the chunk size. A Redis lock lets only one of two concurrent `complete` calls merge; the other gets 409. A daily job (`maintenance.purge_stale_multipart`, 04:00) removes parts left by expired sessions.

The threshold and chunk size (defaults 16 MiB and 8 MiB) can be changed under Config → Files → File uploads and reach the browser through `GET /api/v1/sys/files/upload-policy`. The threshold is capped at 99 MiB because `apps/web/nginx.conf` sets `client_max_body_size 100m` for the single-request path.

:::caution
These are not native S3 multipart uploads: OpenDAL doesn't expose UploadPart/ListParts. `complete` reads the parts back and writes the final object, so object storage sees the bytes twice. File size is still capped per category (defaults: images 5 MB, documents 50 MB, audio/video 20 MB, archives 100 MB, set by `UPLOAD_*_SIZE_MAX`).
:::

## How does a refresh resume an upload?

A refresh loses the browser's `File` object, so the user has to pick the file again. `resume.ts` keeps a map in `localStorage` from a fingerprint (name + size + last-modified time) to `upload_id`. When the upload tray mounts, it checks each entry with `GET …/multipart/{id}` and drops expired ones. The rest show as "N uploads not finished" with *Continue* and *Discard*. If the picked file's fingerprint doesn't match, an error toast appears and nothing is sent. Picking the same file again on the files page also resumes it.

Measured with Playwright at 3 MiB/s: a 40 MiB file (5 parts) refreshed after parts 1–3 sent **only parts 4 and 5** plus `complete`, and the SHA-256 matched the original. Cancel deletes the server session; a failure keeps it, and *Retry* continues from the last part.

## What is the upload tray?

A global queue (a zustand store) mounted in the app shell, outside the tabs. Closing the files tab or switching pages doesn't cancel anything. The tray shows "Uploading N items", time remaining and per-file status, with cancel and retry. A toast tells you when a file finishes while the tray is collapsed. Files upload one at a time; parts within a file go in parallel.

## How do I attach files to a record?

```tsx
<FileAttachments targetType={NOTICE_ATTACHMENT_TARGET} targetId={notice.id} />
```

Any page can embed the panel by passing a target type and ID (stored in `sys_file_relation`). *Remove* only unlinks the file. Attaching is idempotent. `target_type` isn't validated on the backend, so use a constant. Pass `readOnly` where users only view the record.

## What happens when a file is deleted?

It moves to the recycle bin: flagged as deleted, unlinked from records, object left in place. Files in the bin can't be read (every read path returns 404). *Restore* re-attaches the links that this delete removed, but not links someone removed by hand earlier. A daily job (`maintenance.purge_recycled_files`, 03:45) purges files older than `FILE_RECYCLE_DAYS` (default 30; `0` turns the bin off).

## How do I try S3 locally?

```bash
docker compose -f docker-compose.dev.yml --profile s3 up -d rustfs   # S3 API on :9100
```

Set `STORAGE_ENCRYPT_SECRET_KEY` in `apps/api/backend/.env` (`openssl rand -hex 32`). Then add a storage with endpoint `http://127.0.0.1:9100`, a bucket you created, the access key pair from `docker-compose.dev.yml`, and path-style addressing (RustFS without `server-domains` only accepts path style).

## Which settings are there?

**Changed in the UI** (System → Config → **File uploads**); they apply to uploads that start afterwards, not to ones already in progress:

| Key | Default | Notes |
|---|---|---|
| `FILE_CHUNK_THRESHOLD` | `16` (MiB) | Files at least this large are uploaded in chunks; maximum 99, which must stay below nginx's `client_max_body_size 100m` |
| `FILE_CHUNK_SIZE` | `8` (MiB) | Size of each chunk, 1–64 |

⚠️ Both also exist in `.env` **in bytes**; while the Config group is on, the database values win.

**`.env` only**, restart the backend after changing:

| Key | Default | Notes |
|---|---|---|
| `STORAGE_ENCRYPT_SECRET_KEY` | empty | Encrypts S3 secret keys; while empty, saving an S3 storage fails instead of storing plain text |
| `STORAGE_PRESIGN_EXPIRE_SECONDS` | `300` | Lifetime of S3 pre-signed download URLs |
| `FILE_RECYCLE_DAYS` | `30` | Days in the recycle bin; `0` = no recycle bin, deletes are permanent |
| `FILE_MULTIPART_EXPIRE_SECONDS` | `86400` | How long an idle chunked-upload session lives |
| `UPLOAD_IMAGE_SIZE_MAX` · `UPLOAD_DOCUMENT_SIZE_MAX` · `UPLOAD_VIDEO_SIZE_MAX` · `UPLOAD_AUDIO_SIZE_MAX` · `UPLOAD_ARCHIVE_SIZE_MAX` | 5 MB · 50 MB · 20 MB · 20 MB · 100 MB | Per-type size limit for one file (bytes) |
| `UPLOAD_*_EXT_INCLUDE` | see `conf.py` | Allowed extensions per type |

They are defined in the upload, recycle bin, chunked upload and storage sections of [`core/conf.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/core/conf.py).

## Where it lives in the code

- [`apps/api/backend/utils/storage_ops.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/utils/storage_ops.py): OpenDAL operators, pre-signing, endpoint checks
- [`apps/api/backend/app/admin/service/multipart_service.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/service/multipart_service.py): chunked upload sessions
- [`apps/api/backend/app/admin/api/v1/sys/file.py`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/api/backend/app/admin/api/v1/sys/file.py): file endpoints
- [`packages/platform/src/upload/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/upload): hashing, queue, chunked upload, resume
- [`packages/platform/src/pages/file/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/pages/file): file manager, preview dialog, attachment panel
- [`packages/platform/src/pages/file/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/packages/platform/src/pages/file/AGENTS.md): design notes and measurements

## How it is tested

- Backend pytest against a real database and Redis: `test_file.py` (33 tests), `test_multipart.py` (26 cases), `test_recycle.py` (12), plus `test_storage.py`, `test_upload_policy_config.py` and `test_file_access.py`. `test_storage.py` runs on an in-process moto S3; set `STORAGE_TEST_S3_ENDPOINT` to run it against a real S3 service, which adds the cases moto can't check, such as a wrong SecretKey.
- Mutation testing: 11 deliberate breakages in the chunked upload path (no permission check on a part, no lock, no size cut-off…) and 6 in the recycle bin each turned a test red.
- Frontend: 20 Vitest cases in `packages/platform/src/upload/` and the Playwright specs `file-upload.spec.ts` and `file-preview.spec.ts`.

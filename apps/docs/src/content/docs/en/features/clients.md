---
title: Desktop and mobile clients
description: An Electron desktop app with Windows, macOS and Linux installers, auto-update and silent printing, plus a native Expo / React Native mobile app.
sidebar:
  order: 9
---

The repo ships two clients alongside the browser. `apps/desktop` runs the same web build inside Electron and adds what a browser can't do: silent printing, local hardware through native helper processes, a refresh token held by the main process, and auto-update. Each GitHub Release carries installers for Windows, macOS and Linux. `apps/mobile` is a native Expo / React Native app with its own screens, not a WebView around the web pages. It shares the API client and translations with the web app.

## Where do I download the desktop app?

From [GitHub Releases](https://github.com/yilecoding/fastapi-react-admin/releases). Each release has:

| Platform | File | Notes |
|---|---|---|
| Windows 10/11 x64 | `admin-desktop-<version>-setup.exe` | NSIS installer, per-user install into `%LOCALAPPDATA%\Programs`, no admin rights |
| macOS Apple Silicon / Intel | `admin-desktop-<version>-arm64.dmg` / `-x64.dmg` | the matching `.zip` files are for the updater |
| Linux x64 | `admin-desktop-<version>-x86_64.AppImage` | `chmod +x` and run |

The `.blockmap` and `latest*.yml` files are for the updater; you don't download them yourself.

:::caution[The installers are not code-signed]
Windows SmartScreen warns once (*More info → Run anyway*). macOS Gatekeeper says the app "is damaged": right-click → *Open*, or run `xattr -dr com.apple.quarantine "/Applications/Admin Desktop.app"`. The release workflow already passes `CSC_LINK`, `CSC_KEY_PASSWORD` and the `APPLE_*` secrets to electron-builder, so signing (and notarization on macOS) can be turned on by adding those secrets instead of editing the workflow. That path hasn't been exercised with real certificates yet.
:::

## What does the desktop shell add?

The shell (Electron 42) contains no business code; the pages are the same `apps/web` build. The renderer talks to the main process through `window.desktop`, which exposes six namespaces (`app`, `config`, `auth`, `print`, `devices`, `updater`). The IPC contract lives in `packages/platform/src/desktop/contract.ts`.

- **Silent printing.** `print.html()` renders HTML in a hidden window and calls `webContents.print({ silent: true })`, so no dialog appears. It uses the printer named in config or the system default. This works for HTML only, not for an existing PDF, so labels are built as HTML with CSS `@page`; `buildLabelHtml()` helps with that. `print.htmlToPdf()` runs the same pipeline to a PDF for checking layouts without a printer. A failed print returns `{ ok: false, reason }`, never a false success. Silent printing is the reason recorded in [`apps/desktop/README.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/desktop/README.md) for choosing Electron.
- **Local hardware.** Device adapters start a native helper process and stream its events to `devices.on()`. The shell ships an ID-card-reader adapter. When the vendor's helper `.exe` isn't in `resources/`, the adapter runs in stub mode and `devices.simulate()` fires fake events, so the read → fetch → print flow can be developed on macOS.
- **Credentials.** The renderer is served from `app://local`, so the browser's refresh cookie (`SameSite=Lax`) isn't sent to the backend. The main process therefore keeps the refresh token, encrypted with Electron `safeStorage` (DPAPI on Windows, Keychain on macOS), and hands only the access token to the page. This path has passed type checks but not yet an end-to-end test in a packaged build.
- **Runtime config.** `config.json` in the app's user-data directory holds `serverUrl`, `printerName`, `kiosk`, `autoLaunch` and `updateUrl`. One installer can serve every environment; nothing is compiled in.

```ts
import { isDesktop, desktop } from "@admin/platform/desktop"

if (isDesktop()) {
  const res = await desktop().print.html(html, { pageSize: { width: 60000, height: 40000 } }) // microns
  if (!res.ok) showError(res.reason)
}
```

Measured while building the shell: `print()` takes `pageSize` in microns, while `printToPDF()` takes inches. With `preferCSSPageSize` and an `@page` rule, a 60 × 40 mm label came out at 59.944 × 39.878 mm (0.09% off).

## How does the desktop app update itself?

It uses `electron-updater`. The feed is `updateUrl` from `config.json` if set (a "generic" source: any static HTTP directory, e.g. on a customer's intranet). Otherwise it is the `app-update.yml` baked in at build time, which points at this repo's GitHub Releases. Updates download automatically and install when the app quits. `quitAndInstall(true, true)` installs silently and relaunches; without those flags the NSIS wizard opens and waits for a click. The renderer drives it through `desktop().updater.check()`, `.on()` and `.quitAndInstall()`. The web app doesn't call `check()` by itself, so add a button or a startup call in your app.

| Platform | Auto-update |
|---|---|
| Windows (NSIS) | works; per-user install, so updates need no UAC prompt |
| Linux (AppImage) | works |
| macOS | **does not work** while builds are unsigned: electron-updater checks the running app's code signature |

For an intranet mirror, publish `<version>.exe`, its `.blockmap` and `latest.yml`, uploading `latest.yml` **last** and serving it without caching. The `.blockmap` enables differential downloads, but the first update usually falls back to a full download.

## How are the installers built?

Pushing a `v*` tag runs [`.github/workflows/release.yml`](https://github.com/yilecoding/fastapi-react-admin/blob/main/.github/workflows/release.yml). A `prepare` job checks that the tag matches both `apps/web/package.json` and the backend's `__version__`, then creates **one** draft release. A matrix then builds on `windows-latest`, `macos-latest` and `ubuntu-latest`, each platform on its own OS. electron-builder runs with `--publish never` and `gh release upload` attaches the files, because electron-builder's own publisher once raced into two drafts. A person tests the draft before publishing it.

Locally: `pnpm --filter web build`, then `pnpm --filter @admin/desktop package`. The desktop build does not rebuild the web app, so skipping the first step packages a stale UI without any error. For development, run the web dev server on :8888 and then `pnpm desktop:dev`.

## What is the mobile app?

`apps/mobile` uses Expo SDK 57, React Native 0.86 and Expo Router, styled with uniwind (Tailwind CSS v4 for React Native) and `react-native-reusables` components. It targets Android and iOS only.

- **Native screens, not a WebView.** Tabs for Home, Apps and Me, plus notifications, profile and password, settings, a users list → detail → delete flow written as the pattern to copy, and notice detail with attachments. Lists use `FlatList` with infinite queries. Notice bodies (HTML from the web's Tiptap editor) are turned into native components through an allow-list, not rendered in a WebView.
- **Shared with web:** `@admin/api` (envelope handling, single-flight 401 refresh, request types inferred from the generated `schema.d.ts`) and `@admin/i18n`. It does not depend on `@admin/platform`, which is web-shaped.
- **Sign-in:** password or SMS code, both behind the image captcha; accounts with two-factor enter their code as a second step (someone required to enrol but not yet enrolled must do it on the web first). The access token is stored in `expo-secure-store` (Keystore / Keychain), never `AsyncStorage`. The refresh token stays in the httpOnly cookie; on Android, React Native's cookie jar sends it back automatically and keeps it across cold starts.
- **Server address is set in the app** and stored on the device. Before saving, the app probes `/auth/captcha` to confirm the address is a reachable backend. The same `oklch()` colour tokens as the web app render pixel-identical on Android.

## What doesn't the mobile app do yet?

- Verified by hand on Android only (sign-in → permission gating → paging → detail → delete confirmation → toast). Newer screens, such as SMS sign-in and notice attachments, have so far passed only `tsc`, ESLint and the bundle build. **iOS has never been run.**
- There are no automated mobile tests. The CI gate is `pnpm build`, which includes `expo export --platform android` and catches bundle-time failures only.
- No real-time updates (no socket.io; screens refresh on open and pull-to-refresh). System push, QR scanning and silent printing are out of scope.
- No published APK. `pnpm --filter @admin/mobile apk` has only been run as far as native module compilation, and it signs with the template's debug keystore; generate your own keystore before shipping.
- Changing the email address needs an email verification code, which only the web has; in the app the email is read-only. A phone number can be bound in the app's profile with an SMS code.

To run it: `pnpm --filter api dev:host` (backend on `0.0.0.0:8088`), then `pnpm mobile:dev`, and open the printed `exp://…:8800` address in Expo Go for SDK 57.

## Where it lives in the code

- [`apps/desktop/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/desktop): `src/main/` (window, `app://` protocol, `print.ts`, `updater.ts`, `auth.ts`, `devices/`), `electron-builder.yml`
- [`packages/platform/src/desktop/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/packages/platform/src/desktop): bridge contract, `isDesktop()` / `desktop()`, label template
- [`apps/desktop/AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/desktop/AGENTS.md): packaging, signing and update pitfalls found in real builds
- [`apps/mobile/`](https://github.com/yilecoding/fastapi-react-admin/tree/main/apps/mobile): `src/app/` (screens), `src/lib/` (session, API, permissions), and [`AGENTS.md`](https://github.com/yilecoding/fastapi-react-admin/blob/main/apps/mobile/AGENTS.md)

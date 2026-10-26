# mindlessRepetition

[English](README.md) · [简体中文](README.zh-CN.md)

> This browser extension uses AI to parse conversation instructions, identify page elements, and automatically execute a series of operations on web pages.
> Instead of manually recording fixed steps, you can tell the AI what you want to do in plain language. It analyzes the current page, locates buttons and input boxes, and completes clicking, filling, querying and other interactive tasks automatically.
> It is designed to eliminate tedious repetitive web operations and improve your daily workflow efficiency.

## Download

| Where | What you get |
| --- | --- |
| [Latest release](https://github.com/Lodi-elize/mindlessRetition/releases/latest) | Newest `mindRepetition-<version>.zip` under **Assets** |
| [All releases](https://github.com/Lodi-elize/mindlessRetition/releases) | Every published version |
| [`release` branch](https://github.com/Lodi-elize/mindlessRetition/tree/release) | Archive: `release/v<version>/mindRepetition-<version>.zip` for every tag |

To grab the whole archive without visiting the Releases page:

```shell
$ git clone --branch release --single-branch https://github.com/Lodi-elize/mindlessRetition.git
```

### Installing a downloaded package

1. Unzip the archive.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped folder.

## Features

- Turn natural-language instructions into concrete page actions with an AI model
- Locate target elements on the current page, including content rendered inside iframes
- Automatically click, fill, query and chain multiple steps
- Pick and annotate elements to give the AI precise context
- Run everything from the Chrome side panel

## Requirements

- Node.js >= 14
- Chrome (Manifest V3)

## Building from source

1. Check that your `Node.js` version is >= **14**.
2. Change or configure the extension name in [`src/manifest.ts`](src/manifest.ts).
3. Run `npm install` (or `yarn`) to install the dependencies.

## Developing

```shell
$ npm run dev
```

### Chrome Extension Developer Mode

1. Enable **Developer mode** in your Chrome browser.
2. Click **Load unpacked** and select the `build` folder.

### Reloading the extension (important)

`build/` is the folder that "Load unpacked" points to. After every `npm run build` (or a fresh output from `npm run dev`), Chrome keeps using the old files, so you must:

1. Open `chrome://extensions` and click **Reload** on the mindRepetition card.
2. Refresh the target web page once (already-open tabs do not pick up the new content script automatically).

If the side panel reports that it cannot connect to the content script, do the two steps above first. Pages such as `chrome://`, extension pages and the Chrome Web Store do not allow script injection at all.

Note: both `npm run dev` and `npm run build` write to `build/`, but the output differs (the dev build depends on the running Vite server). Keep the dev process running while developing; for a stable build that does not depend on the dev server, stop dev first, then run `npm run build` and reload the extension.

### Plain frontend debugging

1. Open `http://localhost:5173/`
2. To debug the popup page, open `http://localhost:5173/popup.html`
3. To debug the options page, open `http://localhost:5173/options.html`

## Project structure

```
src/
├─ background/      # background service worker
├─ contentScript/   # page automation, element picker, annotations
├─ sidepanel/       # side panel UI, AI client and workflow
├─ popup/           # toolbar popup
├─ options/         # options page
├─ devtools/        # devtools panel
├─ newtab/          # new tab page
└─ shared/          # shared types and step helpers
```

## Releasing

Releases are built and published automatically by GitHub Actions ([`.github/workflows/release.yml`](.github/workflows/release.yml)) whenever a `v*.*.*` tag is pushed:

1. Bump `version` in [`package.json`](package.json) — the extension manifest reads it from there — and update [`CHANGELOG.md`](CHANGELOG.md).
2. Commit the changes and push them to `main`.
3. Create and push a matching tag:

```shell
$ git tag v0.1.0
$ git push origin v0.1.0
```

The workflow checks that the tag matches `package.json`, builds the extension, packages it as `package/<name>-<version>.zip`, and creates a GitHub Release with the zip attached.

Every package is also archived on the `release` branch under `release/v<version>/`, so older builds can be fetched without going through the Releases page. That branch is orphaned — it shares no history with `main` — so build artifacts never bloat `main` or its clones:

```shell
$ git clone --branch release --single-branch https://github.com/Lodi-elize/mindlessRetition.git
```

To release manually instead, run `npm run zip` and upload `package/*.zip` to a Release created in the GitHub UI.

## Packing

After the development of your extension run the command

```shell
$ npm run build
```

Now, the content of `build` folder will be the extension ready to be submitted to the Chrome Web Store. Just take a look at the [official guide](https://developer.chrome.com/webstore/publish) for more info about publishing.

---

Generated by [create-chrome-ext](https://github.com/guocaoyi/create-chrome-ext)

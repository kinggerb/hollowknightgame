# Running this port on an iPad (or iPhone / Android)

`ipad.html` is a rewritten front-end that fixes the reason the old page killed
Safari on iPad. `index.html`, `hk.html` and `hollow knight.html` now just forward
to it; the previous versions are kept untouched in `legacy/`.

---

## 1. Why it crashed before

The game is shipped as 47 chunk files:

| file | parts | size |
| --- | --- | --- |
| `Build/hktruffled.data.part1..45` | 45 | 884 MB (926,889,798 bytes) |
| `Build/hktruffled.wasm.part1..2` | 2 | 28.9 MB (30,257,265 bytes) |

The old pages built the game data **in RAM**:

```js
// old approach (index.html / hollow knight.html)
45 part fetches -> new Blob(chunks)        // ~884 MB
fetch(blobUrl) -> .blob()  (again)         // ~884 MB
new Blob([...45 blobs])                    // ~884 MB
Unity downloads dataUrl into a Uint8Array  // ~884 MB
                                           // + wasm copy + node heap
```

That is roughly **3.5–4 GB of peak memory**, and it lands exactly when the
progress bar reaches ~100 %. iOS gives a Safari tab far less than that, so the
WebContent process was jetsam-killed a few seconds after "loading 900 MB";
the tab simply disappears.

## 2. What the new page does instead

1. **Streams every chunk straight to disk** – `hk-stream.js` + `hk-writer.js`
   write the parts into the Origin Private File System (OPFS) through a worker
   using `FileSystemSyncAccessHandle`. Peak RAM during the download: a few MB.
2. **Keeps the merged file** – later loads (and retries after a crash) skip the
   download completely. Incomplete downloads resume from the byte they reached.
3. **Hands Unity one file-backed blob URL** – the ~884 MB ArrayBuffer Unity must
   allocate is then the only big allocation left in the tab, instead of the
   fourth copy of it.
4. **iPad-specific behaviour** – viewport/zoom/gesture handling, wake lock while
   loading, audio unlock on the first tap, synthetic keyboard input for the
   touch pad, an FPS chip, a diagnostics panel, save export/import, and a
   "compatibility mode" switch (adds a stencil buffer) if graphics look wrong.

A crash watchdog also records the stage that was running, so the next visit
tells you where the previous attempt died ("download 78 %", "unity memory 40 %").

## 3. How to open it

| Where | URL |
| --- | --- |
| GitHub Pages (this repo) | `https://kinggerb.github.io/hollowknightgame/ipad.html` |
| GitHub Pages root | `https://kinggerb.github.io/hollowknightgame/` (redirects) |
| jsDelivr | `https://cdn.jsdelivr.net/gh/kinggerb/hollowknightgame@main/ipad.html` |
| Locally, from the repo | `node tools/serve.mjs 8080` then `http://<your-computer-ip>:8080/ipad.html` |

The page, `hk-stream.js`, `hk-writer.js`, `Build/` and `StreamingAssets/` must be
served from the **same origin** (that is the case for every option above). If
you host the HTML somewhere else, add `?base=https://…/` to point at the asset
folder.

On the iPad: open the URL in Safari → tap **Start** → keep the tab in the
foreground until the game appears. Optionally use *Share ▸ Add to Home Screen*
first: as a home-screen web app Safari does not evict the site's storage after
7 days and gives the page more headroom.

## 4. What to expect

* **First run** – ~884 MB + ~29 MB download (a few minutes on wifi), written to
  disk as it arrives. Then Unity copies the data into memory ("Loading into
  memory — x %"). That last phase is the memory-hungry one; keep the tab in the
  foreground and do not switch apps.
* **Every run after that** – no download at all: the data is read back from disk
  in a few seconds.
* **Storage** – the cached data lives in the origin's private file system
  (roughly 913 MB, plus saves). `Menu ▸ Clear cached game data` deletes it.
  Safari clears such data after 7 days without a visit unless the site is
  installed on the home screen, so the first load after a long break may
  download again.

## 5. Touch controls

The on-screen pad appears on touch devices (toggle it in the menu). It sends the
default Hollow Knight keyboard bindings, which is what the WebGL build expects:

| Button | Key |
| --- | --- |
| D-pad | Arrow keys (move / look up & down) |
| Jump | `Z` |
| Attack | `X` |
| Dash | `C` |
| Focus / cast (hold) | `A` |
| Dream Nail (hold) | `D` |
| Quick cast | `E` |
| Map | `Tab` |
| Pause / inventory | `Escape` |
| Super dash (hold) | `S` |

A Bluetooth gamepad or keyboard connected to the iPad also works.

## 6. Troubleshooting

| Symptom | What to try |
| --- | --- |
| Tab disappears during "Loading into memory" | Close other tabs, retry – the game data is cached, so the retry skips the download. Lower **Render quality** in the menu. |
| Black screen after the loading bar | Reload; check the log panel. Try **Compatibility mode** (turns the stencil buffer on) if graphics look wrong. |
| "There is not enough free storage" | Free ~2 GB in *Settings ▸ General ▸ iPad Storage*; the merged file needs ~913 MB. |
| No sound | Tap the screen once after the game starts (iOS requires a gesture). |
| Downloads keep restarting | Leave the tab in the foreground; the loader resumes from the last byte written. |
| Everything is slow | Render quality 70 % or 55 % in the menu, close other apps. |

The **Menu** button (top right) shows storage/capability details and a log;
"Copy diagnostics" puts it on the clipboard if you want to report a problem.

## 7. Working on it

```bash
node tools/test-hk-stream.mjs          # full: assembles the real 884 MB file
                                       # and checks it byte-for-byte (sha256)
node tools/test-hk-stream.mjs --quick   # same suite with only the wasm chunks
node tools/serve.mjs 8080               # static server with Range + wasm MIME
```

The test suite covers: byte-exact assembly, OPFS cache reuse (zero network
requests), resume after an interrupted download, retries after broken parts,
the RAM fallback, the worker message protocol, and that the part list in
`ipad.html` still matches the files in `Build/`.

### Files added

| File | Purpose |
| --- | --- |
| `ipad.html` | The game page (UI, Unity config, touch pad, saves, diagnostics) |
| `hk-stream.js` | Chunk → OPFS pipeline with resume/caching |
| `hk-writer.js` | Worker that owns the OPFS sync access handle |
| `tools/test-hk-stream.mjs` | Node test suite for the above |
| `tools/serve.mjs` | Local static server (Range requests, correct MIME) |
| `IPAD.md` | This document |

### What is still a limit of the build itself

Unity still has to hold the ~884 MB data blob plus its own WebAssembly heap
(32 MB at start, up to 2 GB as the game allocates) inside one tab. On an iPad
that is a large but plausible footprint on iPadOS 18.2+ (the WebKit
WebAssembly-memory bug that broke big builds was fixed there); a 4 GB iPad will
still struggle. Making the game run comfortably on every iPad would require
rebuilding the Unity project with a smaller heap / streamed asset bundles,
which cannot be done from these files alone.

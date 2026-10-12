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
* **Graphics** – iPads start at **Balanced** (85 % render scale, 60 fps cap);
  see [§5](#5-graphics--performance) for the levels and what to do when the tab
  still dies mid-game.
* **Storage** – the cached data lives in the origin's private file system
  (roughly 913 MB, plus saves). `Menu ▸ Clear cached game data` deletes it.
  Safari clears such data after 7 days without a visit unless the site is
  installed on the home screen, so the first load after a long break may
  download again.

## 5. Graphics & performance

### What can and cannot be changed

The game is a finished **Unity 2021.3 build**: a compiled wasm module plus 884 MB
of data. Shaders, lights, particles and post effects live inside that blob, so
they cannot be switched off from the web page — doing that would need the Unity
project and a rebuild.

What the page *can* change is how much work the browser asks for, which is the
other half of the story: the reason the tab dies is that iPadOS jetsam-kills
processes that hold too much memory, and the biggest thing a running game holds
that the page controls is **how many pixels it draws, and how often**.

### The four controls (Menu ▸ Graphics & performance)

| Button | Cycles through |
| --- | --- |
| **Graphics** | High → Balanced → Smooth → Low → Potato → Minimum → Rock bottom (sets render scale *and* frame cap) |
| **Frame cap** | off, 60, 45, 30, 24, 20 fps |
| **Render scale** | 100 %, 85 %, 70 %, 55 %, 40 %, 30 %, 25 % of the screen's pixels |
| **Auto-degrade** | on / off |

| Preset | Render scale | Frame cap | Pixels drawn vs. High |
| --- | --- | --- | --- |
| High | 100 % | 60 | 100 % |
| Balanced | 85 % | 60 | 72 % |
| Smooth | 70 % | 45 | 49 % |
| Low | 55 % | 30 | 30 % |
| Potato | 40 % | 30 | 16 % |
| Minimum | 30 % | 30 | 9 % |
| Rock bottom | 25 % | 24 | 6 % |

Touch devices start at **Balanced**; desktop starts at High. A lower render
scale draws fewer pixels and the canvas is stretched back over the screen, so
the picture gets softer but the GPU work, the video memory and the heat all
drop with it. The two lowest levels are ugly on purpose: they exist for
iPads that still die at Potato, where drawing a sixteenth of the pixels is
the difference between a session that survives and one that does not.

One-off overrides are handy for finding out what a device can take:

```
ipad.html?preset=low      ipad.html?fps=30      ipad.html?scale=0.5
```

### What the page does by itself

* **Frame cap.** Unity drives itself from `requestAnimationFrame`, so the page
  wraps rAF and releases the game loop on the first display refresh at or after
  the target time. That matters more than it sounds: on a 120 Hz iPad an
  *uncapped* game tries to draw 120 frames a second — twice the GPU and CPU
  work of 60 fps for no visible gain.
* **Auto-degrade.** If the measured frame rate stays under 80 % of the cap for
  three seconds running, the page drops one level and says so in a toast. It
  never raises the level by itself, and picking a level yourself clears the
  counter. Below Rock bottom there is still room: the frame cap goes 24 → 20
  fps and the render scale keeps shrinking in steps of 10 % down to 25 %.
* **Crash memory.** While the game runs it writes a heartbeat to
  `localStorage` every four seconds; leaving the page normally deletes it. A
  heartbeat that is still there on the next visit means the tab was killed, so
  **the next session starts one graphics step lower** instead of dying the same
  way again — two crashes in a row start two steps lower. A tab killed while it
  was *in the background* is ignored: iPadOS does that to every tab eventually
  and it says nothing about the graphics level. The streak is only cleared by
  a *clean exit of a running game*: Safari reloads a page it killed, and that
  fresh start must not wipe the counter before the ladder has climbed.
* **Memory warning, learned from the crash.** When the game's wasm heap passes
  the warning level the page says so once. The heap is allowed to grow to 2 GB,
  but iPadOS kills a tab long before that, and where *this* iPad's line is can
  only be measured: after a crash the page remembers the heap size it died at
  and warns at 80 % of it (and alarms at 95 %) from then on. With nothing
  learned yet it warns at 1000 MB and alarms at 1400 MB. A restart from a bench
  is cheaper than a kill.
* **Audio guard.** On iPadOS Safari `HTMLMediaElement.play()` sometimes rejects
  with `NotSupportedError` instead of the `NotAllowedError` every other browser
  reports. Unity only handles `NotAllowedError`, rethrows everything else, and
  the rejection reaches the loader's `unhandledrejection` handler — which stops
  the game mid-run, sometimes an hour in. The page relabels the error as
  `NotAllowedError` so Unity takes its own retry path, swallows a rejected
  `AudioContext.resume()`, and plays a 0.1 s clip of generated silence inside
  the first real tap so iOS unlocks media at all. An element that fails eight
  times in a row is left alone instead of being re-queued on every tap.
* **Recovery overlay.** If Safari drops the WebGL context, or the game stops
  drawing for 25 seconds, an overlay offers a reload instead of leaving a
  frozen canvas.
* **Cheaper GL context.** No antialiasing, no alpha, no stencil (unless
  compatibility mode is on), no low-latency presentation, and `low-power` on
  touch devices.

### If it still crashes mid-game

1. Work down the presets — **Low**, then **Potato**, and if it still dies,
   **Minimum** and **Rock bottom**. Rock bottom draws a sixteenth of the pixels
   of High.
2. Close other tabs and apps. What matters is the budget of *this* tab, not the
   free space on the device.
3. Add the page to the home screen (*Share ▸ Add to Home Screen*): as a
   home-screen app Safari gives it more headroom and does not evict its
   storage after seven days.
4. Rest at a bench and reload every hour or so. The heap only grows during a
   session.
5. The **Menu ▸ Stability** rows show the internal resolution, the measured
   frame rate, the wasm heap size, the tab total (heap + the 884 MB of game
   data), the heap size the tab last died at, and what happened on the last
   session — those numbers are what to quote when asking for help.

A 4 GB iPad is genuinely tight for this build: the game data alone is 884 MB of
the tab's memory before anything is rendered.

## 6. Touch controls

The on-screen pad appears on touch devices (toggle it in the menu). Using a
physical keyboard, mouse, or gamepad hides the pad so it does not cover the game;
touchscreen taps do not hide it. Press **Esc** or long-press the screen to bring
an auto-hidden pad back. Keyboard and touch-pad holds are combined, so releasing
one input source cannot release a key that the other source is still holding.
The pad sends the default Hollow Knight keyboard bindings, which is what the
WebGL build expects:

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

## 7. Save editors (.dat / .dat.html)

Saves live in the game's native format (`user1.dat` … `user4.dat`), so online
editors such as [hollowedit.com](https://hollowedit.com/) work with them:

1. **Export** — Menu ▸ *Export .dat slot* downloads `userN.dat`.
2. **Edit** — load that file in the editor. iPad Safari renames editor
   downloads to `userN.dat.html` (it appends the extension of the MIME type the
   editor serves); that file is used as-is in the next step.
3. **Import** — Menu ▸ *Import save* accepts the `.dat.html` (or `.dat`), the
   page's own `hk-save.json` export, and even plain/base64 save text from other
   editors. The file picker deliberately has no type filter (iPadOS greys out
   every file when the list contains extensions it cannot map, like
   `.dat.html`); instead the importer validates the save — it must decrypt to
   real save JSON before anything is written. It goes to the slot that matches
   the file name (`user3.dat.html` → slot 3, otherwise slot 1) and leaves other
   slots alone. Reload the page afterwards.

## 8. Troubleshooting

| Symptom | What to try |
| --- | --- |
| `NotSupportedError` / `jsAudioPlayPendingBlockedAudio` in the log, or the game stops with sound queued | iOS refused `play()`. The page relabels that as `NotAllowedError` so Unity retries it instead of dying (§5, *Audio guard*). If the log still shows it, tap the screen once, and check that the iPad is not muted / on a locked orientation with the ringer switch on. Reload if the game stopped anyway. |
| The tab simply vanishes — no error, no overlay, Safari reloads the page | That is iPadOS jetsam, not a JavaScript error: it looks like a fresh load with a "last session stopped unexpectedly" toast. Work down to **Minimum** / **Rock bottom** (§5), close other tabs and apps, and use the home-screen shortcut. The **Stability** rows quote the heap it died at. |
| Tab disappears at random while playing | Set **Graphics** to Low, Potato, then Rock bottom (Menu ▸ Graphics & performance). The next start begins a step lower on its own after each crash. Close other tabs and apps. |
| Tab disappears during "Loading into memory" | Close other tabs, retry – the game data is cached, so the retry skips the download. Lower **Render scale** in the menu. |
| Frozen picture, or a black canvas after the game was running | If the recovery overlay does not appear within ~30 s, reload. It is triggered by a lost WebGL context or 25 s without a frame. |
| Black screen after the loading bar | Reload; check the log panel. Try **Compatibility mode** (turns the stencil buffer on) if graphics look wrong. |
| "There is not enough free storage" | Free ~2 GB in *Settings ▸ General ▸ iPad Storage*; the merged file needs ~913 MB. |
| No sound | Tap the screen once after the game starts (iOS requires a gesture). |
| Downloads keep restarting | Leave the tab in the foreground; the loader resumes from the last byte written. |
| Everything is slow | **Graphics** → Smooth or Low. Auto-degrade does this on its own when the frame rate stays low. |
| The picture is soft or blurry | That is the render scale doing its job — raise **Graphics** a step if the frame rate allows. |

The **Menu** button (top right) shows the graphics and stability rows (internal
resolution, frame rate, game memory, last session), storage/capability details
and a log; "Copy diagnostics" puts it on the clipboard if you want to report a
problem.

## 9. Working on it

```bash
node tools/test-hk-stream.mjs          # full: assembles the real 884 MB file
                                       # and checks it byte-for-byte (sha256)
node tools/test-hk-stream.mjs --quick   # same suite with only the wasm chunks
node tools/test-ipad-page.mjs           # DOM tests for pad auto-hide / key ownership
                                       # and the graphics / crash-recovery logic
node tools/test-save-import.mjs         # save codec + .dat.html import/export tests
node tools/serve.mjs 8080               # static server with Range + wasm MIME
```

The streaming test suite covers: byte-exact assembly, OPFS cache reuse (zero
network requests), resume after an interrupted download, retries after broken
parts, the RAM fallback, the worker message protocol, and that the part list in
`ipad.html` still matches the files in `Build/`. The iPad page suite checks
physical-input auto-hide, touch taps, Esc / long-press restore, gamepad input,
and keyboard/touch key ownership — plus the graphics controls: render scale vs.
canvas size, the frame limiter (capped frames are spaced out, uncapped ones are
not), preset cycling and persistence, auto-degrade, crash detection from a stale
heartbeat (and that a background kill does not count), a clean exit clearing the
heartbeat, the crash ladder walking down to Rock bottom, the heap warning and
the lost-context overlay — and the audio guard (a `play()` that rejects or
throws is relabelled as `NotAllowedError` instead of killing the game). The save
import suite
checks the AES save codec against reference vectors and the `.dat.html`
import/export flow in jsdom.

### Files added

| File | Purpose |
| --- | --- |
| `ipad.html` | The game page (UI, Unity config, touch pad, saves, diagnostics) |
| `hk-stream.js` | Chunk → OPFS pipeline with resume/caching |
| `hk-writer.js` | Worker that owns the OPFS sync access handle |
| `hk-save-codec.js` | Save-file codec: reads/writes native `userN.dat` containers |
| `tools/test-hk-stream.mjs` | Node test suite for the streaming loader |
| `tools/test-ipad-page.mjs` | DOM tests for the touch pad and input handling |
| `tools/test-save-import.mjs` | Node test suite for the save codec + import/export |
| `tools/fixtures/` | Reference save files/vectors for the codec tests |
| `tools/serve.mjs` | Local static server (Range requests, correct MIME) |
| `IPAD.md` | This document |

### What is still a limit of the build itself

Unity still has to hold the ~884 MB data blob plus its own WebAssembly heap
(32 MB at start, up to 2 GB as the game allocates) inside one tab. On an iPad
that is a large but plausible footprint on iPadOS 18.2+ (the WebKit
WebAssembly-memory bug that broke big builds was fixed there); a 4 GB iPad will
still struggle.

The page works with what a finished build leaves on the outside — pixels, frame
rate, GPU context flags and recovery — so the levels in §5 are the whole of the
"graphics settings" that exist here. Turning off shaders, lights or particle
effects, or shipping smaller textures, means rebuilding the Unity project (a
smaller heap, streamed asset bundles, `masterTextureLimit`), which cannot be
done from these files alone.

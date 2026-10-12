# Running this port on an iPad (or iPhone / Android)

`ipad.html` is a rewritten front-end that fixes the reason the old page killed
Safari on iPad. `index.html`, `hk.html` and `hollow knight.html` now just forward
to it; the previous versions are kept untouched in `legacy/`.

---

## 1. Why it crashed before

The game is shipped as 47 chunk files:

| file | parts | size |
| --- | --- | --- |
| `Build/hktruffled.data.part1..32` | 32 | 659 MB (659,321,108 bytes; was 45 parts / 926,889,798 bytes before the cutscene videos were replaced with placeholders, see §5) |
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
3. **Hands Unity one file-backed blob URL** – the ~659 MB ArrayBuffer Unity must
   allocate is then the only big allocation left in the tab, instead of the
   fourth copy of it.
4. **iPad-specific behaviour** – viewport/zoom/gesture handling, wake lock while
   loading, an audio guard plus audio unlock on the first tap (see
   [§5](#5-graphics--performance)), synthetic keyboard input for the touch pad,
   an FPS chip, a diagnostics panel, save export/import, and a "compatibility
   mode" switch (adds a stencil buffer) if graphics look wrong.

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

* **First run** – ~659 MB + ~29 MB download (a few minutes on wifi), written to
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

### Cutscene videos replaced with placeholders

The shipped data no longer contains the cutscene videos. The original archive
had 236 entries; 229 of them were `sharedassets*.resource` files holding MP4 or
WebM video (267,760,363 bytes, about 263 MiB), and they made up one contiguous
run between the game data and the metadata. Each video entry was replaced with
the same tiny placeholder: a valid 2×2 black MP4 of 837 bytes, starting with an
`ftyp` box.

| | before | after |
| --- | --- | --- |
| cutscene video (229 entries) | 267,760,363 bytes | 229 × 837 bytes (191,673 bytes) |
| `hktruffled.data` total | 926,889,798 bytes (45 parts) | 659,321,108 bytes (32 parts) |

The index was kept as it is, with the sizes and offsets of the replaced entries
and of the metadata after them updated, so the Unity runtime still finds every
file it asks for. The game runs without its cutscenes; the videos play as
black frames.

### What can and cannot be changed

The game is a finished **Unity 2021.3 build**: a compiled wasm module plus 659 MB
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
drop with it.

**Minimum** and **Rock bottom** exist for the bad days: a 4 GB iPad with a few
other tabs open, or a session that has been running long enough for the heap to
grow. They draw 9 % and 6 % of the pixels of High — blocky, but still playable
— and they are where auto-degrade ends up when nothing else has helped.

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
  counter. Once **Rock bottom** is reached there are no levels left, so it keeps
  going on the two dials that are still free: the frame cap steps 24 → 20, and
  only then does the render scale come down in steps of 10 %, stopping at 25 %.
* **Crash memory.** While the game runs it writes a heartbeat to
  `localStorage` every four seconds; leaving the page normally deletes it. A
  heartbeat that is still there on the next visit means the tab was killed, so
  **the next session starts one graphics step lower** instead of dying the same
  way again — two crashes in a row start two steps lower, and so on down to
  Rock bottom. A tab killed while it was *in the background* is ignored:
  iPadOS does that to every tab eventually and it says nothing about the
  graphics level. The streak is only cleared by a page that really got the game
  running, because Safari reloads the page by itself after a kill and that
  fresh start used to wipe the streak before the ladder had climbed.
* **Hard memory cap (1.4 GB) & periodic cleanup.** Instead of showing repeated
  memory warning pop-ups, the heartbeat monitors `hb.heap` and triggers a clean
  reload after a 5-second corner countdown (`Memory limit reached — reloading…`)
  if the wasm heap exceeds 1400 MB (1.4 GB), preventing iPadOS jetsam kills.
  Every 60 seconds of gameplay the page also calls `Module.asm._gc_collect()`
  and `Module.asm._ResourceManager_UnloadUnusedAssets()` if present, and lower
  graphics presets call `Module.asm._QualitySettings_SetTextureSize()` when
  exported. **Menu ▸ Graphics & performance** still shows the heap, the tab
  total and what the last crash cost, and once the heap passes 1000 MB the fps
  chip in the corner shows it in GB so you can see it climbing without opening
  the menu.
* **Audio guard.** Unity calls `play()` on every sound it starts, and iPad
  Safari refuses most of those until you have touched the screen. The refusal
  can come back as `NotSupportedError` (Unity's log calls it
  `jsAudioPlayPendingBlockedAudio`), which Unity does not recognise — it
  rethrows, the rejection goes unhandled, and the loader kills the game
  mid-run. The page patches `HTMLMediaElement.prototype.play` so any refusal
  other than `NotAllowedError` is relabelled as one, which sends Unity down its
  own wait-for-a-gesture path instead. A `play()` that throws outright is
  caught the same way, `AudioContext.resume()` can no longer produce an
  unhandled rejection, and after eight failures in a row the guard stops
  rejecting at all so a dead element is not re-queued on every tap. On the
  first real gesture the page also plays a tenth of a second of silence from a
  WAV it builds in memory (8 kHz, 8-bit, mono, no network request), which is
  what unlocks media for the rest of the session.
* **Recovery overlay.** If Safari drops the WebGL context, or the game stops
  drawing for 25 seconds, an overlay offers a reload instead of leaving a
  frozen canvas.
* **Cheaper GL context.** No antialiasing, no alpha, no stencil (unless
  compatibility mode is on), no low-latency presentation, and `low-power` on
  touch devices.

### If it still crashes mid-game

1. Work down the presets — **Low**, then **Potato**, then **Minimum** and
   **Rock bottom**. Rock bottom draws 6 % of the pixels of High, which is the
   last thing the page can give up.
2. Close other tabs and apps. What matters is the budget of *this* tab, not the
   free space on the device.
3. Add the page to the home screen (*Share ▸ Add to Home Screen*): as a
   home-screen app Safari gives it more headroom and does not evict its
   storage after seven days.
4. Rest at a bench and reload every hour or so. The heap only grows during a
   session.
5. The **Menu ▸ Stability** rows show the internal resolution, the measured
   frame rate, the wasm heap size, the tab total (heap + game data), what the
   last crash cost and what happened on the last session — those numbers are
   what to quote when asking for help.

A 4 GB iPad is genuinely tight for this build: the game data alone is 659 MB of
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
| Tab disappears at random while playing | Set **Graphics** to Low, then Potato, then Minimum or Rock bottom (Menu ▸ Graphics & performance). The next start begins a step lower on its own after each crash. Close other tabs and apps. |
| The tab simply vanishes — no message, no overlay, no chance to save | That is iPadOS killing the tab for memory (jetsam), which happens too fast for the page to draw anything. The next start begins a step lower by itself; **Menu ▸ Stability** then shows *last crash at* with the heap size it died at, so you can see how close to the ceiling the session got. Work down to Minimum or Rock bottom and reload at a bench before the heap grows. |
| `jsAudioPlayPendingBlockedAudio` or `NotSupportedError` in the log | iOS refusing to start a sound before you have touched the screen. The audio guard turns it into the `NotAllowedError` that Unity knows how to wait out, so it should not stop the game — tap the screen once and the sound should come in. If the tab dies at that exact moment, use **Menu ▸ Copy diagnostics** and report it. |
| Tab disappears during "Loading into memory" | Close other tabs, retry – the game data is cached, so the retry skips the download. Lower **Render scale** in the menu. |
| Frozen picture, or a black canvas after the game was running | If the recovery overlay does not appear within ~30 s, reload. It is triggered by a lost WebGL context or 25 s without a frame. |
| Black screen after the loading bar | Reload; check the log panel. Try **Compatibility mode** (turns the stencil buffer on) if graphics look wrong. |
| "There is not enough free storage" | Free ~2 GB in *Settings ▸ General ▸ iPad Storage*; the merged file needs ~913 MB. |
| No sound | Tap the screen once after the game starts — iOS needs a gesture, and the page primes media playback on that first tap. If it is still silent, check the log for `audio guard` lines. |
| Downloads keep restarting | Leave the tab in the foreground; the loader resumes from the last byte written. |
| Everything is slow | **Graphics** → Smooth or Low. Auto-degrade does this on its own when the frame rate stays low. |
| The picture is soft or blurry | That is the render scale doing its job — raise **Graphics** a step if the frame rate allows. |

The **Menu** button (top right) shows the graphics and stability rows (internal
resolution, frame rate, game memory, tab total, last crash, last session),
storage/capability details and a log; "Copy diagnostics" puts it on the
clipboard if you want to report a problem.

## 9. Working on it

```bash
node tools/test-hk-stream.mjs          # full: assembles the real 659 MB file
                                       # and checks it byte-for-byte (sha256)
node tools/test-hk-stream.mjs --quick   # same suite with only the wasm chunks
node tools/test-ipad-page.mjs           # DOM tests for pad auto-hide / key ownership,
                                       # the graphics / crash-recovery logic and the
                                       # audio guard
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
not), preset cycling and persistence, auto-degrade (including the whole ladder
down to Rock bottom and the frame-cap steps past it), crash detection from a
stale heartbeat (and that a background kill does not count), that a clean exit
clears the heartbeat only once the game really booted, the heap warning, the
heap a crash died at being remembered and driving the next session's limits,
the canvas really shrinking at the two lowest levels, the lost-context overlay,
and the audio guard relabelling a `play()` that rejects *or throws* with
something Unity would otherwise rethrow. The save import suite
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

Unity still has to hold the ~659 MB data blob plus its own WebAssembly heap
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

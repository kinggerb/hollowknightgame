# Hollow Knight — web port

Play: **https://kinggerb.github.io/hollowknightgame/**

`ipad.html` is the current page (it works on desktop too). It streams the
`Build/` chunks to on-device storage instead of gluing them together in RAM,
which is what used to make iPad Safari kill the tab at ~100 % of the loading
bar. See **[IPAD.md](IPAD.md)** for the full explanation, iPad instructions,
touch controls and troubleshooting.

* `ipad.html` — the game page (works on iPad, iPhone, desktop)
* `index.html`, `hk.html`, `hollow knight.html` — forward to `ipad.html`
* `legacy/` — the previous versions, unchanged
* `hk-stream.js`, `hk-writer.js` — chunk loader: OPFS streaming + caching
* `hk-save-codec.js` — save-file codec: import accepts `.dat`/`.dat.html`
  editor downloads (hollowedit.com etc.), plain JSON or base64 saves

Graphics & stability on iPad — **Menu ▸ Graphics & performance** in the game:
seven levels (High → Rock bottom) that set the render scale and the frame cap at
the same time, auto-degrade when the frame rate stays low, and a session that
gets killed starts the next one a step lower on its own. The build's own shaders
and effects are inside the compiled Unity data and cannot be changed from the
page; see **[IPAD.md §5](IPAD.md#5-graphics--performance)**.
* `tools/serve.mjs` — local server: `node tools/serve.mjs 8080`
* `tools/test-hk-stream.mjs` — test suite: `node tools/test-hk-stream.mjs`
* `tools/test-save-import.mjs` — save import/codec tests: `node tools/test-save-import.mjs`

Notes from the original port:

* dreamers are fixed here
* the cutscenes are preloaded by the legacy pages in case you don't have wifi
* better import and exporting saves (Menu ▸ Export/Import save)

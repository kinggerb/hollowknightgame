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
* `tools/serve.mjs` — local server: `node tools/serve.mjs 8080`
* `tools/test-hk-stream.mjs` — test suite: `node tools/test-hk-stream.mjs`

Notes from the original port:

* dreamers are fixed here
* the cutscenes are preloaded by the legacy pages in case you don't have wifi
* better import and exporting saves (Menu ▸ Export/Import save)

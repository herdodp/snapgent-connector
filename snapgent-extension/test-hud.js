// Guards the in-page status HUD (report 2026-11-18):
//   "background item di bikin transparant aja, di sebelah agent working tambahin
//    icon loading, trus yang card floating yang nembel ada active dsbnya tambahin
//    tombol hide jadi pindah bullet … nanti kalo di klik lagi floatingnya muncul"
//
// Three behaviours are pinned here, all source-level (core/main.js is a browser
// IIFE that needs the chrome.* runtime and a live page):
//   1. the composer cover is TRANSPARENT (the typed text is already invisible,
//      so a painted slab only read as a block dropped over the input),
//   2. the cover carries a live spinner next to "Agent is working…",
//   3. the floating status card can be hidden into a round blue button placed
//      OUTSIDE the text input, and that button brings the card back - with the
//      choice persisted.
// Run: node test-hud.js
const fs = require("fs");

const src = fs.readFileSync(__dirname + "/core/main.js", "utf8");
const css = fs.readFileSync(__dirname + "/overlay.css", "utf8");

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}

// ── 1. The cover surface is transparent ────────────────────────────────────
ok("cover has a transparent CSS surface",
  /#zs-input-cover \{[^}]*background: transparent/.test(css));
ok("cover is never repainted with a matched opaque colour",
  /cover\.style\.background = "transparent"/.test(src) &&
  !/cover\.style\.background = opaqueBg\(/.test(src));

// ── 2. A spinner sits beside "Agent is working…" ───────────────────────────
ok("cover markup includes the spinner before the label",
  /<span class="zs-cover-spin"[^>]*><\/span><span class="zs-cover-main">Agent is working…<\/span>/.test(src));
ok("cover spinner has a rotation animation",
  /#zs-input-cover \.zs-cover-spin \{[^}]*animation: zs-cover-spin/.test(css) &&
  /@keyframes zs-cover-spin \{ to \{ transform: rotate\(360deg\); \} \}/.test(css));

// ── 3. Hide button → round blue button → restore ───────────────────────────
ok("status card has a hide button",
  /<button id="zs-bar-hide"/.test(src) &&
  /#zs-bar-hide \{[^}]*border-radius/.test(css));
ok("collapsed trigger is a round floating blue button",
  /<button id="zs-dot"/.test(src) &&
  /#zs-dot \{[^}]*border-radius: 50%/.test(css) &&
  /#zs-dot \{[^}]*radial-gradient/.test(css));
ok("hide button collapses the card and reveals the dot",
  /hideBtn\.addEventListener\("click"/.test(src) &&
  /hudHidden = true;/.test(src) &&
  /dotBtn\.hidden = !hudHidden/.test(src));
ok("the dot restores the card",
  /dotBtn\.addEventListener\("click"/.test(src) &&
  /hudHidden = false;/.test(src));
ok("the choice is persisted across reloads",
  /const HUD_HIDDEN_KEY = "zsHudHidden"/.test(src) &&
  /chrome\.storage\.local\.set\(\{ \[HUD_HIDDEN_KEY\]: hudHidden \}\)/.test(src) &&
  /chrome\.storage\.local\.get\(HUD_HIDDEN_KEY/.test(src));
ok("collapsed card is skipped by the positioning loop but the loop stays alive",
  /if \(hudHidden\) \{\s*bar\.style\.display = "none";/.test(src) &&
  /placeDot\(\);\s*return;/.test(src));
ok("the dot is placed outside the input, above its right edge",
  /function placeDot\(\)/.test(src) &&
  /dotBtn\.style\.left = Math\.round\(r\.right - 38\) \+ "px"/.test(src) &&
  /dotBtn\.style\.top = Math\.max\(4, Math\.round\(r\.top - 44\)\) \+ "px"/.test(src));

// ── 4. The composer's own placeholder is hidden while the agent works ──────
//       (report 2026-11-18: "place holder Ask Chat Gpt nya bisa di ilangin gak
//        ya kalo agent is working? nanti munculin lagi pas udah selesai")
ok("the cover hides the site's own placeholder via a root class",
  /html\.zs-cover-on \[data-placeholder\]/.test(css) &&
  /html\.zs-cover-on p\.placeholder \{[^}]*visibility: hidden !important/.test(css));
ok("the root class goes on while the cover is intended on",
  /document\.documentElement\.classList\.add\("zs-cover-on"\)/.test(src));
ok("the placeholder comes back when the loop ends",
  (src.match(/document\.documentElement\.classList\.remove\("zs-cover-on"\)/g) || []).length >= 2 &&
  /cover\.dataset\.on = "";[\s\S]{0,320}remove\("zs-cover-on"\)/.test(src));
ok("it also comes back while the cover is scroll-hidden",
  /if \(on && scrollSuppressed\(\)\) \{[\s\S]{0,60}cover\.style\.display = "none";[\s\S]{0,320}remove\("zs-cover-on"\)/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

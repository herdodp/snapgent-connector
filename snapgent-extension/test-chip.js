// Guards the PLACEMENT of the live run status (report 2026-11-18).
//
// Live screenshot from ChatGPT showed a bare "list_dir" chip plus a composer
// cover reading "Agent is working… | path: /tmp · 376ms": the argument summary
// and the elapsed time had ended up on the COVER, and the tool chip itself -
// the place a user looks to see what the agent is running, as Claude's
// "run_command command: bash · 39.0s" does - stayed empty.
//
// These are source-level assertions on purpose: core/main.js is a browser IIFE
// that needs the chrome.* runtime and a live page, so it cannot be evaluated
// here (test-chatgpt.js only stubs the provider surface). Each assertion below
// pins one mechanism that the fix depends on, and fails loudly if it is
// removed or reverted. Run: node test-chip.js
const fs = require("fs");

const src = fs.readFileSync(__dirname + "/core/main.js", "utf8");
const css = fs.readFileSync(__dirname + "/overlay.css", "utf8");

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name); }
}

// ── 1. The run clock lives on the TURN, not the chip ───────────────────────
// Measured live: ChatGPT re-creates the chip subtree on nearly every sweep, so
// a start stamped on the chip was reset every ~250ms and the duration never
// climbed past "268ms". The stamp must survive on the turn element.
ok("run start is stamped on the turn element",
  /item\.dataset\.zrunstart = String\(Date\.now\(\)\)/.test(src));
ok("the chip mirrors the turn's start stamp",
  /chip\.dataset\.zstart = item\.dataset\.zrunstart/.test(src));
ok("the old chip-only stamp (resets on every re-render) is gone",
  !/chip\.dataset\.zstart = String\(Date\.now\(\)\)/.test(src));

// ── 2. Duration is painted at build time, not only on the next tick ────────
ok("chip build writes the elapsed time immediately",
  /if \(phase === "run" && item && item\.dataset\.zrunstart\)/.test(src));

// ── 3. The sweep re-derives the argument summary on repaint ────────────────
// rawVisible/chipGone repaints used to send detail="" and wipe the loop's
// "path: …" line, leaving the bare tool name spinning.
ok("sweep classifies run/idle with a parsed argument summary",
  /if \(!detail && \(phase === "run" \|\| phase === "idle" \|\| phase === "done" \|\| phase === "err"\)\)/.test(src) &&
  /ZSParse\.parseToolCalls\(txt\)/.test(src));
ok("a settled card keeps its argument summary after a reload/repaint",
  /if \(detail && \(phase === "done" \|\| phase === "err"\)\) item\.dataset\.zargs = detail/.test(src));

// ── 4. The ticker never fights the richer meter ────────────────────────────
ok("ticker stands down right after setChipDetail writes",
  /now - \(\+el\.dataset\.zmeter \|\| 0\) < 400/.test(src));
ok("setChipDetail stamps zmeter",
  /chip\.dataset\.zmeter = String\(Date\.now\(\)\)/.test(src));

// ── 5. The cover stays plain ───────────────────────────────────────────────
ok("tool-run branch no longer pushes its detail onto the cover",
  !/ui\.setCoverDetail\(live/.test(src));
ok("command-streaming branch no longer pushes tokens onto the cover",
  !/ui\.setCoverDetail\(`~/.test(src));

// ── 6. Claude-style full-width card + motion (report 2026-11-18) ───────────
// The user compared the two screenshots: Claude renders one full-width card
// ("run_command   command: bash · 39.0s"), Snapgent rendered a 96px pill with
// only the tool name. These pins keep the card full-width and animated.
ok("ChatGPT chip is full width, not a hugging pill",
  /html\.zs-site-chatgpt \.zs-chip \{[^}]*width: 100%/.test(css));
ok("argument summary keeps a readable size on the wide card",
  /html\.zs-site-chatgpt \.zs-chip-dt \{[^}]*font-size: 12px/.test(css));
ok("running chip gets the accent ring spinner",
  /html\.zs-site-chatgpt \.zs-chip\.run \.zs-spin \{[^}]*border-top-color: #eab308/.test(css));
ok("entrance animation is defined and applied once",
  /@keyframes zs-chip-in/.test(css) &&
  /chip\.classList\.add\("zs-chip-enter"\)/.test(src) &&
  /chip\.classList\.remove\("zs-chip-enter"\)/.test(src));
ok("settled icon pops in",
  /@keyframes zs-icon-pop/.test(css) &&
  /\.zs-chip\.done \.zs-chip-ic svg/.test(css));
ok("motion respects prefers-reduced-motion",
  /@media \(prefers-reduced-motion: reduce\)/.test(css));

// ── 7. Settled card keeps args + frozen duration ───────────────────────────
// Claude's finished card still names the command and how long it took. The
// loop passes detail="" on completion, so the summary and total must survive.
ok("run summary is cached for the settled card",
  /if \(detail\) item\.dataset\.zargs = detail/.test(src));
ok("final duration is frozen before the start stamp is dropped",
  /item\.dataset\.zdurfinal = ms < 1000/.test(src));
ok("done/err/idle cards reuse the cached summary and duration",
  /phase === "done" \|\| phase === "err" \|\| phase === "idle"/.test(src) &&
  /item\.dataset\.zargs/.test(src));
ok("recycled turns do not inherit the previous card's args",
  /delete item\.dataset\.zargs/.test(src) && /delete item\.dataset\.zdurfinal/.test(src));

// ── 8. No chips outside a turn; no replayed entrance (report 2026-11-18) ───
// Live DOM dump: a "run" card for list_dir was a DIRECT CHILD of <main>, parked
// at y=5 - i.e. on top of ChatGPT's own chat header, its clock still climbing -
// and three settled cards carried .zs-chip-enter, so the fade-in replayed on
// every sweep and the card visibly blinked.
ok("a chip host must be a turn, never the app shell",
  /function isTurnHost\(el\)/.test(src) &&
  /if \(el\.tagName === "MAIN"\) return false/.test(src) &&
  /el\.querySelectorAll\(sel\)\.length > 2\) return false/.test(src));
ok("chip() refuses to mount on a non-turn host",
  /if \(!isTurnHost\(item\)\) \{/.test(src));
ok("sweep strips chips that escaped their turn",
  /for \(const stray of document\.querySelectorAll\("\.zs-chip"\)\)/.test(src) &&
  /if \(host && !isTurnHost\(host\)\) stray\.remove\(\)/.test(src));
ok("entrance animation is gated by the turn, not by element freshness",
  /const zanim = `\$\{category\}\|\$\{label\}`/.test(src) &&
  /if \(item\.dataset\.zanim !== zanim\)/.test(src) &&
  !/if \(fresh\) \{\s*chip\.classList\.add\("zs-chip-enter"\)/.test(src));
ok("recycled turns drop the animation stamp with the rest",
  /delete item\.dataset\.zanim/.test(src));

// ── 9. Injected result reads as the user's blue bubble ─────────────────────
// The injected feedback arrives AS a user message; a separate dark card in the
// middle of the column read as the assistant talking. Right-align it on the
// bubble surface and cap it to the user bubble width.
ok("result chip is right-aligned and capped to the user bubble width",
  /html\.zs-site-chatgpt \.zs-chip\.result \{[^}]*margin-left: auto/.test(css) &&
  /html\.zs-site-chatgpt \.zs-chip\.result \{[^}]*max-width: min\(100%, var\(--user-chat-width, 72%\)\)/.test(css));
ok("result chip uses the blue bubble surface, light and dark",
  /html\.zs-site-chatgpt \.zs-chip\.result \{[^}]*background: #e8f3fe/.test(css) &&
  /html\.zs-site-chatgpt\[data-theme="dark"\] \.zs-chip\.result[^{]*\{[^}]*background: #173e76/.test(css));

// ── 10. The command card reads in BOTH themes ──────────────────────────────
// Measured dark: #fde68a label on rgba(14,12,6,.92) with the argument summary
// at 55% opacity (#ece6cf) - a smudge on ChatGPT's black canvas - and the same
// amber ink on the light column.
ok("command card has a neutral light surface",
  /html\.zs-site-chatgpt \.zs-chip:not\(\.result\) \{[^}]*background-color: #f7f7f8/.test(css));
ok("command card has a neutral dark surface",
  /html\.zs-site-chatgpt\[data-theme="dark"\] \.zs-chip:not\(\.result\)[^{]*\{[^}]*background-color: #212121/.test(css));
ok("argument summary is fully opaque and legible in both themes",
  /html\.zs-site-chatgpt \.zs-chip:not\(\.result\) \.zs-chip-dt \{[^}]*color: #5f6368; opacity: 1/.test(css) &&
  /\[data-theme="dark"\] \.zs-chip:not\(\.result\) \.zs-chip-dt,[^}]*color: #b4b4b4; opacity: 1/.test(css));
ok("state colour moves to the icon (done green, err red) in both themes",
  /\.zs-chip:not\(\.result\)\.done \.zs-chip-ic \{ color: #16a34a/.test(css) &&
  /\.zs-chip:not\(\.result\)\.err \.zs-chip-ic \{ color: #dc2626/.test(css) &&
  /\.zs-chip:not\(\.result\)\.done \.zs-chip-ic \{ color: #5cbf9a/.test(css) &&
  /\.zs-chip:not\(\.result\)\.err \.zs-chip-ic \{ color: #ef6b6b/.test(css));

// ── 11. In-place repaint: no blink, visible tick, expandable card ──────────
// Report 2026-11-18: "icon loading masih ngeblink2, icon pas command selesai ga
// muncul, pas di klik uncollapse ga ke buka". All three came from the same root:
// chip.innerHTML was rebuilt on every sweep ~4x/s, so (a) the spinner restarted,
// (b) the tick's pop animation restarted and froze on its first frame (opacity
// 0 -> invisible icon), and (c) the user's `open` class was wiped.
ok("the chip shell is built once, not re-created every sweep",
  /if \(!head\) \{/.test(src) &&
  /head\.addEventListener\("click"/.test(src) &&
  /chip\.classList\.toggle\("open"\)/.test(src));
ok("the expanded state survives a repaint",
  /const wasOpen = chip\.classList\.contains\("open"\)/.test(src) &&
  /\$\{wasOpen \? " open" : ""\}/.test(src));
ok("the state icon is rewritten only when the state changes",
  /icEl\.dataset\.zicon !== iconKey/.test(src) &&
  /icEl\.innerHTML = iconFor\(category, phase\)/.test(src));
ok("expand/collapse does not depend on a throttled transition",
  /\.zs-chip\.open \.zs-chip-body \{[^}]*display: block/.test(css));
const popBlock = (css.match(/@keyframes zs-icon-pop \{[\s\S]*?\n\}/) || [""])[0]
  .replace(/\/\*[\s\S]*?\*\//g, ""); // ignore the comment that explains WHY
ok("icon pop never animates from opacity 0",
  popBlock.length > 0 && !/opacity/.test(popBlock));

// ── 12. A settled card keeps its expand chevron ────────────────────────────
// Report 2026-11-18: "✓ list_dir  path: immersed-tube-tunnel" had no `v`, so
// the card looked un-collapsible. The loop passes the call payload as `body`
// while it owns the turn; the sweep re-derives reloaded chips with
// body=undefined, and chip() only creates .zs-chip-cv when a body exists.
ok("the sweep rebuilds the payload body for run/done/err",
  /let chipBody = "";/.test(src) &&
  /if \(phase === "run" \|\| phase === "done" \|\| phase === "err"\)/.test(src) &&
  /chipBody = callBody\(calls\[calls\.length - 1\]\)/.test(src));
ok("the re-derived body reaches toolBox so the chevron is created",
  /this\.toolBox\(item, nm, phase, detail, false, chipBody, cat\)/.test(src));
ok("an already painted body (live tool output) is never overwritten",
  /const preNow = chipNow && chipNow\.querySelector\("\.zs-chip-body pre"\)/.test(src));
ok("the chevron is themed in both ChatGPT themes",
  /\.zs-chip:not\(\.result\) \.zs-chip-cv \{ color: #6b7280/.test(css) &&
  /\[data-theme="dark"\] \.zs-chip:not\(\.result\) \.zs-chip-cv,[^}]*color: #9aa0a6/.test(css));
// The site replaces the turn's subtree on unrelated updates, so the chip NODE
// (and its `open` class) is thrown away ~1s after the user expanded it. Mirror
// the decision on the turn element, which survives that churn.
ok("expanded state is mirrored on the turn element",
  /chip\.classList\.contains\("open"\) \|\| item\.dataset\.zopen === "1"/.test(src) &&
  /if \(openNow\) item\.dataset\.zopen = "1"/.test(src) &&
  /else delete item\.dataset\.zopen/.test(src));
ok("a recycled turn drops the expanded state with the rest",
  /delete item\.dataset\.zopen/.test(src));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

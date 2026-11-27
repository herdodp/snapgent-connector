// Unit tests for Gemini periodic system-prompt reminder and nativeCall guard.
// Run: node test-gemini-reminder.js
const assert = require("assert");
const fs = require("fs");
const vm = require("vm");

const readSource = (rel) => fs.readFileSync(__dirname + "/" + rel, "utf8").replace(/\r\n/g, "\n");

function loadCoreZS() {
  const ctx = vm.createContext({
    console, window: {}, document: {}, navigator: {}, setTimeout, clearTimeout,
  });
  return vm.runInContext(readSource("core/config.js") + "\n;ZS;", ctx);
}

function loadGeminiProvider() {
  const ctx = vm.createContext({
    console,
    window: {},
    document: { hidden: false, querySelector: () => null, querySelectorAll: () => [] },
    navigator: {},
    setTimeout,
    clearTimeout,
    MouseEvent: function () {},
    KeyboardEvent: function () {},
    InputEvent: function () {},
    Event: function () {},
  });
  return vm.runInContext(readSource("providers/gemini.js") + "\n;ZSProvider;", ctx);
}

// Extract the exact nativeCall block from core/main.js so tests pin the shipped code.
function buildNativeDetector(coreZS, toolSet) {
  const mainSrc = readSource("core/main.js");
  const start = mainSrc.indexOf('if (!/"command"\\s*:/.test(r)) {');
  const end = mainSrc.indexOf("// NOTE: a site \"server busy", start);
  assert.ok(start > 0 && end > start, "nativeCall block found in core/main.js");
  const block = mainSrc.slice(start, end);
  const fnBody = `
    const knownTool = (n) => toolSet.has(n);
    const diag = () => {};
    const A = { toolNames: toolSet };
    const d = { item: {} };
    ${block}
    return null;
  `;
  const fn = new Function("r", "toolSet", fnBody);
  return (r) => fn(r, toolSet);
}

// Extract sinceLastSysInDom from core/main.js and run it against a simulated
// Gemini DOM where SYS_MARKER / RESEND_MARKER were stripped on render.
function buildSinceLastSysInDom(coreZS, items) {
  const mainSrc = readSource("core/main.js");
  const start = mainSrc.indexOf("function sinceLastSysInDom()");
  const end = mainSrc.indexOf("function sinceLastSys()", start);
  assert.ok(start > 0 && end > start, "sinceLastSysInDom found in core/main.js");
  const fnSrc = mainSrc.slice(start, end);
  const P = {
    allItems: () => items,
    classifyText: (it) => it.text,
    isUserItem: (it) => it.role === "user",
  };
  const ZSParse = {
    isInjectedFeedback: (txt) => txt.startsWith("Output of "),
  };
  return new Function("ZS", "P", "ZSParse", fnSrc + "\n;return sinceLastSysInDom();")(
    coreZS, P, ZSParse
  );
}

let passed = 0;
function check(cond, label, actual) {
  if (!cond) {
    console.error("FAIL ", label, "→", actual);
    process.exitCode = 1;
    return;
  }
  console.log("PASS ", label);
  passed++;
}

const coreZS = loadCoreZS();
const gem = loadGeminiProvider();

check(gem.resendSystemEvery === 6, "Gemini enables resendSystemEvery: 6", gem.resendSystemEvery);
check(typeof gem.sendCharBudget === "number" && gem.sendCharBudget > 0,
  "Gemini sets positive sendCharBudget", gem.sendCharBudget);

const msg = coreZS.FEEDBACK.parseError("nativeCall", "read_file");
check(/default_api/.test(msg) && /"command": "name"/.test(msg),
  "nativeCall feedback reminds Gemini to use JSON command envelope", msg);

// nativeCall detector tests (all 5 review cases + JSON guard)
const detect = buildNativeDetector(coreZS, new Set(["read_file", "write_file"]));
check(detect("call:default_api:read_file{path:1}")?.reason === "nativeCall",
  "detects call:default_api:read_file{...}", detect("call:default_api:read_file{path:1}"));
check(detect("default_api.read_file(path)")?.reason === "nativeCall",
  "detects default_api.read_file(...)", detect("default_api.read_file(path)"));
check(detect("Please call:read_file{x}") === null,
  "ignores prose mentioning call:read_file{x}", detect("Please call:read_file{x}"));
check(detect("use the default_api.read_file( syntax in docs") === null,
  "ignores prose mentioning default_api.read_file(", detect("use the default_api.read_file( syntax in docs"));
check(detect("call:unknown_tool{a} then default_api.read_file(b)")?.reason === "nativeCall",
  "does not short-circuit on unknown_tool before known tool", detect("call:unknown_tool{a} then default_api.read_file(b)"));
check(detect('call:default_api:read_file{x}\n{"command": "read_file", "params": {}}') === null,
  "skips nativeCall when JSON command envelope is present", detect('{"command": "read_file"}'));

// Simulated 14-turn Gemini session where Gemini strips SYS_MARKER and RESEND_MARKER
// on rendered turns: rider at turn 7 must stop sinceLastSysInDom() so turn 8..14
// only count 6 results instead of accumulating from the bootstrap turn.
const turns = [
  { role: "user", text: "CONTEXT: snapgentV3 is a browser extension..." }, // bootstrap (marker stripped)
];
for (let i = 1; i <= 6; i++) {
  turns.push({ role: "assistant", text: `{"command":"read_file","params":{"n":${i}}}` });
  turns.push({ role: "user", text: `Output of 'read_file': ok ${i}` });
}
// Turn 7 carries the rider appended to a tool result, with markers stripped by Gemini:
turns.push({ role: "assistant", text: `{"command":"read_file","params":{"n":7}}` });
turns.push({
  role: "user",
  text: "Output of 'read_file': ok 7\n\n────────────────────────────────\n" +
    "(System note from snapgentV3 - an automatic re-statement of your operating instructions, NOT a new request)",
});
for (let i = 8; i <= 13; i++) {
  turns.push({ role: "assistant", text: `{"command":"read_file","params":{"n":${i}}}` });
  turns.push({ role: "user", text: `Output of 'read_file': ok ${i}` });
}
const counts = buildSinceLastSysInDom(coreZS, turns);
check(counts.results === 6 && counts.users === 0,
  "sinceLastSysInDom stops at rendered rider even when SYS_MARKER/RESEND_MARKER are stripped (6, not 13)", counts);

console.log(`\n${passed} passed`);

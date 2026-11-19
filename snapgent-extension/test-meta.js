// Quick Node regression test for providers/meta.js (run: node test-meta.js).
// Not shipped.
const fs = require("fs");
const assert = require("assert");

class StubTextArea {}
Object.defineProperty(StubTextArea.prototype, "value", {
  get() { return this._value || ""; },
  set(value) { this._value = String(value); },
});
class StubInput {}
Object.defineProperty(StubInput.prototype, "value", {
  get() { return this._value || ""; },
  set(value) { this._value = String(value); },
});

global.window = { HTMLTextAreaElement: StubTextArea, HTMLInputElement: StubInput };
global.HTMLTextAreaElement = StubTextArea;
global.HTMLInputElement = StubInput;
global.Event = class { constructor(type, options) { this.type = type; Object.assign(this, options); } };
global.KeyboardEvent = class extends global.Event {};
global.InputEvent = class extends global.Event {};
global.MouseEvent = class extends global.Event {};
global.PointerEvent = class extends global.Event {};

let sendClicks = 0;
let enterDispatches = 0;

const editor = Object.assign(new StubTextArea(), {
  tagName: "TEXTAREA",
  offsetParent: {},
  attrs: {},
  focus() {},
  closest() { return null; },
  querySelector() { return null; },
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
  getAttribute(name) { return this.attrs[name] ?? null; },
  dispatchEvent() {},
  getClientRects() { return [{ width: 300, height: 30 }]; },
});
const visibleEditor = {
  tagName: "DIV",
  offsetParent: {},
  attrs: {},
  textContent: "",
  focus() {},
  closest() { return null; },
  querySelector() { return null; },
  getClientRects() { return [{ width: 300, height: 30 }]; },
  setAttribute(name, value) { this.attrs[name] = value; },
  removeAttribute(name) { delete this.attrs[name]; },
  getAttribute(name) { return this.attrs[name] ?? null; },
  dispatchEvent(ev) {
    if (ev && ev.key === "Enter") enterDispatches++;
  },
};
let stopButton = null;
const sendButton = {
  tagName: "BUTTON",
  attrs: { "aria-label": "Send" },
  offsetParent: {},
  disabled: false,
  getAttribute(name) { return this.attrs[name] ?? null; },
  focus() {},
  click() {
    sendClicks++;
    // Simulate Meta accepting the prompt and switching to its generation control
    // while the hidden textarea still retains the submitted value.
    this.offsetParent = null;
    stopButton = {
      tagName: "BUTTON",
      attrs: { "aria-label": "Stop generating" },
      offsetParent: {},
      getAttribute(name) { return this.attrs[name] ?? null; },
      getClientRects() { return [{ width: 30, height: 30 }]; },
      click() {},
    };
  },
  getClientRects() { return this.offsetParent ? [{ width: 30, height: 30 }] : []; },
};

global.document = {
  querySelector() { return null; },
  querySelectorAll(selector) {
    if (selector.includes("composer-input")) return [editor, visibleEditor];
    if (selector.toLowerCase().includes("send")) return sendButton.offsetParent ? [sendButton] : [];
    if (selector.toLowerCase().includes("stop")) return stopButton ? [stopButton] : [];
    return [];
  },
};
global.location = { pathname: "/" };

const provider = new Function(
  fs.readFileSync(__dirname + "/providers/meta.js", "utf8") + "; return ZSProvider;"
)();

(async () => {
  provider.setInputLock(true);
  assert.strictEqual(editor.getAttribute("readonly"), null, "hidden controlled textarea stays writable");

  sendClicks = 0;
  enterDispatches = 0;
  await provider.typeAndSend("startup prompt");

  assert.strictEqual(editor.value, "startup prompt", "Meta may retain the submitted mirror value");
  assert.ok(stopButton, "Meta exposes its generation control");
  assert.strictEqual(sendClicks, 1, "send button clicked exactly once");
  assert.strictEqual(enterDispatches, 0, "fallback Enter was not triggered when send button succeeded");
  provider.setInputLock(false);

  // Test fallback: button click fails to trigger submission, so fallback Enter is used
  sendClicks = 0;
  enterDispatches = 0;
  stopButton = null;
  sendButton.offsetParent = {};
  sendButton.click = () => { sendClicks++; /* fails to start generation or clear */ };
  visibleEditor.textContent = "fallback prompt";
  visibleEditor.dispatchEvent = (ev) => {
    if (ev && ev.type === "keydown" && ev.key === "Enter") {
      enterDispatches++;
      // Simulate Enter successfully starting generation
      stopButton = {
        tagName: "BUTTON",
        attrs: { "aria-label": "Stop generating" },
        offsetParent: {},
        getAttribute(name) { return this.attrs[name] ?? null; },
        getClientRects() { return [{ width: 30, height: 30 }]; },
        click() {},
      };
    }
  };
  await provider.typeAndSend("fallback prompt");
  assert.strictEqual(sendClicks, 1, "send button was attempted first");
  assert.strictEqual(enterDispatches, 1, "fallback Enter was triggered exactly once after primary failed");
  assert.ok(stopButton, "fallback submission succeeded");

  // Restore sendButton.click
  sendButton.click = function () {
    sendClicks++;
    this.offsetParent = null;
    stopButton = {
      tagName: "BUTTON",
      attrs: { "aria-label": "Stop generating" },
      offsetParent: {},
      getAttribute(name) { return this.attrs[name] ?? null; },
      getClientRects() { return [{ width: 30, height: 30 }]; },
      click() {},
    };
  };

  const input = Object.assign(new StubInput(), {
    tagName: "INPUT",
    offsetParent: {},
    attrs: {},
    focus() {},
    closest() { return null; },
    getClientRects() { return [{ width: 200, height: 30 }]; },
    setAttribute(name, value) { this.attrs[name] = value; },
    removeAttribute(name) { delete this.attrs[name]; },
    getAttribute(name) { return this.attrs[name] ?? null; },
    dispatchEvent() {},
  });
  global.document.querySelectorAll = (selector) => {
    if (selector.includes("input[aria-label=\"Ask Meta AI\"]") || selector.toLowerCase().includes("meta ai") || selector.includes("input")) return [input];
    if (selector.toLowerCase().includes("send")) return sendButton.offsetParent ? [sendButton] : [];
    if (selector.toLowerCase().includes("stop")) return stopButton ? [stopButton] : [];
    return [];
  };
  stopButton = null;
  sendButton.offsetParent = {};
  sendButton.attrs["aria-label"] = "Send";
  input.value = "";
  sendClicks = 0;
  enterDispatches = 0;
  provider.setInputLock(true);
  assert.strictEqual(provider.getEditor(), input, "current Meta input is detected");
  await provider.typeAndSend("current composer prompt");
  assert.strictEqual(input.value, "current composer prompt", "current input value can be submitted");
  assert.strictEqual(sendClicks, 1, "input path also triggers send exactly once");
  provider.setInputLock(false);

  console.log("PASS Meta send is accepted when generation starts before the mirror textarea clears");
  console.log("PASS single submission path is used with fallback only on failure");
  console.log("PASS current Meta AI input and aria-labelled Send/Stop controls are supported");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

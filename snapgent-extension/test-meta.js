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
  closest() { return null; },
  querySelector() { return null; },
  getClientRects() { return [{ width: 300, height: 30 }]; },
  setAttribute() {},
};
let stopButton = null;
const sendButton = {
  tagName: "BUTTON",
  attrs: { "aria-label": "Send" },
  offsetParent: {},
  disabled: false,
  getAttribute(name) { return this.attrs[name] ?? null; },
  click() {
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
    if (selector.includes("aria-label=\"Send\"")) return [sendButton];
    if (selector.includes("aria-label*=\"Stop\"")) return stopButton ? [stopButton] : [];
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

  await provider.typeAndSend("startup prompt");

  assert.strictEqual(editor.value, "startup prompt", "Meta may retain the submitted mirror value");
  assert.ok(stopButton, "Meta exposes its generation control");
  provider.setInputLock(false);

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
    if (selector.includes("input[aria-label=\"Ask Meta AI\"]")) return [input];
    if (selector.includes("aria-label=\"Send\"")) return [sendButton];
    if (selector.includes("aria-label*=\"Stop\"")) return stopButton ? [stopButton] : [];
    return [];
  };
  stopButton = null;
  sendButton.offsetParent = {};
  sendButton.attrs["aria-label"] = "Send";
  input.value = "";
  provider.setInputLock(true);
  assert.strictEqual(provider.getEditor(), input, "current Meta input is detected");
  await provider.typeAndSend("current composer prompt");
  assert.strictEqual(input.value, "current composer prompt", "current input value can be submitted");
  provider.setInputLock(false);

  console.log("PASS Meta send is accepted when generation starts before the mirror textarea clears");
  console.log("PASS current Meta AI input and aria-labelled Send/Stop controls are supported");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// SPDX-License-Identifier: GPL-3.0-or-later
// providers/qwen-coder.js - Qwen Coder (coder.qwen.ai).
// This is a separate provider from providers/qwen.js (chat.qwen.ai).
// eslint-disable-next-line no-unused-vars
const ZSProvider = (() => {
  "use strict";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let diag = () => {};
  let lockedEditor = null;

  const S = {
    editor: "textarea.code-agent-input-textarea",
    composer: ".code-agent-input-textarea-container",
    send: "button.code-agent-input-send",
    message: '[class*="code-agent-message"],[class*="chat-message"],[class*="conversation-message"]',
  };
  const timings = {
    GEN_IDLE_MS: 2000,
    REASON_IDLE_MS: 15000,
    WARMUP_MS: 60000,
    REASON_NOREPLY_MS: 120000,
    STABLE_MS: 10000,
    RESPONSE_TIMEOUT_MS: 300000,
  };
  const visible = (el) => !!el && el.isConnected && el.getClientRects().length > 0;

  function getEditor() {
    if (visible(lockedEditor) && !lockedEditor.closest("#zs-root")) return lockedEditor;
    for (const el of document.querySelectorAll(S.editor)) {
      if (!el.closest("#zs-root") && visible(el)) return el;
    }
    return null;
  }
  const editorText = () => {
    const el = getEditor();
    return el ? (el.value || "") : "";
  };
  const composerFrame = () => {
    const el = getEditor();
    return (el && el.closest(S.composer)) ||
      document.querySelector(S.composer) || null;
  };
  const barAnchor = () => {
    const frame = composerFrame();
    return frame && visible(frame) ? frame : null;
  };
  const gateTarget = barAnchor;

  const allItems = () => [...document.querySelectorAll(S.message)]
    .filter((el) => !el.closest("#zs-root"));
  const isUserItem = (item) => !!item && /user|human|question/i.test(item.className || "");
  const isAssistantItem = (item) => !!item && !isUserItem(item);
  const assistantItems = () => allItems().filter(isAssistantItem);
  const assistantCount = () => assistantItems().length;
  const userCount = () => allItems().filter(isUserItem).length;
  const lastAssistant = () => {
    const items = assistantItems();
    return items.length ? items[items.length - 1] : null;
  };
  const itemText = (item) => item
    ? (item.innerText || item.textContent || "").replace(/[\u200B-\u200D\uFEFF]/g, "").trim()
    : "";
  const classifyText = (item, excludeSel) => {
    if (!item) return "";
    const clone = item.cloneNode(true);
    const selectors = [".zs-chip", ".zs-tool-hide", excludeSel].filter(Boolean).join(",");
    clone.querySelectorAll(selectors).forEach((el) => el.remove());
    return (clone.innerText || clone.textContent || "").trim();
  };
  const ids = new WeakMap();
  let nextId = 0;
  function lastAssistantId() {
    const item = lastAssistant();
    if (!item) return null;
    if (!ids.has(item)) ids.set(item, ++nextId);
    return ids.get(item);
  }

  let grewAt = 0;
  let sampledText = "";
  function streamText(item) {
    return itemText(item === undefined ? lastAssistant() : item);
  }
  function streamLen(item) {
    return streamText(item).length;
  }
  function sampleStream() {
    const text = streamText();
    const now = Date.now();
    if (text !== sampledText) {
      sampledText = text;
      grewAt = now;
    }
  }

  function sendButton() {
    for (const el of document.querySelectorAll(S.send)) {
      if (!visible(el) || el.disabled) continue;
      const cls = String(el.className).toLowerCase();
      if (!cls.includes("disable") && el.getAttribute("aria-disabled") !== "true") return el;
    }
    return null;
  }
  const stopButton = () => null;
  const isHardGenerating = () => !!stopButton();
  function isGenerating() {
    sampleStream();
    return isHardGenerating() || (sampledText.length > 0 && Date.now() - grewAt < timings.GEN_IDLE_MS);
  }
  const isBusyNow = isGenerating;

  function snapshot() {
    return { th: 0, rp: streamLen(lastAssistant()) };
  }
  function readAssistant() {
    const item = lastAssistant();
    return { present: !!item, reply: item ? streamText(item).trim() : "", thinking: "", item };
  }

  function setInputLock(on) {
    const editor = on ? getEditor() : (lockedEditor || getEditor());
    lockedEditor = on ? editor : null;
    if (editor) {
      if (on) {
        editor.setAttribute("readonly", "");
        editor.setAttribute("data-zs-locked", "1");
      } else {
        editor.removeAttribute("readonly");
        editor.removeAttribute("data-zs-locked");
      }
    }
  }
  async function waitFor(predicate, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate()) return true;
      await sleep(120);
    }
    return false;
  }
  function setTextareaValue(editor, text) {
    editor.removeAttribute("readonly");
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(editor, text);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  }
  async function typeAndSend(text) {
    const editor = getEditor();
    if (!editor) throw new Error("Qwen Coder input box not found");
    const beforeUsers = userCount();
    setTextareaValue(editor, text);
    const ready = await waitFor(() => !!sendButton(), 10000);
    const button = sendButton();
    if (!ready || !button) throw new Error("Qwen Coder send button did not become available");
    button.click();
    await waitFor(() =>
      editorText().trim() === "" || userCount() > beforeUsers || isHardGenerating(),
    5000);
  }
  function stopGeneration() {
    const button = stopButton();
    if (button) button.click();
  }
  const enforceComposer = () => ({ ready: !!getEditor() });
  async function ensureComposerReady(reason) {
    const ready = !!getEditor();
    diag("mode_ready", { reason, provider: "qwen-coder", ready });
    return { ready };
  }

  function scanError() {
    for (const el of document.querySelectorAll('[role="alert"],[class*="toast"],[class*="error"],[class*="alert"],[class*="message-notice"]')) {
      if (!visible(el) || el.closest("#zs-root")) continue;
      const text = (el.innerText || el.textContent || "").trim();
      if (text.length > 8 && text.length < 600) return text.slice(0, 240);
    }
    return getEditor() ? null : "The Qwen Coder input box is not available.";
  }
  const isTooLongMsg = (text) => /conversation.{0,30}(too long|limit)|context.{0,20}limit/i.test(text);
  const isBusyMsg = (text) => /try again later|temporarily unavailable|rate limit|too many requests/i.test(text);
  const turnHalted = () => false;
  const findContinueBtn = () => null;
  const clickContinueBtn = () => false;

  function conversationKey() {
    const items = allItems();
    const first = items[0];
    if (!first) return "";
    if (!ids.has(first)) ids.set(first, ++nextId);
    return "qwen-coder:" + ids.get(first);
  }
  function installSendHooks(handlers) {
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
      const editor = getEditor();
      if (!editor || event.target !== editor || !editorText().trim()) return;
      if (handlers.isBlocked()) return;
      if (!handlers.isStarted()) {
        if (chatIsEmpty()) handlers.onBlockedAttempt();
        return;
      }
      handlers.onUserMessage(assistantCount());
    }, true);
  }
  const chatIsEmpty = () => allItems().length === 0;
  const isFreshChat = () => chatIsEmpty() && !!getEditor();
  function findToolBlockSpot(item) {
    if (!item) return null;
    let found = null;
    item.querySelectorAll("pre,code,p,li").forEach((el) => {
      if (el.closest(".zs-chip, .zs-tool-hide")) return;
      if (/["'](?:command|tool)["']\s*:|###\s*(?:lua|mcp_tool)/i.test(el.textContent || "")) {
        el.classList.add("zs-tool-hide");
        found = found || { parent: el.parentElement, ref: el };
      }
    });
    return found;
  }

  return {
    id: "qwen-coder",
    displayName: "Qwen Coder",
    sendRetryLimit: 2,
    supportsVision: false,
    timings,
    chipAtItemLevel: true,
    reliableCounts: true,
    init({ diag: d } = {}) { if (d) diag = d; },
    allItems, isUserItem, isAssistantItem, itemText, classifyText,
    assistantCount, userCount, lastAssistant, lastAssistantId, readAssistant,
    streamLen, snapshot,
    getEditor, editorText, chatIsEmpty, isFreshChat, composerFrame, gateTarget, barAnchor,
    setInputLock, typeAndSend, stopGeneration,
    isGenerating, isBusyNow, isHardGenerating,
    enforceComposer, ensureComposerReady,
    turnHalted, findContinueBtn, clickContinueBtn,
    scanError, isTooLongMsg, isBusyMsg,
    attachImages: () => false,
    clearAttachments: () => {},
    conversationKey, installSendHooks, findToolBlockSpot,
  };
})();

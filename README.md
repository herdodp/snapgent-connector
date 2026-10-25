<div align="center">

<h1><img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=800&size=52&duration=3000&pause=1000&color=FACC15&center=true&vCenter=true&width=600&height=90&lines=snapgentV3" alt="snapgentV3"></h1>

**Turn any AI chat into an agent for Roblox Studio.**

[![License](https://img.shields.io/badge/LICENSE-GPL--3.0-FACC15?style=flat-square&labelColor=111111)](LICENSE)
[![Manifest](https://img.shields.io/badge/MANIFEST-V3-FACC15?style=flat-square&labelColor=111111)](snapgent-extension/manifest.json)
[![Release](https://img.shields.io/badge/RELEASE-V3-FACC15?style=flat-square&labelColor=111111)](https://github.com/herdodp/snapgent-connector/releases/tag/V3)
[![Protocol](https://img.shields.io/badge/PROTOCOL-MCP-FACC15?style=flat-square&labelColor=111111)](https://modelcontextprotocol.io/)

</div>

```text
herdo@snapgent:~$ snapgentV3

 ┌──────────────────────────────────────────────┐
 │ SNAPGENT V3  /  ROBLOX STUDIO MCP AGENT       │
 └──────────────────────────────────────────────┘

 > browser extension + local bridge for Roblox Studio
 > no API key · no terminal · no copy-paste
```

snapgentV3 connects a supported AI chat to Roblox Studio through a browser extension, a local bridge, and MCP. Describe what you want to build; the AI can read and edit scripts, run Luau, inspect your place, and create assets directly in Studio.

**Free and open source.** No API key or subscription is required. DeepSeek is the recommended provider.

---

### 📖 Read & Edit

Read and update scripts in your Roblox place directly from an AI conversation.

### ⚡ Build & Run

Run Luau, generate assets, and control play-testing in Roblox Studio.

### 🔍 Inspect

Explore instances, check Studio state, and search your game without leaving chat.

---

## `01` &nbsp; How it works

```text
┌────────────┐     commands      ┌──────────────────┐    WebSocket    ┌─────────────┐    MCP    ┌────────────────┐
│  AI chat   │ ────────────────▶ │ snapgentV3       │ ──────────────▶ │ Local bridge│ ────────▶ │ Roblox Studio  │
│ (browser)  │ ◀──────────────── │ browser extension│ ◀────────────── │             │ ◀──────── │ + MCP          │
└────────────┘     results       └──────────────────┘                 └─────────────┘           └────────────────┘
```

1. You describe a task in a supported AI chat.
2. The AI replies with a snapgentV3 command.
3. The browser extension detects the command and sends it to the bridge on your computer.
4. The bridge runs it through Roblox Studio's MCP server and returns the result to the AI.
5. The AI continues until the task is complete.

The chat bar also lets you select other configured MCP servers, including a VS Code MCP server. VS Code is an optional MCP target; Roblox Studio is the primary built-in integration.

---

## `02` &nbsp; Supported AI providers

| Provider | URL | Notes |
| --- | --- | --- |
| **DeepSeek** | `chat.deepseek.com` | Recommended |
| **ChatGPT** | `chatgpt.com` | Image input and screenshots are disabled |
| **Claude** | `claude.ai` | Image input and screenshots are disabled |
| **Google Gemini** | `gemini.google.com` | May stop using tools in long sessions |
| **Kimi** | `kimi.ai` | May prefer its native tools in some sessions |
| **GLM** | `chat.z.ai` | |
| **Qwen** | `chat.qwen.ai` | |
| **Arena** | `arena.ai` | Use **Direct** mode |
| **Meta AI** | `meta.ai` | |
| **Ptero** | `ptero.pro` | |

---

## `03` &nbsp; Requirements

- **Windows** or **macOS**
- **Roblox Studio** with its built-in MCP server
- **Microsoft Edge** or **Google Chrome**
- **Python 3.9+** on macOS. Windows release launchers handle the bridge runtime.

---

## `04` &nbsp; Installation

### ① Install the browser extension

Download and extract the [latest release](https://github.com/herdodp/snapgent-connector/releases). In Edge or Chrome:

1. Open `edge://extensions` or `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Choose the extracted `snapgent-extension` folder.

### ② Enable Roblox Studio MCP

Open a place in Studio, then select **Assistant AI** → **…** → **Manage MCP Servers** → **Enable Studio as MCP Server**.

### ③ Start the bridge

- **Windows:** double-click `start.bat`.
- **macOS:** double-click `MacOS_Start.command`.

Keep the bridge window open while using snapgentV3. On the first macOS launch, Gatekeeper may block the script; allow it under **System Settings → Privacy & Security**.

### ④ Start an agent

Open a supported AI chat and find the snapgentV3 bar above the message box. Select **Roblox Studio** as the MCP target, click **Start**, and describe what you want to make.

To use **VS Code** or another MCP server, configure that server in the bridge first, then select it from the MCP target menu.

---

## `05` &nbsp; Bridge status

| Indicator | Meaning |
| --- | --- |
| 🟢 Green | Bridge connected and Studio ready |
| 🟡 Yellow | Bridge connected; Studio needs attention or a place is not open |
| ⚪ Grey | Bridge is offline; start `start.bat` or `MacOS_Start.command` |

---

## `06` &nbsp; For contributors

The browser extension has a provider-independent core and per-site adapters:

```text
snapgent-extension/
├── core/                 Shared prompt, parser, UI, and agent loop
├── providers/            AI-site-specific integrations
├── background.js         Connection to the local bridge
└── manifest.json         Browser extension manifest
```

To add an AI provider, implement the `ZSProvider` interface, register its content script and host permissions in `manifest.json`, and add its URL to `PROVIDER_URLS` in `background.js`.

Run the smoke tests from `snapgent-extension`:

```sh
node test-parser.js
node test-chatgpt.js
```

---

<div align="center">

**Built for creators who want to spend more time making.**

[Releases](https://github.com/herdodp/snapgent-connector/releases) · [Issues](https://github.com/herdodp/snapgent-connector/issues) · [License](LICENSE)

</div>

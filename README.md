<div align="center">
  <img src="snapgent-extension/icon.png" alt="snapgentV3 logo" width="132">
  <h1>snapgentV3</h1>
  <p><strong>Your AI chat, connected to Roblox Studio.</strong></p>
  <p>Build and edit Roblox experiences by describing what you want. snapgentV3 connects supported AI chat sites to Roblox Studio through a local bridge and MCP.</p>
  <p>
    <a href="https://github.com/herdodp/snapgent-connector/releases"><img src="https://img.shields.io/github/v/release/herdodp/snapgent-connector?display_name=tag&style=for-the-badge&color=7c3aed" alt="Latest release"></a>
    <img src="https://img.shields.io/badge/License-GPL--3.0-blue?style=for-the-badge" alt="GPL-3.0 license">
    <img src="https://img.shields.io/badge/Windows%20%7C%20macOS-supported-2563eb?style=for-the-badge" alt="Windows and macOS">
  </p>
  <p>
    <a href="https://github.com/herdodp/snapgent-connector/releases">Download</a> ·
    <a href="#quick-start">Quick start</a> ·
    <a href="#supported-ai-providers">AI providers</a> ·
    <a href="#for-contributors">Contributing</a>
  </p>
</div>

---

## What is snapgentV3?

snapgentV3 is a free, open-source browser extension and local bridge that lets you control Roblox Studio from an AI conversation. Ask an AI to build a feature, inspect your game, or update a script—the extension sends the AI's commands to the bridge on your computer, which connects to Roblox Studio's MCP server.

**No API key, subscription, or coding required to get started.** DeepSeek is the recommended provider; the other supported providers are available from the bar inside each chat.

```text
Your prompt → AI chat → snapgentV3 extension → Local bridge → Roblox Studio
```

## What you can do

- Read and edit scripts in Roblox Studio
- Run Luau code and inspect the game tree
- Generate models, meshes, and materials
- Browse and insert Creator Store assets
- Start and control play-testing
- Keep project memory across sessions, saved inside your place
- Connect to Roblox Studio or another configured MCP server from the chat bar

## Supported AI providers

| Provider | Chat site | Notes |
| --- | --- | --- |
| **DeepSeek** | [chat.deepseek.com](https://chat.deepseek.com) | Recommended |
| **ChatGPT** | [chatgpt.com](https://chatgpt.com) | Image input and screenshots are disabled in this integration |
| **Claude** | [claude.ai](https://claude.ai) | Image input and screenshots are disabled in this integration |
| **Google Gemini** | [gemini.google.com](https://gemini.google.com) | May stop using tools during long sessions |
| **Kimi** | [kimi.ai](https://kimi.ai) | May prefer its own native tools over Roblox commands |
| **GLM** | [chat.z.ai](https://chat.z.ai) | |
| **Qwen** | [chat.qwen.ai](https://chat.qwen.ai) | |
| **Arena** | [arena.ai](https://arena.ai) | Use **Direct** mode; other modes are not supported |
| **Meta AI** | [meta.ai](https://meta.ai) | |
| **Ptero** | [ptero.pro](https://ptero.pro) | |

> Gemini and Kimi behavior can vary by model and session. If a provider stops using Roblox tools, remind it to use the commands or start a new session.

## Quick start

### 1. Download and install the extension

Download the latest release and extract the archive. In Microsoft Edge or Google Chrome:

1. Open `edge://extensions` or `chrome://extensions`.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Choose the extracted `snapgent-extension` folder.

### 2. Enable Roblox Studio's MCP server

Open a place in Roblox Studio, then enable its MCP server (first-time setup):

1. Open **Assistant AI** from the top bar.
2. Select **…** → **Manage MCP Servers**.
3. Select **Enable Studio as MCP Server**.

### 3. Start the local bridge

- **Windows:** double-click `start.bat` from the extracted release folder.
- **macOS:** double-click `MacOS_Start.command`.

On the first macOS launch, Gatekeeper may show a warning. Select **Done**, then open **System Settings → Privacy & Security** and choose **Open Anyway** for the blocked script.

### 4. Start an AI session

Open one of the supported chat sites above. The snapgentV3 bar appears above the chat input. Choose **Roblox Studio** from the MCP target selector, then select **Start session** and describe what you want to build.

The bridge must remain running while you use the extension. In the bar, a green status means Studio is ready; yellow means the bridge is connected but Studio still needs attention; grey means the bridge is offline.

## Requirements

- Windows or macOS
- Roblox Studio with its built-in MCP support
- Microsoft Edge or Google Chrome
- Python 3.9+ (installed automatically on Windows; install separately on macOS from [python.org](https://www.python.org/downloads/))

## About this project

snapgentV3 is free and open source under the GPL-3.0 license. Get official downloads from [GitHub Releases](https://github.com/herdodp/snapgent-connector/releases). There is no official paid version of this project.

## For contributors

The extension has a provider-independent core and a separate adapter for each AI chat site:

```text
snapgent-extension/
├── core/
│   ├── config.js       Shared configuration and prompts
│   ├── parser.js       Command parsing
│   └── main.js         UI and agent loop
├── providers/          Site-specific DOM and chat integrations
├── background.js       Connection to the local bridge
└── manifest.json       Extension permissions and content scripts
```

Each provider exposes the `ZSProvider` interface used by the core. To add a provider, implement that interface, register its content script and host permissions in `manifest.json`, and add its URL to `PROVIDER_URLS` in `background.js`.

Run the extension's smoke tests from `snapgent-extension`:

```sh
node test-parser.js
node test-chatgpt.js
```

## Credits

- The idea of connecting additional MCP servers alongside Roblox Studio was inspired by [javnpa](https://github.com/javnpa).
- macOS/Linux support contributions by [archivealf](https://github.com/archivealf).

---

<div align="center">
  <sub>Built for creators who want to spend more time making.</sub>
</div>

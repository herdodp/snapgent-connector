<div align="center">

<a href="https://github.com/herdodp/snapgent-connector">
<img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=800&size=52&duration=3000&pause=1000&color=FACC15&center=true&vCenter=true&width=600&height=90&lines=snapgentV3;%3E+AI+agent+for+Roblox+Studio" alt="snapgentV3" />
</a>

<p><b>Turn any AI chat into an agent that builds your Roblox game.</b></p>

[![License](https://img.shields.io/badge/LICENSE-GPL--3.0-FACC15?style=flat-square&labelColor=111111&logo=opensourceinitiative&logoColor=FACC15)](LICENSE)
[![Manifest](https://img.shields.io/badge/MANIFEST-V3-FACC15?style=flat-square&labelColor=111111&logo=googlechrome&logoColor=FACC15)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3/)
[![Release](https://img.shields.io/badge/RELEASE-V3-FACC15?style=flat-square&labelColor=111111&logo=semanticrelease&logoColor=FACC15)](https://github.com/herdodp/snapgent-connector/releases)
[![MCP](https://img.shields.io/badge/PROTOCOL-MCP-FACC15?style=flat-square&labelColor=111111&logo=modelcontextprotocol&logoColor=FACC15)](https://modelcontextprotocol.io/)

</div>

```console
herdo@snapgent:~$ snapgentV3

  ███████╗███╗   ██╗ █████╗ ██████╗  ██████╗ ███████╗███╗   ██╗████████╗
  ██╔════╝████╗  ██║██╔══██╗██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
  ███████╗██╔██╗ ██║███████║██████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║
  ╚════██║██║╚██╗██║██╔══██║██╔═══╝ ██║   ██║██╔══╝  ██║╚██╗██║   ██║
  ███████║██║ ╚████║██║  ██║██║     ╚██████╔╝███████╗██║ ╚████║   ██║
  ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝      ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝

  > browser extension + local bridge for Roblox Studio
  > no API key · no terminal · no copy-paste
```

snapgentV3 is a browser extension plus a local bridge that lets a normal AI chat **read, edit, run, and inspect your Roblox project** through Roblox Studio's built-in MCP server. Describe what you want in plain language — the extension forwards the AI's commands to the bridge on your computer, and the results go straight back into the chat.

**Free and open source — no API key, subscription, or sign-in required.** DeepSeek is the recommended provider. VS Code and other MCP servers can also be used as optional configured targets.

---

<table>
<tr>
<td width="33%" valign="top">

### 📖 Read & Edit
Read and update scripts in your Roblox place directly from an AI conversation.

</td>
<td width="33%" valign="top">

### ⚡ Build & Run
Run Luau, generate assets, and control play-testing in Roblox Studio.

</td>
<td width="33%" valign="top">

### 🔍 Inspect
Explore instances, inspect Studio state, and search your game from chat.

</td>
</tr>
</table>

---

## `01` &nbsp; How it works

```
┌─────────────┐     plain-text      ┌──────────────────┐    WebSocket    ┌────────────┐    MCP    ┌────────────────┐
│  AI chat    │ ───  commands  ───▶ │ snapgentV3       │ ──────────────▶ │  Bridge    │ ────────▶ │ Roblox Studio  │
│  (browser)  │ ◀──  results   ───  │ browser extension│ ◀────────────── │ (local)    │ ◀──────── │  + MCP         │
└─────────────┘                     └──────────────────┘                 └────────────┘           └────────────────┘
```

1. **You** describe a task in a supported AI chat.
2. The **AI** replies with a snapgentV3 command.
3. The **extension** detects the command and forwards it to the local bridge.
4. The **bridge** runs it against Roblox Studio through MCP.
5. The **result** is sent back into chat, and the AI continues working.

The MCP target selector can also connect to VS Code or another MCP server after it has been configured in the bridge. Roblox Studio is the built-in integration; VS Code is an optional MCP target.

---

## `02` &nbsp; Supported AI providers

| Provider | URL | Status | Notes |
|---|---|---|---|
| **DeepSeek** | `chat.deepseek.com` | ✅ Recommended | Best tool adherence |
| **ChatGPT** | `chatgpt.com` | ✅ Supported | Image input and screenshots are disabled |
| **Claude** | `claude.ai` | ✅ Supported | Image input and screenshots are disabled |
| **Google Gemini** | `gemini.google.com` | ✅ Supported | May stop using tools in long sessions |
| **Kimi** | `kimi.ai` | ✅ Supported | May use its native tools in some sessions |
| **GLM (Z.ai)** | `chat.z.ai` | ✅ Supported | |
| **Qwen** | `chat.qwen.ai` | ✅ Supported | |
| **Arena** | `arena.ai` | ✅ Supported | Use **Direct** mode |
| **Meta AI** | `meta.ai` | ✅ Supported | |
| **Ptero** | `ptero.pro` | ✅ Supported | |

> Provider activation is configured in `manifest.json` (`content_scripts` and `host_permissions`) and `PROVIDER_URLS` in `background.js`.

---

## `03` &nbsp; Requirements

- **Microsoft Edge** or **Google Chrome** (Manifest V3).
- **Roblox Studio** with its built-in MCP server enabled.
- **Windows** or **macOS** for the bridge.
- **Python 3.9+** on macOS. The Windows release includes the bridge executable.
- The bridge running while you use the agent.

---

## `04` &nbsp; Installation

**① Load the extension**

1. Download and extract the [latest release](https://github.com/herdodp/snapgent-connector/releases).
2. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `snapgent-extension` folder.
5. The snapgentV3 icon appears in your browser toolbar.

**② Enable Roblox Studio MCP**

1. Open a place in Roblox Studio.
2. Open **Assistant AI** from the top bar.
3. Select **…** → **Manage MCP Servers** → **Enable Studio as MCP Server**.

**③ Start the bridge**

- **Windows** — double-click `start.bat`.
- **macOS** — double-click `MacOS_Start.command`.

A window opens and stays open while the bridge runs. On macOS, the first launch may show a Gatekeeper warning; select **Done**, then allow the script under **System Settings → Privacy & Security**.

**④ Start a session**

1. Open a supported AI chat site and start a new chat.
2. Select **Roblox Studio** from the snapgentV3 MCP target menu.
3. Click **Start** and describe what you want to make.

---

## `05` &nbsp; Usage

Once a session is running, just talk to the AI normally:

> "Inspect the scripts in my place and tell me how the round system works."

> "Build a shop UI with buttons for the items in ReplicatedStorage."

The AI sends commands, snapgentV3 runs them in Studio, and the results appear in chat. You can give the AI another instruction at any time.

**Tips**

- Keep the bridge window open — closing it disconnects the agent.
- Choose **VS Code** or another configured MCP target from the bar when you want to use a server other than Roblox Studio.
- On **Arena**, use **Direct** mode.
- If **Gemini** or **Kimi** stops using tools in a long session, remind it to use the Roblox commands or start a new chat.

---

## `06` &nbsp; Architecture

The extension is split into a **provider-agnostic core** and **per-site providers**. The core talks to each AI site through the `ZSProvider` interface.

```
core/config.js              system prompt, feedback, tool categories
core/parser.js              snapgentV3 command parsing
core/main.js                agent loop, UI, session state
providers/<site>.js         site-specific selectors and chat integration
background.js               WebSocket connection to the local bridge
manifest.json               browser permissions and content scripts
```

The bridge connects to Roblox Studio's MCP server and can route commands to other configured MCP servers as well.

---

## `07` &nbsp; Project structure

```
snapgent-full/
├── snapgent-extension/        # Load this folder as an unpacked extension
│   ├── core/                  # Shared prompt, parser, agent loop, and UI
│   ├── providers/             # Per-AI-site integrations
│   ├── background.js          # Local bridge connection
│   ├── manifest.json          # Manifest V3 configuration
│   └── test-*.js              # Smoke tests
├── assets/                    # Project images
├── config.json                # Local MCP server configuration
├── start.bat                  # Windows bridge launcher
├── MacOS_Start.command        # macOS bridge launcher
├── bridge.exe                 # Windows local bridge
└── vscode_mcp.exe             # Optional VS Code MCP server
```

---

## `08` &nbsp; Development

Plain Node, no extra dependencies. Run from `snapgent-extension/`:

```bash
node test-parser.js
node test-chatgpt.js
node test-meta.js
```

Each test prints `PASS`/`FAIL` and exits with a non-zero status if a case fails.

**Notes**

- Keep site-specific DOM logic in `providers/`; the core should use `ZSProvider`.
- The bridge listens on local port **17613**.
- Provider URLs must stay in sync across `manifest.json` and `PROVIDER_URLS` in `background.js`.

---

## `09` &nbsp; Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| snapgentV3 bar is missing | Extension is disabled or site access is blocked | Check the extension is enabled and allowed on the current AI chat site, then reload the tab |
| Bridge is offline | Bridge is not running | Start `start.bat` (Windows) or `MacOS_Start.command` (macOS) |
| Studio is not ready | No place is open or Studio MCP is disabled | Open a place and enable **Studio as MCP Server** in Assistant settings |
| AI replies without using tools | Provider/model stopped following commands | Remind it to use snapgentV3 commands or start a new chat |
| VS Code does not appear as a target | Its MCP server has not been configured or connected | Configure the VS Code MCP server in the bridge, then reconnect |

---

## `10` &nbsp; Credits

- The idea of connecting additional MCP servers alongside Roblox Studio was inspired by [javnpa](https://github.com/javnpa).
- macOS/Linux support contributions by [archivealf](https://github.com/archivealf).

---

<div align="center">

**Built for creators who want to spend more time making.**

[Releases](https://github.com/herdodp/snapgent-connector/releases) · [Issues](https://github.com/herdodp/snapgent-connector/issues) · [License](LICENSE)

</div>

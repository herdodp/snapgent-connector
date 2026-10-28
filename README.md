<div align="center">

<a href="https://github.com/herdodp/snapgent-connector">
<img src="https://readme-typing-svg.demolab.com?font=JetBrains+Mono&weight=800&size=52&duration=3000&pause=1000&color=FACC15&center=true&vCenter=true&width=700&height=90&lines=snapgentV3;%3E+Connector+agent+VScode" alt="snapgentV3: Connector agent for VS Code" />
</a>

<p><b>Turn any AI chatbot browser to VS Code.</b></p>

[![License](https://img.shields.io/badge/LICENSE-GPL--3.0-FACC15?style=flat-square&labelColor=111111&logo=opensourceinitiative&logoColor=FACC15)](LICENSE)
[![Manifest](https://img.shields.io/badge/MANIFEST-V3-FACC15?style=flat-square&labelColor=111111&logo=googlechrome&logoColor=FACC15)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3/)
[![Release](https://img.shields.io/badge/RELEASE-V3.3-FACC15?style=flat-square&labelColor=111111&logo=semanticrelease&logoColor=FACC15)](https://github.com/herdodp/snapgent-connector/releases/tag/V3.3)
[![MCP](https://img.shields.io/badge/PROTOCOL-MCP-FACC15?style=flat-square&labelColor=111111&logo=modelcontextprotocol&logoColor=FACC15)](https://modelcontextprotocol.io/)

</div>

```console

  ███████╗███╗   ██╗ █████╗ ██████╗  ██████╗ ███████╗███╗   ██╗████████╗
  ██╔════╝████╗  ██║██╔══██╗██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝
  ███████╗██╔██╗ ██║███████║██████╔╝██║  ███╗█████╗  ██╔██╗ ██║   ██║
  ╚════██║██║╚██╗██║██╔══██║██╔═══╝ ██║   ██║██╔══╝  ██║╚██╗██║   ██║
  ███████║██║ ╚████║██║  ██║██║     ╚██████╔╝███████╗██║ ╚████║   ██║
  ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝      ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝

  > browser extension + local bridge for VS Code and MCP
  > no API key · no terminal · no copy-paste
```

snapgentV3 is a browser extension plus a local bridge that connects a normal AI chat to **VS Code**. It automatically uses the currently open workspace. Describe what you want in plain language — the extension forwards commands to the selected server through the local bridge, and returns the results to chat.

**Free and open source — no API key, subscription, or sign-in required.** snapgentV3 automatically uses the currently open VS Code workspace.

---

- **Installation:** [Watch Installation Video](https://youtu.be/eo3sdtPSBso)
- **Demo:** [Watch Demo Video](https://youtu.be/HY0YWsHLp34)

<table>
<tr>
<td width="100%" valign="top">

### 💻 VS Code
The default target. Automatically connects to the workspace currently open in VS Code.

</td>
</tr>
</table>

---

## `01` &nbsp; How it works

```
┌─────────────┐     plain-text      ┌──────────────────┐    WebSocket    ┌────────────┐    MCP    ┌────────────────┐
│  AI chat    │ ───  commands  ───▶ │ snapgentV3       │ ──────────────▶ │  Bridge    │ ────────▶ │ Selected MCP   │
│  (browser)  │ ◀──  results   ───  │ browser extension│ ◀────────────── │ (local)    │ ◀──────── │ target         │
└─────────────┘                     └──────────────────┘                 └────────────┘           └────────────────┘
```

1. **You** describe a task in a supported AI chat.
2. The **AI** replies with a snapgentV3 command.
3. The **extension** detects the command and forwards it to the local bridge.
4. The **bridge** routes it to the VS Code MCP server.
5. The **result** is sent back into chat, and the AI continues working.

VS Code's MCP server is configured locally by `start.bat`; it detects the open VS Code workspace automatically.

---

## `02` &nbsp; Supported AI providers

| Provider | URL | Status | Notes |
|---|---|---|---|
| **ChatGPT** | `chatgpt.com` | ✅ Supported | Image input and screenshots are disabled |
| **Claude** | `claude.ai` | ✅ Supported | Image input and screenshots are disabled |
| **Google Gemini** | `gemini.google.com` | ✅ Supported | May stop using tools in long sessions |
| **Kimi** | `kimi.ai` | ✅ Supported | May use its native tools in some sessions |
| **Grok** | `grok.com` | ✅ Supported | Requires signing in to xAI |
| **GLM (Z.ai)** | `chat.z.ai` | ✅ Supported | |
| **Qwen** | `chat.qwen.ai` | ✅ Supported | |
| **Arena** | `arena.ai` | ✅ Supported | Use **Direct** mode |
| **Meta AI** | `meta.ai` | ✅ Supported | |
| **Ptero** | `ptero.pro` | ✅ Supported | |

> Provider activation is configured in `manifest.json` (`content_scripts` and `host_permissions`) and `PROVIDER_URLS` in `background.js`.

---

## `03` &nbsp; Requirements

- **Microsoft Edge** or **Google Chrome** (Manifest V3).
- **VS Code** for the default target. Keep the workspace you want to use open in VS Code.
- **Windows**, **macOS**, or **Linux** for the bridge.
- **Python 3.9+** on macOS and Linux. Windows includes the bridge executable.
- The bridge running while you use the agent.

---

## `04` &nbsp; Installation

**① Load the extension**

1. Download and extract the [latest SnapgentV3 release](https://github.com/herdodp/snapgent-connector/releases/tag/V3.3).
2. Open `edge://extensions` (Edge) or `chrome://extensions` (Chrome).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `snapgent-extension` folder.
5. The snapgentV3 icon appears in your browser toolbar.

**② Set up the MCP target**

For VS Code, open the project folder you want to work on before clicking **Start** in the chat bar. The bridge can be started before VS Code; the agent waits until a workspace is available and does not fall back to the Snapgent release folder.

**③ Start the bridge**

- **Windows** — double-click `start.bat`. It configures VS Code MCP automatically.
  You can start the bridge before VS Code.
  Machine-specific settings are written to the ignored local `config.json`.
- **macOS** — double-click `MacOS_Start.command`. It detects the bundled
  VS Code MCP server, Roblox Studio's MCP executable, and an installed
  EffectCraft CLI, then writes their machine-specific paths to the ignored
  local `config.json`. This launcher uses `bridge.py`; it does not run the
  Windows-only `bridge.exe`.
- **Linux** — open a terminal in the extracted release folder and run
  `bash Linux_Start.sh`. It detects the bundled VS Code MCP server and
  installed EffectCraft CLI, then writes
  machine-specific paths to the ignored local `config.json`. It uses
  `bridge.py`; the first launch installs `websockets` for your user, or creates
  a local Python environment if your distribution blocks user installs.

Keep the terminal window open while the bridge runs. On macOS, the first
launch may show a Gatekeeper warning; select **Done**, then allow the script
under **System Settings → Privacy & Security**.

**Optional: connect EffectCraft**

On Windows, `start.bat` detects EffectCraft in common install locations and
starts its control channel automatically. On macOS, install the separate
EffectCraft CLI release and put `effectcraft-cli` on your `PATH`; the launcher
detects it and starts the app's control channel when EffectCraft is installed
in `/Applications` or `~/Applications`. On Linux, install the EffectCraft CLI
and put `effectcraft-cli` on your `PATH`; the launcher detects it and starts
EffectCraft when its executable is available on `PATH` or in a common
installation location. On any system, save your work and close EffectCraft
before restarting the launcher if EffectCraft is already open without the
control channel. When the bridge connects, choose
**EffectCraft** in the MCP target selector on the chat bar.

On macOS, Roblox Studio MCP is detected at
`/Applications/RobloxStudio.app/Contents/MacOS/StudioMCP`; set
`ZS_STUDIO_MCP_PATH` before launching if it is installed elsewhere.
Linux does not auto-detect Roblox Studio MCP. If you have a compatible Linux
MCP executable, set `ZS_STUDIO_MCP_PATH` to its path before running the
launcher; Roblox Studio itself may not be available on your Linux distribution.

**④ Start a session**

1. Open a supported AI chat site and start a new chat.
2. Open a project folder in VS Code before clicking **Start**.
3. Click **Start** and describe what you want to make.

---

## `05` &nbsp; Usage

Once a session is running, just talk to the AI normally:

> "Inspect the files in my project and explain how the login flow works."

> "Add a search bar to the books page and wire it to the existing API."

The AI sends commands, snapgentV3 runs them in the selected target (VS Code by default), and the results appear in chat. You can give the AI another instruction at any time.

**Tips**

- Keep the bridge window open — closing it disconnects the agent.
- Keep your intended project open in VS Code; it is the default MCP target.
- On **Arena**, use **Direct** mode.
- If **Gemini** or **Kimi** stops using tools in a long session, remind it to use the snapgentV3 commands or start a new chat.

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

The bridge routes commands to the configured MCP servers. Windows uses the
bundled `bridge.exe`; macOS and Linux run the cross-platform `bridge.py` with
Python.

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
├── setup-config.ps1           # Configures Windows MCP servers
├── setup-config.py            # Detects MCP servers on macOS and Linux
├── config.json                # Generated locally by launchers (not tracked)
├── start.bat                  # Windows bridge launcher
├── MacOS_Start.command        # macOS bridge launcher
├── Linux_Start.sh             # Linux bridge launcher
├── bridge.exe                 # Windows local bridge
├── bridge.py                  # Cross-platform Python MCP bridge
├── vscode_mcp.exe             # Default VS Code MCP server (24 workspace tools)
├── vscode_mcp.py              # VS Code MCP server source
├── test_bridge.py             # MCP bridge protocol tests
├── test_setup_config.py       # MCP setup helper tests
└── vscode_mcp.spec            # PyInstaller build recipe
```

---

## `08` &nbsp; Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| snapgentV3 bar is missing | Extension is disabled or site access is blocked | Check the extension is enabled and allowed on the current AI chat site, then reload the tab |
| Bridge is offline | Bridge is not running | Start `start.bat` (Windows), `MacOS_Start.command` (macOS), or run `bash Linux_Start.sh` (Linux) |
| AI replies without using tools | Provider/model stopped following commands | Remind it to use snapgentV3 commands or start a new chat |
| VS Code target is unavailable | The bridge is offline or the release is incomplete | Run `start.bat` from the extracted release folder and keep the project open in VS Code |

---

<div align="center">

**Built for creators who want to spend more time making.**

[Latest release V3.3](https://github.com/herdodp/snapgent-connector/releases/tag/V3.3) · [Issues](https://github.com/herdodp/snapgent-connector/issues) · [License](LICENSE)

</div>

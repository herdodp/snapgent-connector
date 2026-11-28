# FilmCraft guide MCP server for Snapgent (Windows).
#
# A tiny stdio MCP server that ships the FilmCraft driving playbook to the AI
# agent and live-probes whether the FilmCraft MCP entry is attached to the
# running desktop app (bridge mode) or editing a separate headless project.
# Built into Windows PowerShell; no dependencies beyond the connector folder.

$ErrorActionPreference = "Stop"

$script:Root = Split-Path -Parent $MyInvocation.MyCommand.Path

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
    # Keep going with the default encoding.
}

function Send-McpReply {
    param([object]$Payload)
    [Console]::Out.WriteLine(($Payload | ConvertTo-Json -Compress -Depth 12))
    [Console]::Out.Flush()
}

function Send-McpResult {
    param($RequestId, [object]$Result)
    Send-McpReply @{ jsonrpc = "2.0"; id = $RequestId; result = $Result }
}

function Send-McpError {
    param($RequestId, [int]$Code, [string]$Message)
    Send-McpReply @{ jsonrpc = "2.0"; id = $RequestId; error = @{ code = $Code; message = $Message } }
}

function New-ToolText {
    param([string]$Text, [switch]$IsError)
    $content = @(@{ type = "text"; text = $Text })
    if ($IsError) {
        return @{ content = $content; isError = $true }
    }
    return @{ content = $content }
}

$script:Topics = @{
    overview = @(
        "FilmCraft (ArtCraft) is a full non-linear video editor in which EVERY menu item, button, slider and drag is an engine command with an id and typed parameters (650+ commands). The MCP entry exposes them, so you can cut, trim, grade, mix and export exactly the way a person does.",
        "Golden rules:",
        "1. Inspect before you edit (doc_inspect / sequence_inspect).",
        "2. Verify after you edit (render_frame / ui_screenshot) and look at the image.",
        "3. Wrong result? edit.undo, adjust, retry.",
        "4. First thing in a session: call this tool with topic `"status`" to confirm you are attached to the real app (bridge mode), not a headless empty project."
    ) -join "`n"
    tools = @(
        "FilmCraft MCP tools (from the filmcraft server, not this guide):",
        "Both modes:",
        "- command_list {filter?, enabled_only?} - every command: id, label, menu, shortcut, params, enabled now",
        "- command_run {id, params} - run one command; edits are undoable",
        "- command_batch {steps:[{id,params}...], stop_on_error?} -> {completed, failed, results}",
        "- doc_inspect - project tree + active sequence in one call",
        "- project_inspect - bins and items with ids, types, durations",
        "- sequence_inspect - tracks, clips (start/end, sourceIn/sourceOut, speed, reverse, gainDb), effects, transitions, markers, playhead, selection",
        "- media_import {paths:[abs paths], bin?, image_sequence?} - import files",
        "- render_frame {seconds} / render_preview - PNG of the program frame (read-only)",
        "Bridge mode only (drive the real window):",
        "- ui_inspect - tool, workspace, panels, zoom, playback, fps",
        "- ui_elements {prefix?} - on-screen elements with id, label, rect",
        "- ui_click {id | x,y, button?, count?, modifiers?}",
        "- ui_drag - press-move-release between points or element ids",
        "- ui_key {key} - 'Space', 'Cmd+K', 'Shift+Delete'",
        "- ui_type {text} - type into the focused field",
        "- ui_screenshot {panel?} - PNG of the window or one panel",
        "- ui_control - call any control-channel method directly (ui.set, ui.scroll, ui.timeline.locate, ...)"
    ) -join "`n"
    loop = @(
        "The typical editing loop:",
        "1. doc_inspect or sequence_inspect -> learn ids (bins, items, clips, tracks, markers).",
        "2. command_list {filter:`"keyword`"} -> exact command ids, params, enabled state.",
        "3. command_run {id, params} (or command_batch for several steps).",
        "4. render_frame {seconds} or ui_screenshot -> LOOK at the image.",
        "5. Wrong? edit.undo, adjust, retry.",
        "Selection: a command that works on the selection is disabled until something is selected, UNLESS the call names its targets: {`"clips`":[12]} for timeline clips, {`"item`":4} for project items (e.g. clip.replaceFromBin). Other conditions still apply."
    ) -join "`n"
    commands = @(
        "Command discovery and time:",
        "- NEVER guess command ids. command_list {filter:`"razor`"} or {filter:`"export`"} returns id, label, menu, shortcut, params and whether it is enabled right now.",
        "- command_batch {steps:[{id,params}...], stop_on_error:true} runs steps in order and returns {completed, failed, results}; a failing step is an isError result with the engine's message.",
        "- Time: commands accept seconds, frame or timecode; the engine's internal unit is ticks (254016000000 per second, exact for every common frame rate).",
        "- Tracks: name them `"V1`", `"A2`", ... Naming a track the sequence does not have is an invalid-parameters error, never a silent fallback."
    ) -join "`n"
    media = @(
        "Media recipes:",
        "- Import: media_import {paths:[`"C:/abs/clip.mp4`", ...]} (bin optional, image_sequence for numbered stills).",
        "- Place: timeline.place puts a bin item on the timeline; track is where the picture goes, audioTrack where the sound goes; the clip snaps to the frame grid.",
        "- Move: timeline.move takes linked audio along (pass `"linked`":false to move only the listed clips); returns {moved:[ids]}.",
        "- Before exporting check media.status or media.findMissing: offline media renders a 'media not found' placeholder instead of failing silently."
    ) -join "`n"
    effects = @(
        "Effects recipes:",
        "- Apply: effects.apply {effect:`"Gaussian Blur`"}.",
        "- Parameters: effects.setParam returns {keyframes, param, value}; keyframes 0 = a successful STATIC edit, not a failure. A choice by name comes back as its numeric option index (e.g. blend `"Screen`" -> 8).",
        "- Keyframes: effects.addKeyframe TOGGLES ({added:true|false, mediaTime}); effects.deleteKeyframe returns {removed:true|false}. An explicit time keeps its place even outside the clip."
    ) -join "`n"
    export = @(
        "Export recipes:",
        "- file.exportMedia with wait:true blocks until the file is written (progress via MCP progress notifications, cancellable). Without wait it returns {job, path, poll:`"jobs.list`", cancel:`"jobs.cancel`"} at once.",
        "- Poll jobs.list: progress, etaSeconds, finished, result. Stop with jobs.cancel (partial output is deleted).",
        "- The result carries offlineMedia (items rendered as placeholders) and warnings (e.g. 'range covers one frame, use range:`"entire`"'; hardware encoding declined). Read them.",
        "- Image sequences never write the given path: a.png becomes a000.png, a001.png, ...; result adds lastPath and basePath.",
        "- export.queue.add / export.queue.list manage the export queue. export.quick for a quick render. Markers for review: markers.exportCsv {path}."
    ) -join "`n"
    ui = @(
        "UI automation (bridge mode only) - use when the command surface is not enough:",
        "1. ui_elements {prefix:`"tools.`"} -> ids, labels, rects (ids come from the latest frame; after a layout change retry).",
        "2. ui_click {id} or {x,y}, ui_drag, ui_key {key:`"Space`"|`"Cmd+K`"}, ui_type {text}.",
        "3. ui_screenshot {panel:`"Timeline`"} to SEE the panel.",
        "4. ui_control calls any control-channel method directly: ui.set, ui.scroll, ui.timeline.locate, ui.elements, ui.click, ui.key, ui.screenshot, ui.inspect.",
        "engine.execute also runs UI-only commands (tool.razor, playback.toggle, window.workspace.color, window.panel.<name>)."
    ) -join "`n"
    troubleshooting = @(
        "Troubleshooting:",
        "- HEADLESS means the filmcraft MCP entry runs 'mcp' without --bridge: the AI edits a SEPARATE empty in-process project and nothing happens in the app window. Fix: close FilmCraft, run Open-FilmCraft-for-Snapgent.bat, confirm topic `"status`" says BRIDGE.",
        "- If the app is already open WITHOUT a control channel, it will not be restarted. Save your work, close it, then run the launcher.",
        "- Token errors ('invalid token' from the control channel): the stored FILMCRAFT_CONTROL_TOKEN does not match the running app. Restart via the launcher.",
        "- Tools error 'not available in headless mode': ui_* tools need bridge mode.",
        "- Offline media at export: check media.status / media.findMissing; fix or remount the media folder, or re-import from the real paths.",
        "- Long exports feel stuck: they are jobs - poll jobs.list for progress and etaSeconds."
    ) -join "`n"
}

$script:TopicList = ($script:Topics.Keys | Sort-Object) -join ", "

$script:ToolDefinition = @{
    name = "filmcraft_guide"
    title = "FilmCraft driving guide"
    description = "How to fully drive the FilmCraft video editor through MCP: tool surface, the inspect-edit-verify loop, command discovery, media/timeline/effects/export recipes, UI automation and live bridge-vs-headless status. Call topic:`"status`" first in a session to confirm the running app is attached."
    inputSchema = @{
        type = "object"
        properties = @{
            topic = @{ type = "string"; description = "Guide section to read. Omit for the quickstart (overview + tools + loop)." }
        }
        additionalProperties = $false
    }
    annotations = @{
        readOnlyHint = $true
        destructiveHint = $false
        idempotentHint = $true
        openWorldHint = $false
    }
}

function Get-BridgeTarget {
    param([string[]]$Arguments)
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        if ($Arguments[$i] -eq "--bridge" -and ($i + 1) -lt $Arguments.Count) {
            return [string]$Arguments[$i + 1]
        }
        if ($Arguments[$i].StartsWith("--bridge=")) {
            return $Arguments[$i].Substring(9)
        }
    }
    return $null
}

function Invoke-ControlProbe {
    param([string]$TargetHost, [int]$Port, [string]$Token)
    $request = @{ id = 1; token = $Token; method = "ui.inspect"; params = @{} } | ConvertTo-Json -Compress -Depth 4
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connect = $client.BeginConnect($TargetHost, $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(3000)) {
            return @{ Ok = $false; Error = "control channel unreachable on ${TargetHost}:${Port} (timeout)" }
        }
        $client.EndConnect($connect)
        $client.ReceiveTimeout = 3000
        $client.SendTimeout = 3000
        $stream = $client.GetStream()
        $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
        $writer.NewLine = "`n"
        $writer.WriteLine($request)
        $writer.Flush()
        $reader = New-Object System.IO.StreamReader($stream)
        $line = $reader.ReadLine()
        if (-not $line) {
            return @{ Ok = $false; Error = "control channel on ${TargetHost}:${Port} closed without a reply" }
        }
        try {
            $reply = $line | ConvertFrom-Json
        } catch {
            return @{ Ok = $false; Error = "control channel on ${TargetHost}:${Port} sent a non-JSON reply" }
        }
        if ($reply.ok -eq $true) {
            return @{ Ok = $true }
        }
        $detail = [string]$reply.error
        if (-not $detail) { $detail = $line }
        return @{ Ok = $false; Error = $detail }
    } catch {
        return @{ Ok = $false; Error = "control channel unreachable on ${TargetHost}:${Port}: $($_.Exception.Message)" }
    } finally {
        $client.Dispose()
    }
}

function Get-StatusReport {
    $configPath = Join-Path $script:Root "config.json"
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        return "STATUS: UNKNOWN - no config.json next to this script.`nRun the Snapgent setup (start.bat or the Open FilmCraft launcher) first."
    }
    try {
        $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    } catch {
        return "STATUS: UNKNOWN - config.json could not be read: $($_.Exception.Message)"
    }
    $server = $null
    if ($configuration.mcpServers -and $configuration.mcpServers.PSObject.Properties["filmcraft"]) {
        $server = $configuration.mcpServers.filmcraft
    }
    if (-not $server) {
        return "STATUS: NOT CONFIGURED - config.json has no mcpServers.filmcraft entry.`nInstall FilmCraft, then run the Snapgent setup so the connector detects it."
    }
    $argumentList = @()
    if ($server.args) { $argumentList = @($server.args | ForEach-Object { [string]$_ }) }
    $target = Get-BridgeTarget -Arguments $argumentList
    $token = ""
    if ($server.env -and $server.env.PSObject.Properties["FILMCRAFT_CONTROL_TOKEN"]) {
        $token = [string]$server.env.FILMCRAFT_CONTROL_TOKEN
    }
    $lines = @("FilmCraft CLI: $($server.command)")
    if (-not $target) {
        $lines += "MODE: HEADLESS - the AI edits a SEPARATE empty project, NOT the FilmCraft window."
        $lines += "Fix: close FilmCraft and run Open-FilmCraft-for-Snapgent.bat, then call this status again."
        return ($lines -join "`n")
    }
    $lines += "MODE: BRIDGE -> $target"
    if (-not $token) {
        $lines += "PROBE: FAILED - no FILMCRAFT_CONTROL_TOKEN stored in the filmcraft env block."
        return ($lines -join "`n")
    }
    $parts = $target.Split(":")
    $hostName = $parts[0]
    if (-not $hostName) { $hostName = "127.0.0.1" }
    $port = 0
    if (-not [int]::TryParse($parts[-1], [ref]$port)) {
        $lines += "MODE: BRIDGE configured, but the target is unparseable: $target"
        return ($lines -join "`n")
    }
    $probe = Invoke-ControlProbe -TargetHost $hostName -Port $port -Token $token
    if ($probe.Ok) {
        $lines += "PROBE: ATTACHED - the control channel answered with the stored token. The AI drives the real running app: full command surface + UI tools."
    } else {
        $lines += "PROBE: FAILED - $($probe.Error)"
        $lines += "The app is probably not running with this control channel/token. Save your work, close FilmCraft, run the Open FilmCraft launcher, then retry."
    }
    return ($lines -join "`n")
}

function Get-GuideText {
    param([string]$Topic)
    if (-not $Topic) {
        $text = @($script:Topics.overview, $script:Topics.tools, $script:Topics.loop) -join "`n`n"
        $text += "`n`nFurther topics: $($script:TopicList)."
        return New-ToolText -Text $text
    }
    if (-not $script:Topics.ContainsKey($Topic)) {
        return (New-ToolText -Text "Unknown topic `"$Topic`". Available topics: $($script:TopicList)." -IsError)
    }
    if ($Topic -eq "status") {
        return (New-ToolText -Text (Get-StatusReport))
    }
    return (New-ToolText -Text ([string]$script:Topics[$Topic]))
}

function Invoke-McpRequest {
    param([object]$Request)
    $method = [string]$Request.method
    $hasId = $Request.PSObject.Properties["id"] -and $null -ne $Request.id
    if (-not $hasId) {
        return  # notification: never reply
    }
    $requestId = $Request.id
    if ($method -eq "initialize") {
        $version = "2024-11-05"
        if ($Request.params -and $Request.params.protocolVersion) {
            $version = [string]$Request.params.protocolVersion
        }
        Send-McpResult -RequestId $requestId -Result @{
            protocolVersion = $version
            capabilities = @{ tools = @{} }
            serverInfo = @{ name = "filmcraft-guide"; version = "1.0.0" }
        }
    } elseif ($method -eq "ping") {
        Send-McpResult -RequestId $requestId -Result @{}
    } elseif ($method -eq "tools/list") {
        Send-McpResult -RequestId $requestId -Result @{ tools = @($script:ToolDefinition) }
    } elseif ($method -eq "tools/call") {
        $name = [string]$Request.params.name
        if ($name -ne "filmcraft_guide") {
            Send-McpError -RequestId $requestId -Code -32602 -Message "Unknown tool: $name"
            return
        }
        $arguments = $Request.params.arguments
        $topic = $null
        if ($arguments -and $arguments.PSObject.Properties["topic"]) {
            $topic = [string]$arguments.topic
        }
        Send-McpResult -RequestId $requestId -Result (Get-GuideText -Topic $topic)
    } else {
        Send-McpError -RequestId $requestId -Code -32601 -Message "Method not found: $method"
    }
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    try {
        $request = $line | ConvertFrom-Json
    } catch {
        Send-McpError -RequestId $null -Code -32700 -Message "Parse error"
        continue
    }
    if ($null -eq $request) { continue }
    Invoke-McpRequest -Request $request
}

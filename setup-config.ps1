param(
    [string]$RobloxVersionsPath = (Join-Path $env:LOCALAPPDATA "Roblox\Versions"),
    [string]$ConfigPath = (Join-Path $PSScriptRoot "config.json")
)

$ErrorActionPreference = "Stop"

function Set-ConfigProperty {
    param(
        [System.Management.Automation.PSObject]$Object,
        [string]$Name,
        [object]$Value
    )

    if ($Object.PSObject.Properties[$Name]) {
        $Object.$Name = $Value
    }
    else {
        $Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value
    }
}

$vscodeMcp = Join-Path $PSScriptRoot "vscode_mcp.exe"
if (-not (Test-Path -LiteralPath $vscodeMcp -PathType Leaf)) {
    throw "VS Code MCP was not found at '$vscodeMcp'. Extract the whole release, then run start.bat again."
}

$studioMcp = Get-ChildItem -Path (Join-Path $RobloxVersionsPath "version-*\StudioMCP.exe") -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (Test-Path -LiteralPath $ConfigPath) {
    try {
        $configuration = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    }
    catch {
        throw "Could not read '$ConfigPath' as JSON. Fix or remove this local configuration, then run start.bat again. $($_.Exception.Message)"
    }

    if (-not $configuration -or $configuration -isnot [System.Management.Automation.PSCustomObject]) {
        throw "'$ConfigPath' must contain a JSON object."
    }

    if (-not $configuration.PSObject.Properties["mcpServers"]) {
        $configuration | Add-Member -MemberType NoteProperty -Name mcpServers -Value ([pscustomobject]@{})
    }

    if ($configuration.mcpServers -isnot [System.Management.Automation.PSCustomObject]) {
        throw "'$ConfigPath' must contain an object named 'mcpServers'."
    }
}
else {
    $configuration = [pscustomobject]@{
        mcpServers = [pscustomobject]@{}
    }
}

$vscodeServer = $configuration.mcpServers.vscode
if (-not $vscodeServer) {
    $vscodeServer = [pscustomobject]@{}
    $configuration.mcpServers | Add-Member -MemberType NoteProperty -Name vscode -Value $vscodeServer
}

if ($vscodeServer -isnot [System.Management.Automation.PSCustomObject]) {
    throw "'$ConfigPath' must contain an object named 'mcpServers.vscode'."
}

$configuredCommand = $vscodeServer.command
$usesBundledVscode = [string]::IsNullOrWhiteSpace($configuredCommand) -or
    [System.IO.Path]::GetFileName($configuredCommand) -ieq "vscode_mcp.exe"
if ($usesBundledVscode) {
    Set-ConfigProperty -Object $vscodeServer -Name "command" -Value $vscodeMcp
    Set-ConfigProperty -Object $vscodeServer -Name "args" -Value @()
    if ($vscodeServer.PSObject.Properties["env"]) {
        if ($vscodeServer.env -isnot [System.Management.Automation.PSCustomObject]) {
            throw "'$ConfigPath' must contain an object named 'mcpServers.vscode.env'."
        }
    }
    else {
        Set-ConfigProperty -Object $vscodeServer -Name "env" -Value ([pscustomobject]@{})
    }
    if ($vscodeServer.env.PSObject.Properties["VSCODE_WORKSPACE_PATH"]) {
        $vscodeServer.env.PSObject.Properties.Remove("VSCODE_WORKSPACE_PATH")
    }
}

if ($studioMcp) {
    $robloxServer = [pscustomobject]@{
        command = $studioMcp.FullName
        args = @("--stdio")
    }

    if ($configuration.mcpServers.PSObject.Properties["roblox"]) {
        $configuration.mcpServers.roblox = $robloxServer
    }
    else {
        $configuration.mcpServers | Add-Member -MemberType NoteProperty -Name roblox -Value $robloxServer
    }
}
elseif ($configuration.mcpServers.PSObject.Properties["roblox"] -and
    [System.IO.Path]::GetFileName($configuration.mcpServers.roblox.command) -ieq "StudioMCP.exe") {
    $configuration.mcpServers.PSObject.Properties.Remove("roblox")
}

$effectcraftCandidates = @()
$configuredEffectCraft = $configuration.mcpServers.effectcraft
if ($configuredEffectCraft -and -not [string]::IsNullOrWhiteSpace($configuredEffectCraft.command)) {
    $effectcraftCandidates += $configuredEffectCraft.command
}

$programFilesX86 = [Environment]::GetFolderPath("ProgramFilesX86")
$effectcraftCandidates += @(
    (Join-Path $env:LOCALAPPDATA "Programs\ArtCraft\EffectCraft\effectcraft-cli.exe"),
    (Join-Path $env:ProgramFiles "ArtCraft\EffectCraft\effectcraft-cli.exe"),
    (Join-Path $programFilesX86 "ArtCraft\EffectCraft\effectcraft-cli.exe"),
    (Join-Path $env:ProgramFiles "EffectCraft\effectcraft-cli.exe"),
    (Join-Path $programFilesX86 "EffectCraft\effectcraft-cli.exe")
)

$uninstallKeys = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
foreach ($key in $uninstallKeys) {
    $installations = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like "*EffectCraft*" -and $_.InstallLocation }
    foreach ($installation in $installations) {
        $effectcraftCandidates += Join-Path $installation.InstallLocation "effectcraft-cli.exe"
        $effectcraftCandidates += Join-Path $installation.InstallLocation "EffectCraft\effectcraft-cli.exe"
    }
}

$effectcraftCli = $effectcraftCandidates |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1

if ($effectcraftCli) {
    $effectcraftServer = [pscustomobject]@{
        command = $effectcraftCli
        args = @("mcp", "--bridge", "9877")
        env = [pscustomobject]@{}
    }
    if ($configuration.mcpServers.PSObject.Properties["effectcraft"]) {
        $configuration.mcpServers.effectcraft = $effectcraftServer
    }
    else {
        $configuration.mcpServers | Add-Member -MemberType NoteProperty -Name effectcraft -Value $effectcraftServer
    }
    Write-Host "EffectCraft MCP detected: $effectcraftCli"
}
elseif ($configuredEffectCraft) {
    Write-Host "Configured EffectCraft MCP executable was not found: $($configuredEffectCraft.command)"
    Write-Host "Update mcpServers.effectcraft.command in config.json to match your installation."
    if ([System.IO.Path]::GetFileName([string]$configuredEffectCraft.command) -ieq "effectcraft-cli.exe") {
        $configuration.mcpServers.PSObject.Properties.Remove("effectcraft")
        Write-Host "Removed the stale auto-detected EffectCraft MCP entry."
    }
}
else {
    Write-Host "EffectCraft not found; VS Code and Roblox MCP remain available."
}

$configuredFigCraft = $configuration.mcpServers.figcraft
$figcraftCandidates = @()
if ($configuredFigCraft -and -not [string]::IsNullOrWhiteSpace($configuredFigCraft.command)) {
    $figcraftCandidates += $configuredFigCraft.command
}

$figcraftOnPath = Get-Command figcraft-cli.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($figcraftOnPath) {
    $figcraftCandidates += $figcraftOnPath.Source
}

$figcraftCandidates += @(
    (Join-Path $env:LOCALAPPDATA "Programs\ArtCraft\FigCraft\figcraft-cli.exe"),
    (Join-Path $env:ProgramFiles "ArtCraft\FigCraft\figcraft-cli.exe"),
    (Join-Path $programFilesX86 "ArtCraft\FigCraft\figcraft-cli.exe"),
    (Join-Path $env:ProgramFiles "FigCraft\figcraft-cli.exe"),
    (Join-Path $programFilesX86 "FigCraft\figcraft-cli.exe")
)

foreach ($key in $uninstallKeys) {
    $installations = Get-ItemProperty -Path $key -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -like "*FigCraft*" -and $_.InstallLocation }
    foreach ($installation in $installations) {
        $figcraftCandidates += Join-Path $installation.InstallLocation "figcraft-cli.exe"
        $figcraftCandidates += Join-Path $installation.InstallLocation "FigCraft\figcraft-cli.exe"
    }
}

$figcraftCli = $figcraftCandidates |
    Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) } |
    Select-Object -First 1

if ($figcraftCli) {
    $keepFigCraft = $configuredFigCraft -and ($configuredFigCraft.command -eq $figcraftCli)
    if (-not $keepFigCraft) {
        $figcraftServer = [pscustomobject]@{
            command = $figcraftCli
            args = @("mcp")
            env = [pscustomobject]@{}
        }
        if ($configuration.mcpServers.PSObject.Properties["figcraft"]) {
            $configuration.mcpServers.figcraft = $figcraftServer
        }
        else {
            $configuration.mcpServers | Add-Member -MemberType NoteProperty -Name figcraft -Value $figcraftServer
        }
    }
    Write-Host "FigCraft MCP detected: $figcraftCli"
}
elseif ($configuredFigCraft) {
    Write-Host "Configured FigCraft MCP executable was not found: $($configuredFigCraft.command)"
    Write-Host "Update mcpServers.figcraft.command in config.json to match your installation."
}
else {
    Write-Host "FigCraft not found; install it from https://github.com/storytold/figcraft/releases to enable its MCP."
}

function Test-ReaNodeVersion {
    param([string]$NodePath)
    try { $raw = (& $NodePath --version) } catch { return $false }
    if (-not ($raw -match '^v(\d+)\.(\d+)\.(\d+)')) { return $false }
    $major = [int]$Matches[1]
    $version = [version]('{0}.{1}.{2}' -f $Matches[1], $Matches[2], $Matches[3])
    if ($major -eq 22) { return $version -ge [version]'22.23.4' }
    if ($major -eq 24) { return $version -ge [version]'24.22.1' }
    return $version -ge [version]'26.12.1'
}

$reaNode = Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1
$reaScript = $null
if ($reaNode) {
    $reaCandidates = @()
    if ($env:APPDATA) { $reaCandidates += Join-Path $env:APPDATA 'npm\node_modules\rea-agents\scripts\rea.mjs' }
    $reaCandidates += Join-Path (Split-Path $reaNode.Source -Parent) 'node_modules\rea-agents\scripts\rea.mjs'
    $reaScript = $reaCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}

if ($reaNode -and $reaScript -and (Test-ReaNodeVersion $reaNode.Source)) {
    $reaServer = [pscustomobject]@{
        command = $reaNode.Source
        args = @($reaScript, '--mcp')
        env = [pscustomobject]@{}
    }
    if ($configuration.mcpServers.PSObject.Properties['rea']) {
        $configuration.mcpServers.rea = $reaServer
    }
    else {
        $configuration.mcpServers | Add-Member -MemberType NoteProperty -Name rea -Value $reaServer
    }
    Write-Host "REA MCP detected: $reaScript"
}
elseif ($reaNode -and $reaScript) {
    Write-Host "REA found but Node.js is too old (need 22.23.4+, 24.22.1+ or 26.12.1+); REA MCP not configured."
}
else {
    Write-Host "REA not found; install it with: npm install --global rea-agents"
}

$wordUvx = Get-Command uvx.exe -ErrorAction SilentlyContinue | Select-Object -First 1
if ($wordUvx) {
    $wordServer = [pscustomobject]@{
        command = $wordUvx.Source
        args = @('--from', 'office-word-mcp-server', 'word_mcp_server')
        env = [pscustomobject]@{}
    }
    if ($configuration.mcpServers.PSObject.Properties['word']) {
        $configuration.mcpServers.word = $wordServer
    }
    else {
        $configuration.mcpServers | Add-Member -MemberType NoteProperty -Name word -Value $wordServer
    }
    Write-Host "Word MCP detected (uvx): $($wordUvx.Source)"
}
else {
    Write-Host "uv not found; Word MCP not configured. Install uv from https://docs.astral.sh/uv/ and run this script again."
}

$json = ConvertTo-Json -InputObject $configuration -Depth 20
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ConfigPath, "$json`n", $utf8WithoutBom)

Write-Host "VS Code MCP detected: $vscodeMcp"
Write-Host "Open a project in VS Code before starting the agent from the chat bar."
if ($studioMcp) {
    Write-Host "Roblox Studio MCP detected: $($studioMcp.FullName)"
}
else {
    Write-Host "Roblox Studio MCP not found; VS Code remains available."
}

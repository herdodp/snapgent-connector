param(
    [switch]$NoLaunch
)

$ErrorActionPreference = "Stop"

$configPath = Join-Path $PSScriptRoot "config.json"
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Host "FigCraft MCP config not found; skipping automatic launch."
    exit 0
}

try {
    $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}
catch {
    Write-Host "Could not read FigCraft MCP config: $($_.Exception.Message)"
    exit 0
}

$server = $configuration.mcpServers.figcraft
if (-not $server -or [string]::IsNullOrWhiteSpace($server.command)) {
    Write-Host "FigCraft MCP is not configured; skipping automatic launch."
    exit 0
}

$baseArgs = New-Object 'System.Collections.Generic.List[string]'
$serverArgs = @($server.args)
for ($i = 0; $i -lt $serverArgs.Count; $i++) {
    $argument = [string]$serverArgs[$i]
    if ($argument -eq "--attach") {
        $i++
    }
    elseif (-not $argument.StartsWith("--attach=")) {
        $baseArgs.Add($argument)
    }
}
if ($baseArgs.Count -eq 0) {
    $baseArgs.Add("mcp")
}

function Save-Configuration {
    $json = ConvertTo-Json -InputObject $configuration -Depth 20
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($configPath, "$json`n", $utf8WithoutBom)
}

function Set-HeadlessConfiguration {
    $server.args = @($baseArgs.ToArray())
    Save-Configuration
}

function Set-AttachedConfiguration {
    param([int]$Port)
    $server.args = @($baseArgs.ToArray()) + @("--attach", [string]$Port)
    Save-Configuration
}

function Test-LoopbackPort {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    $connect = $null
    try {
        $connect = $client.BeginConnect([System.Net.IPAddress]::Loopback, $Port, $null, $null)
        if (-not $connect.AsyncWaitHandle.WaitOne(500)) {
            return $false
        }
        $client.EndConnect($connect)
        return $true
    }
    catch {
        return $false
    }
    finally {
        if ($connect) {
            $connect.AsyncWaitHandle.Close()
        }
        $client.Dispose()
    }
}

function Get-FreeLoopbackPort {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 0)
    try {
        $listener.Start()
        return [int]$listener.LocalEndpoint.Port
    }
    finally {
        $listener.Stop()
    }
}

function Get-ControlPort {
    param([string]$CommandLine)
    if ($CommandLine -match '--control(?:=|\s+)"?(?<target>[^\s"]+)"?') {
        $portText = ($Matches.target -split ":")[-1]
        $parsed = 0
        if ([int]::TryParse($portText, [ref]$parsed) -and $parsed -ge 1 -and $parsed -le 65535) {
            return $parsed
        }
    }
    return $null
}

$cliPath = [string]$server.command
if (-not (Test-Path -LiteralPath $cliPath -PathType Leaf)) {
    $resolvedCli = Get-Command $cliPath -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($resolvedCli) {
        $cliPath = $resolvedCli.Source
    }
}
$appPath = Join-Path (Split-Path -Parent $cliPath) "figcraft.exe"
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
    Write-Host "FigCraft app was not found next to its MCP CLI; its MCP entry will run headless."
    Set-HeadlessConfiguration
    exit 0
}

try {
    $running = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
        Where-Object { $_.Name -ieq "figcraft.exe" })
}
catch {
    Write-Host "Could not inspect running FigCraft processes: $($_.Exception.Message)"
    Write-Host "Leaving FigCraft MCP in headless mode."
    Set-HeadlessConfiguration
    exit 0
}

if ($running.Count -gt 0) {
    $ports = @()
    foreach ($process in $running) {
        $port = Get-ControlPort ([string]$process.CommandLine)
        if ($port) {
            $ports += $port
        }
    }
    if ($ports.Count -gt 0) {
        $deadline = (Get-Date).AddSeconds(30)
        do {
            foreach ($port in $ports) {
                if (Test-LoopbackPort $port) {
                    Set-AttachedConfiguration $port
                    Write-Host "FigCraft control channel detected on port $port."
                    exit 0
                }
            }
            Start-Sleep -Milliseconds 500
        } while ((Get-Date) -lt $deadline)
        Write-Host "FigCraft has a control port configured, but none is responding; its MCP entry will run headless."
        Write-Host "Save your work, close FigCraft, then run Open-FigCraft-for-Snapgent.bat."
    }
    else {
        Write-Host "FigCraft is already open without a control channel. It will not be restarted; its MCP entry will run headless."
        Write-Host "Save your work, close FigCraft, then run Open-FigCraft-for-Snapgent.bat."
    }
    Set-HeadlessConfiguration
    exit 0
}

if ($NoLaunch) {
    Write-Host "FigCraft is not running; leaving it closed. Its MCP entry will run headless."
    Write-Host "Run Open-FigCraft-for-Snapgent.bat when you want to use FigCraft."
    Set-HeadlessConfiguration
    exit 0
}

try {
    $port = Get-FreeLoopbackPort
}
catch {
    Write-Host "Could not select a local FigCraft control port: $($_.Exception.Message)"
    Set-HeadlessConfiguration
    exit 0
}

Set-AttachedConfiguration $port
Write-Host "Starting FigCraft control channel on port $port..."
try {
    Start-Process -FilePath $appPath -ArgumentList @("--control", [string]$port) | Out-Null
}
catch {
    Write-Host "Could not start FigCraft: $($_.Exception.Message)"
    Set-HeadlessConfiguration
    exit 0
}

$deadline = (Get-Date).AddSeconds(30)
do {
    if (Test-LoopbackPort $port) {
        Write-Host "FigCraft control channel is ready on port $port."
        exit 0
    }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

Write-Host "FigCraft did not open its control channel on port $port; its MCP entry will run headless."
Set-HeadlessConfiguration
exit 0

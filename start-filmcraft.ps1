param(
    [switch]$NoLaunch,
    [switch]$Doctor
)

$ErrorActionPreference = "Stop"

$configPath = Join-Path $PSScriptRoot "config.json"
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Host "FilmCraft MCP config not found; skipping automatic launch."
    exit 0
}

try {
    $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}
catch {
    Write-Host "Could not read FilmCraft MCP config: $($_.Exception.Message)"
    exit 0
}

$server = $configuration.mcpServers.filmcraft
if (-not $server -or [string]::IsNullOrWhiteSpace($server.command)) {
    Write-Host "FilmCraft MCP is not configured; skipping automatic launch."
    exit 0
}

$baseArgs = New-Object 'System.Collections.Generic.List[string]'
$serverArgs = @($server.args)
for ($i = 0; $i -lt $serverArgs.Count; $i++) {
    $argument = [string]$serverArgs[$i]
    if ($argument -eq "--bridge") {
        $i++
    }
    elseif (-not $argument.StartsWith("--bridge=")) {
        $baseArgs.Add($argument)
    }
}
if ($baseArgs.Count -eq 0) {
    $baseArgs.Add("mcp")
}

if (-not $server.PSObject.Properties["env"]) {
    $server | Add-Member -MemberType NoteProperty -Name env -Value ([pscustomobject]@{})
}

function Save-Configuration {
    $json = ConvertTo-Json -InputObject $configuration -Depth 20
    $utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($configPath, "$json`n", $utf8WithoutBom)
}

function Set-HeadlessConfiguration {
    $server.args = @($baseArgs.ToArray())
    Save-Configuration
    Write-Host "NOTE: without --bridge the FilmCraft MCP runs HEADLESS: the AI edits a separate"
    Write-Host "      empty project, NOT your FilmCraft window. Run"
    Write-Host "      Open-FilmCraft-for-Snapgent.bat to attach the AI to the real app."
}

function Set-BridgeConfiguration {
    param([int]$Port, [string]$Token)
    $server.args = @($baseArgs.ToArray()) + @("--bridge", "127.0.0.1:$Port")
    if ($server.env.PSObject.Properties["FILMCRAFT_CONTROL_TOKEN"]) {
        $server.env.FILMCRAFT_CONTROL_TOKEN = $Token
    }
    else {
        $server.env | Add-Member -MemberType NoteProperty -Name FILMCRAFT_CONTROL_TOKEN -Value $Token
    }
    Save-Configuration
}

function New-ControlToken {
    $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
    $bytes = New-Object byte[] 32
    $rng.GetBytes($bytes)
    return (($bytes | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Test-KnownToken {
    param([string]$Token)
    return $Token -match '^[0-9a-fA-F]{64}$'
}

if ($server.env -isnot [System.Management.Automation.PSCustomObject]) {
    Write-Host "mcpServers.filmcraft.env must be an object; leaving FilmCraft MCP headless."
    Set-HeadlessConfiguration
    exit 0
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
$appPath = Join-Path (Split-Path -Parent $cliPath) "filmcraft.exe"
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
    Write-Host "FilmCraft app was not found next to its MCP CLI; its MCP entry will run headless."
    Set-HeadlessConfiguration
    exit 0
}

if ($Doctor) {
    Write-Host "=== FilmCraft doctor ==="
    Write-Host "CLI entry   : $($server.command)"
    if (Test-Path -LiteralPath $cliPath -PathType Leaf) {
        Write-Host "CLI file    : found"
    }
    elseif (Get-Command $cliPath -ErrorAction SilentlyContinue) {
        Write-Host "CLI file    : found on PATH"
    }
    else {
        Write-Host "CLI file    : MISSING ($cliPath)"
    }
    if (Test-Path -LiteralPath $appPath -PathType Leaf) {
        Write-Host "Desktop app : found ($appPath)"
    }
    else {
        Write-Host "Desktop app : MISSING next to the CLI ($appPath)"
    }
    $bridgeTarget = $null
    $serverArgs = @($server.args)
    for ($i = 0; $i -lt $serverArgs.Count; $i++) {
        $argument = [string]$serverArgs[$i]
        if ($argument -eq "--bridge" -and ($i + 1) -lt $serverArgs.Count) {
            $bridgeTarget = [string]$serverArgs[$i + 1]
            break
        }
        if ($argument.StartsWith("--bridge=")) {
            $bridgeTarget = $argument.Substring(9)
            break
        }
    }
    if ($bridgeTarget) {
        Write-Host "MCP mode    : BRIDGE -> $bridgeTarget"
        $storedToken = [string]$server.env.FILMCRAFT_CONTROL_TOKEN
        if (-not (Test-KnownToken $storedToken)) {
            Write-Host "Token       : missing or malformed in mcpServers.filmcraft.env"
            Write-Host "              Run Open-FilmCraft-for-Snapgent.bat to regenerate it."
        }
        else {
            $parts = $bridgeTarget.Split(":")
            $probeHost = $parts[0]
            if (-not $probeHost) { $probeHost = "127.0.0.1" }
            $probePort = 0
            if ([int]::TryParse($parts[-1], [ref]$probePort)) {
                $probe = Invoke-ControlProbe -TargetHost $probeHost -Port $probePort -Token $storedToken
                if ($probe.Ok) {
                    Write-Host "Live probe  : ATTACHED - the control channel answers with the stored token."
                    Write-Host "              The AI drives the real running app (650+ commands + UI tools)."
                }
                else {
                    Write-Host "Live probe  : FAILED - $($probe.Error)"
                    Write-Host "              Save your work, close FilmCraft, run Open-FilmCraft-for-Snapgent.bat."
                }
            }
            else {
                Write-Host "Live probe  : target unparseable ($bridgeTarget)"
            }
        }
    }
    else {
        Write-Host "MCP mode    : HEADLESS - the AI edits a separate empty project, not the app window."
        Write-Host "              Fix: close FilmCraft, run Open-FilmCraft-for-Snapgent.bat."
    }
    try {
        $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
            Where-Object { $_.Name -ieq "filmcraft.exe" })
        if ($processes.Count -eq 0) {
            Write-Host "App process : not running"
        }
        else {
            foreach ($process in $processes) {
                $controlPort = Get-ControlPort ([string]$process.CommandLine)
                if ($controlPort) {
                    Write-Host "App process : running with control channel on port $controlPort (pid $($process.ProcessId))"
                }
                else {
                    Write-Host "App process : running WITHOUT a control channel (pid $($process.ProcessId))"
                    Write-Host "              Save your work, close FilmCraft, run Open-FilmCraft-for-Snapgent.bat."
                }
            }
        }
    }
    catch {
        Write-Host "App process : could not inspect ($($_.Exception.Message))"
    }
    Write-Host "=== doctor done ==="
    exit 0
}

# FilmCraft's control listener requires FILMCRAFT_CONTROL_TOKEN, and the MCP
# bridge must inherit the same value, so Snapgent keeps it in the config's env
# block and regenerates it whenever it starts the desktop app itself.
$knownToken = [string]$server.env.FILMCRAFT_CONTROL_TOKEN
if (-not (Test-KnownToken $knownToken)) {
    $knownToken = ""
}

try {
    $running = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop |
        Where-Object { $_.Name -ieq "filmcraft.exe" })
}
catch {
    Write-Host "Could not inspect running FilmCraft processes: $($_.Exception.Message)"
    Write-Host "Leaving FilmCraft MCP in headless mode."
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
        if (-not $knownToken) {
            Write-Host "FilmCraft has a control channel, but Snapgent does not know its access token."
            Write-Host "Save your work, close FilmCraft, then run Open-FilmCraft-for-Snapgent.bat."
            Set-HeadlessConfiguration
            exit 0
        }
        $deadline = (Get-Date).AddSeconds(30)
        do {
            foreach ($port in $ports) {
                if (Test-LoopbackPort $port) {
                    Set-BridgeConfiguration -Port $port -Token $knownToken
                    Write-Host "FilmCraft control channel detected on port $port."
                    exit 0
                }
            }
            Start-Sleep -Milliseconds 500
        } while ((Get-Date) -lt $deadline)
        Write-Host "FilmCraft has a control port configured, but none is responding; its MCP entry will run headless."
        Write-Host "Save your work, close FilmCraft, then run Open-FilmCraft-for-Snapgent.bat."
    }
    else {
        Write-Host "FilmCraft is already open without a control channel. It will not be restarted; its MCP entry will run headless."
        Write-Host "Save your work, close FilmCraft, then run Open-FilmCraft-for-Snapgent.bat."
    }
    Set-HeadlessConfiguration
    exit 0
}

if ($NoLaunch) {
    Write-Host "FilmCraft is not running; leaving it closed. Its MCP entry will run headless."
    Write-Host "Run Open-FilmCraft-for-Snapgent.bat when you want to use FilmCraft."
    Set-HeadlessConfiguration
    exit 0
}

try {
    $port = Get-FreeLoopbackPort
}
catch {
    Write-Host "Could not select a local FilmCraft control port: $($_.Exception.Message)"
    Set-HeadlessConfiguration
    exit 0
}

$token = New-ControlToken
Set-BridgeConfiguration -Port $port -Token $token
Write-Host "Starting FilmCraft control channel on port $port..."
try {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $appPath
    $psi.Arguments = "--control $port"
    $psi.UseShellExecute = $false
    $psi.EnvironmentVariables["FILMCRAFT_CONTROL_TOKEN"] = $token
    [System.Diagnostics.Process]::Start($psi) | Out-Null
}
catch {
    Write-Host "Could not start FilmCraft: $($_.Exception.Message)"
    Set-HeadlessConfiguration
    exit 0
}

$deadline = (Get-Date).AddSeconds(30)
do {
    if (Test-LoopbackPort $port) {
        Write-Host "FilmCraft control channel is ready on port $port."
        exit 0
    }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)

Write-Host "FilmCraft did not open its control channel on port $port; its MCP entry will run headless."
Set-HeadlessConfiguration
exit 0

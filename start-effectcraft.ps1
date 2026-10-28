$ErrorActionPreference = "Stop"

$configPath = Join-Path $PSScriptRoot "config.json"
if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    Write-Host "EffectCraft MCP config not found; skipping automatic launch."
    exit 0
}

try {
    $configuration = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
}
catch {
    Write-Host "Could not read EffectCraft MCP config: $($_.Exception.Message)"
    exit 0
}

$server = $configuration.mcpServers.effectcraft
if (-not $server -or [string]::IsNullOrWhiteSpace($server.command)) {
    Write-Host "EffectCraft MCP is not configured; skipping automatic launch."
    exit 0
}

$appPath = Join-Path (Split-Path -Parent $server.command) "effectcraft.exe"
if (-not (Test-Path -LiteralPath $appPath -PathType Leaf)) {
    Write-Host "EffectCraft app was not found next to its MCP CLI: $appPath"
    Write-Host "Update mcpServers.effectcraft.command in config.json to match your installation."
    exit 0
}

$listener = Get-NetTCPConnection -LocalPort 9877 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
if ($listener) {
    Write-Host "EffectCraft control channel is already listening on port 9877."
    exit 0
}

$running = Get-Process -Name "effectcraft" -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "EffectCraft is already open without its control channel."
    Write-Host "Save your work, close EffectCraft, then run start.bat again."
    exit 0
}

Write-Host "Starting EffectCraft control channel..."
Start-Process -FilePath $appPath -ArgumentList @("--control", "9877")

$deadline = (Get-Date).AddSeconds(30)
do {
    Start-Sleep -Milliseconds 500
    $listener = Get-NetTCPConnection -LocalPort 9877 -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($listener) {
        Write-Host "EffectCraft control channel is ready on port 9877."
        exit 0
    }
} while ((Get-Date) -lt $deadline)

Write-Host "EffectCraft did not open its control channel on port 9877."
Write-Host "Check the EffectCraft window, then restart start.bat."
exit 0

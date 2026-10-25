param(
    [string]$RobloxVersionsPath = (Join-Path $env:LOCALAPPDATA "Roblox\Versions"),
    [string]$ConfigPath = (Join-Path $PSScriptRoot "config.json")
)

$ErrorActionPreference = "Stop"

$studioMcp = Get-ChildItem -Path (Join-Path $RobloxVersionsPath "version-*\StudioMCP.exe") -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $studioMcp) {
    throw "Roblox Studio MCP was not found under '$RobloxVersionsPath'. Install or update Roblox Studio, then run start.bat again."
}

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

$json = ConvertTo-Json -InputObject $configuration -Depth 20
$utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($ConfigPath, "$json`n", $utf8WithoutBom)

Write-Host "Roblox Studio MCP detected: $($studioMcp.FullName)"

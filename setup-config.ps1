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

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
    $nodePath = $nodeCommand.Source
} else {
    $nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
$serverPath = Join-Path $PSScriptRoot 'api-server.js'
$indexPath = Join-Path $PSScriptRoot 'index.html'

if (-not (Test-Path -LiteralPath $nodePath)) {
    throw 'Node.js 20 o superior no está instalado. Instálalo desde https://nodejs.org/ y vuelve a ejecutar el lanzador.'
}
if (-not (Test-Path -LiteralPath $serverPath)) {
    throw "No se encontró api-server.js junto a este lanzador."
}
if (-not (Test-Path -LiteralPath $indexPath)) {
    throw "No se encontró index.html junto a este lanzador."
}

$null = Read-Host 'Copia la clave nueva de OpenRouter al portapapeles y pulsa Enter aquí (no se mostrará)'
$apiKey = (Get-Clipboard -Raw).Trim()
if ($apiKey.Length -lt 30 -or -not $apiKey.StartsWith('sk-or-v1-')) {
    throw 'No se detectó una clave completa de OpenRouter en el portapapeles. Cópiala de nuevo y vuelve a ejecutar el lanzador.'
}
$env:OPENROUTER_API_KEY = $apiKey
$apiKey = $null
$env:OPENROUTER_MODEL = 'google/gemma-4-31b-it:free'
$env:NODE_USE_ENV_PROXY = '1'
$env:INDEX_FILE = $indexPath
try {
    & $nodePath $serverPath
} finally {
    Remove-Item Env:OPENROUTER_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:OPENROUTER_MODEL -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_USE_ENV_PROXY -ErrorAction SilentlyContinue
    Remove-Item Env:INDEX_FILE -ErrorAction SilentlyContinue
}

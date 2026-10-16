$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
Write-Host 'Open http://127.0.0.1:8765 ; data is saved in data/library.json'
python server.py

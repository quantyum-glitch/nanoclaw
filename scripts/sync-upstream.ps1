$ErrorActionPreference = 'Stop'

git fetch upstream --prune
git log --left-right --oneline main...upstream/main
git merge --ff-only upstream/main
git push origin main

Write-Host "Upstream sync complete."

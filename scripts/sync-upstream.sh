#!/usr/bin/env bash
set -euo pipefail

git fetch upstream --prune
git log --left-right --oneline main...upstream/main
git merge --ff-only upstream/main
git push origin main

echo "Upstream sync complete."

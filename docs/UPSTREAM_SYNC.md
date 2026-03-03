# Upstream Sync Workflow

Use this weekly to keep your fork aligned with `qwibitai/nanoclaw`.

## Linux / WSL

```bash
./scripts/sync-upstream.sh
```

## PowerShell

```powershell
./scripts/sync-upstream.ps1
```

## Manual Commands

```bash
git fetch upstream --prune
git log --left-right --oneline main...upstream/main
git merge --ff-only upstream/main
git push origin main
```

After syncing, run:

```bash
npm run typecheck
npm test
```

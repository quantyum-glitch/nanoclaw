# WSL2 Runtime Setup (Windows)

NanoClaw is intended to run on Linux/macOS. On Windows, run it inside WSL2.

## 1. Install Prerequisites

1. Install WSL2 with Ubuntu:
   - `wsl --install -d Ubuntu`
2. Install Docker Desktop and enable:
   - WSL integration for your Ubuntu distro
3. In Ubuntu shell, install toolchain:
   - `sudo apt update`
   - `sudo apt install -y git curl build-essential`
   - `curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -`
   - `sudo apt install -y nodejs`

## 2. Clone Into Linux Filesystem

Do not run NanoClaw from `/mnt/c/...`.

```bash
mkdir -p ~/dev
cd ~/dev
git clone https://github.com/quantyum-glitch/nanoclaw.git NanoClaw
cd NanoClaw
git remote add upstream https://github.com/qwibitai/nanoclaw.git
```

## 3. Validate Baseline

```bash
npm ci
npm run typecheck
npm test
```

## 4. Build/Run

```bash
cd container
./build.sh
cd ..
npm run build
npm run dev
```

## Notes

- Use VS Code "Remote - WSL" for editing.
- Keep Docker Desktop running before starting NanoClaw.
- Keep project files in WSL ext4 storage for performance and fewer path issues.
- Optional native Windows DB shim exists behind `NANOCLAW_USE_SQLITE_SHIM=1`, but WSL2 remains the recommended runtime for containers and long-lived service stability.

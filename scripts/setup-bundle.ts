#!/usr/bin/env tsx
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';

type Scope = 'project' | 'home';

interface BundleEntry {
  scope: Scope;
  relativePath: string;
  mode: number;
  size: number;
  sha256: string;
  data: string;
}

interface BundlePayload {
  magic: 'NANOCLAW_SETUP_BUNDLE_PAYLOAD_V1';
  createdAt: string;
  source: {
    hostname: string;
    platform: string;
    node: string;
  };
  entries: BundleEntry[];
  missing: Array<{
    scope: Scope;
    relativePath: string;
  }>;
}

interface BundleContainerPlain {
  magic: 'NANOCLAW_SETUP_BUNDLE_V1';
  encrypted: false;
  payload: string;
}

interface BundleContainerEncrypted {
  magic: 'NANOCLAW_SETUP_BUNDLE_V1';
  encrypted: true;
  kdf: 'pbkdf2-sha256';
  iterations: number;
  salt: string;
  iv: string;
  tag: string;
  payload: string;
}

type BundleContainer = BundleContainerPlain | BundleContainerEncrypted;

const DEFAULT_PROJECT_PATHS = [
  '.env',
  'groups',
  'store/messages.db',
  'store/messages.db-wal',
  'store/messages.db-shm',
  'store/auth',
  'store/auth-status.txt',
  'data/sessions',
  'data/router_state.json',
  'data/sessions.json',
  'data/registered_groups.json',
];

const DEFAULT_HOME_PATHS = [
  '.gmail-mcp',
  '.config/nanoclaw/mount-allowlist.json',
];

function toPosixRelative(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '');
}

function ensureInside(root: string, target: string): void {
  const normalizedRoot = path.resolve(root);
  const normalizedTarget = path.resolve(target);
  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    throw new Error(`Path escape detected: ${target}`);
  }
}

function collectFiles(absPath: string): string[] {
  const stat = fs.lstatSync(absPath);
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [absPath];
  if (!stat.isDirectory()) return [];

  const output: string[] = [];
  for (const name of fs.readdirSync(absPath)) {
    output.push(...collectFiles(path.join(absPath, name)));
  }
  return output;
}

function hashSha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function makeEntry(scope: Scope, root: string, filePath: string): BundleEntry {
  ensureInside(root, filePath);
  const rel = toPosixRelative(path.relative(root, filePath));
  const data = fs.readFileSync(filePath);
  const stat = fs.statSync(filePath);
  return {
    scope,
    relativePath: rel,
    mode: stat.mode & 0o777,
    size: data.length,
    sha256: hashSha256(data),
    data: data.toString('base64'),
  };
}

function collectScopeEntries(
  scope: Scope,
  root: string,
  specs: string[],
  entries: BundleEntry[],
  missing: Array<{ scope: Scope; relativePath: string }>,
): void {
  for (const spec of specs) {
    const rel = toPosixRelative(spec);
    const abs = path.resolve(root, rel);
    ensureInside(root, abs);
    if (!fs.existsSync(abs)) {
      missing.push({ scope, relativePath: rel });
      continue;
    }
    const files = collectFiles(abs);
    if (files.length === 0 && fs.statSync(abs).isFile()) {
      entries.push(makeEntry(scope, root, abs));
      continue;
    }
    for (const file of files) {
      entries.push(makeEntry(scope, root, file));
    }
  }
}

function packPayload(payload: BundlePayload, passphrase?: string): BundleContainer {
  const raw = Buffer.from(JSON.stringify(payload), 'utf-8');
  const zipped = zlib.gzipSync(raw, { level: 9 });

  if (!passphrase) {
    return {
      magic: 'NANOCLAW_SETUP_BUNDLE_V1',
      encrypted: false,
      payload: zipped.toString('base64'),
    };
  }

  const iterations = 210_000;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(zipped), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    magic: 'NANOCLAW_SETUP_BUNDLE_V1',
    encrypted: true,
    kdf: 'pbkdf2-sha256',
    iterations,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    payload: ciphertext.toString('base64'),
  };
}

function unpackPayload(container: BundleContainer, passphrase?: string): BundlePayload {
  let zipped: Buffer;

  if (!container.encrypted) {
    zipped = Buffer.from(container.payload, 'base64');
  } else {
    if (!passphrase) {
      throw new Error('Bundle is encrypted. Pass --passphrase to import.');
    }
    const salt = Buffer.from(container.salt, 'base64');
    const iv = Buffer.from(container.iv, 'base64');
    const tag = Buffer.from(container.tag, 'base64');
    const key = crypto.pbkdf2Sync(
      passphrase,
      salt,
      container.iterations,
      32,
      'sha256',
    );
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    zipped = Buffer.concat([
      decipher.update(Buffer.from(container.payload, 'base64')),
      decipher.final(),
    ]);
  }

  const raw = zlib.gunzipSync(zipped).toString('utf-8');
  const payload = JSON.parse(raw) as BundlePayload;
  if (payload.magic !== 'NANOCLAW_SETUP_BUNDLE_PAYLOAD_V1') {
    throw new Error('Invalid bundle payload magic.');
  }
  return payload;
}

function parseArgs(argv: string[]): {
  command: 'export' | 'import';
  outPath?: string;
  inPath?: string;
  passphrase?: string;
  noSessions: boolean;
} {
  const commandRaw = argv[2];
  if (commandRaw !== 'export' && commandRaw !== 'import') {
    throw new Error(
      'Usage: tsx scripts/setup-bundle.ts <export|import> [--out FILE] [--in FILE] [--passphrase TEXT] [--no-sessions]',
    );
  }

  let outPath: string | undefined;
  let inPath: string | undefined;
  let passphrase: string | undefined;
  let noSessions = false;

  for (let i = 3; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      outPath = argv[++i];
      continue;
    }
    if (arg === '--in') {
      inPath = argv[++i];
      continue;
    }
    if (arg === '--passphrase') {
      passphrase = argv[++i];
      continue;
    }
    if (arg === '--no-sessions') {
      noSessions = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    command: commandRaw,
    outPath,
    inPath,
    passphrase,
    noSessions,
  };
}

function exportBundle(params: {
  outPath: string;
  passphrase?: string;
  noSessions: boolean;
}): void {
  const projectRoot = process.cwd();
  const homeRoot = os.homedir();
  const entries: BundleEntry[] = [];
  const missing: Array<{ scope: Scope; relativePath: string }> = [];

  const projectSpecs = params.noSessions
    ? DEFAULT_PROJECT_PATHS.filter((p) => p !== 'data/sessions')
    : [...DEFAULT_PROJECT_PATHS];

  collectScopeEntries('project', projectRoot, projectSpecs, entries, missing);
  collectScopeEntries('home', homeRoot, DEFAULT_HOME_PATHS, entries, missing);

  const payload: BundlePayload = {
    magic: 'NANOCLAW_SETUP_BUNDLE_PAYLOAD_V1',
    createdAt: new Date().toISOString(),
    source: {
      hostname: os.hostname(),
      platform: process.platform,
      node: process.version,
    },
    entries,
    missing,
  };

  const container = packPayload(payload, params.passphrase);
  const outputPath = path.resolve(projectRoot, params.outPath);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(container));

  const totalBytes = entries.reduce((sum, e) => sum + e.size, 0);
  console.log(`Bundle created: ${outputPath}`);
  console.log(`- Files: ${entries.length}`);
  console.log(`- Uncompressed payload bytes: ${totalBytes}`);
  console.log(`- Encrypted: ${container.encrypted ? 'yes' : 'no'}`);
  if (missing.length > 0) {
    console.log(`- Missing (skipped): ${missing.length}`);
    for (const item of missing.slice(0, 10)) {
      console.log(`  - ${item.scope}:${item.relativePath}`);
    }
    if (missing.length > 10) {
      console.log(`  ... and ${missing.length - 10} more`);
    }
  }
}

function importBundle(params: {
  inPath: string;
  passphrase?: string;
}): void {
  const projectRoot = process.cwd();
  const homeRoot = os.homedir();
  const inputPath = path.resolve(projectRoot, params.inPath);
  const container = JSON.parse(fs.readFileSync(inputPath, 'utf-8')) as BundleContainer;

  if (container.magic !== 'NANOCLAW_SETUP_BUNDLE_V1') {
    throw new Error('Invalid bundle magic.');
  }

  const payload = unpackPayload(container, params.passphrase);
  const backupRoot = path.resolve(
    projectRoot,
    'backup',
    `setup-bundle-restore-${Date.now()}`,
  );

  let restored = 0;
  let backedUp = 0;
  for (const entry of payload.entries) {
    const root = entry.scope === 'project' ? projectRoot : homeRoot;
    const targetPath = path.resolve(root, ...entry.relativePath.split('/'));
    ensureInside(root, targetPath);

    if (fs.existsSync(targetPath)) {
      const backupPath = path.resolve(
        backupRoot,
        entry.scope,
        ...entry.relativePath.split('/'),
      );
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(targetPath, backupPath);
      backedUp += 1;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    const buffer = Buffer.from(entry.data, 'base64');
    if (hashSha256(buffer) !== entry.sha256) {
      throw new Error(`Checksum mismatch in bundle entry: ${entry.relativePath}`);
    }
    fs.writeFileSync(targetPath, buffer);
    try {
      fs.chmodSync(targetPath, entry.mode);
    } catch {
      // No-op on platforms that don't preserve POSIX mode bits.
    }
    restored += 1;
  }

  console.log(`Bundle imported: ${inputPath}`);
  console.log(`- Restored files: ${restored}`);
  console.log(`- Backed up existing files: ${backedUp}`);
  if (backedUp > 0) {
    console.log(`- Backup location: ${backupRoot}`);
  }
}

function main(): void {
  const args = parseArgs(process.argv);
  if (args.command === 'export') {
    exportBundle({
      outPath: args.outPath || 'nanoclaw-setup.bundle',
      passphrase: args.passphrase,
      noSessions: args.noSessions,
    });
    return;
  }

  importBundle({
    inPath: args.inPath || 'nanoclaw-setup.bundle',
    passphrase: args.passphrase,
  });
}

main();

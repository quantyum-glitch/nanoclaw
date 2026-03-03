/**
 * SQLite compatibility shim for Windows/native setups.
 *
 * It mimics a subset of better-sqlite3 APIs using sql.js (WASM),
 * and persists file-backed databases to disk after writes.
 */

import fs from 'fs';
import path from 'path';
import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WASM_PATH = path.resolve(
  __dirname,
  '..',
  'node_modules',
  'sql.js',
  'dist',
  'sql-wasm.wasm',
);

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function ensureSqlJs(): Promise<void> {
  if (!SQL) {
    try {
      SQL = await initSqlJs({
        locateFile: () => WASM_PATH,
      });
    } catch {
      SQL = await initSqlJs();
    }
  }
}

function getSqlJs(): NonNullable<typeof SQL> {
  if (!SQL) {
    throw new Error(
      'sql.js not initialized. Call createDatabase.initialize().',
    );
  }
  return SQL;
}

class Statement {
  private db: SqlJsDatabase;
  private sql: string;
  private dbWrapper: DatabaseWrapper;

  constructor(db: SqlJsDatabase, sql: string, dbWrapper: DatabaseWrapper) {
    this.db = db;
    this.sql = sql;
    this.dbWrapper = dbWrapper;
  }

  run(...params: unknown[]): { changes: number; lastInsertRowid: number } {
    this.db.run(this.sql, params as any[]);
    const changes = this.db.getRowsModified();
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const lastInsertRowid =
      result.length > 0 ? (result[0].values[0][0] as number) : 0;
    this.dbWrapper.autosave();
    return { changes, lastInsertRowid };
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    const stmt = this.db.prepare(this.sql);
    stmt.bind(params as any[]);
    if (!stmt.step()) {
      stmt.free();
      return undefined;
    }
    const columns = stmt.getColumnNames();
    const values = stmt.get();
    const row: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      row[columns[i]] = values[i];
    }
    stmt.free();
    return row;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    const stmt = this.db.prepare(this.sql);
    stmt.bind(params as any[]);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) {
      const columns = stmt.getColumnNames();
      const values = stmt.get();
      const row: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        row[columns[i]] = values[i];
      }
      rows.push(row);
    }
    stmt.free();
    return rows;
  }
}

class DatabaseWrapper {
  private db: SqlJsDatabase;
  private filePath: string | null;

  constructor(filePathOrMemory: string) {
    const SqlModule = getSqlJs();
    if (filePathOrMemory === ':memory:') {
      this.db = new SqlModule.Database();
      this.filePath = null;
      return;
    }

    this.filePath = filePathOrMemory;
    if (fs.existsSync(filePathOrMemory)) {
      const buffer = fs.readFileSync(filePathOrMemory);
      this.db = new SqlModule.Database(buffer);
    } else {
      this.db = new SqlModule.Database();
    }
  }

  exec(sql: string): void {
    this.db.exec(sql);
    this.autosave();
  }

  prepare(sql: string): Statement {
    return new Statement(this.db, sql, this);
  }

  pragma(pragma: string): unknown {
    const result = this.db.exec(`PRAGMA ${pragma}`);
    if (result.length > 0 && result[0].values.length > 0) {
      return result[0].values[0][0];
    }
    return undefined;
  }

  transaction<T extends (...args: any[]) => unknown>(fn: T): T {
    const wrapped = ((...args: Parameters<T>) => {
      this.db.run('BEGIN TRANSACTION');
      try {
        const result = fn(...args);
        this.db.run('COMMIT');
        this.autosave();
        return result;
      } catch (err) {
        this.db.run('ROLLBACK');
        throw err;
      }
    }) as T;

    return wrapped;
  }

  close(): void {
    this.autosave();
    this.db.close();
  }

  autosave(): void {
    if (!this.filePath) return;
    try {
      const data = this.db.export();
      fs.writeFileSync(this.filePath, Buffer.from(data));
    } catch {
      // Ignore save errors on shutdown or temporary filesystem issues.
    }
  }
}

function createDatabase(filePath: string): DatabaseWrapper {
  return new DatabaseWrapper(filePath);
}

createDatabase.initialize = async function (): Promise<void> {
  await ensureSqlJs();
};

export type ShimDatabase = DatabaseWrapper;
export default createDatabase;

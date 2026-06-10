import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

export type ConsistencyDatabase = Database.Database;

export type DatabaseOptions = {
  readonly?: boolean;
  fileMustExist?: boolean;
  timeoutMs?: number;
};

export function openDatabase(path: string, options: DatabaseOptions = {}): ConsistencyDatabase {
  const databasePath = path === ":memory:" ? path : resolve(path);
  if (databasePath !== ":memory:" && !options.readonly) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath, {
    ...(options.readonly === undefined ? {} : { readonly: options.readonly }),
    ...(options.fileMustExist === undefined ? {} : { fileMustExist: options.fileMustExist }),
    timeout: options.timeoutMs ?? 5_000
  });
  database.pragma("foreign_keys = ON");
  database.pragma(`busy_timeout = ${options.timeoutMs ?? 5_000}`);
  if (!options.readonly) {
    database.pragma("journal_mode = WAL");
  }
  return database;
}

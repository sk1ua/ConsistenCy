import { describe, expect, it } from "vitest";
import { openDatabase } from "./connection";
import { runMigrations, type Migration } from "./migrations";

describe("SQLite foundation", () => {
  it("enables foreign keys and creates the migration table", () => {
    const database = openDatabase(":memory:");
    try {
      expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(runMigrations(database)).toEqual([]);
      const table = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
        .get();
      expect(table).toBeTruthy();
    } finally {
      database.close();
    }
  });

  it("applies migrations once and rolls back failed migrations", () => {
    const database = openDatabase(":memory:");
    const successful: Migration = {
      id: "0001_test",
      up(db) {
        db.exec("CREATE TABLE test_records (id TEXT PRIMARY KEY)");
      }
    };
    const failing: Migration = {
      id: "0002_failure",
      up(db) {
        db.exec("CREATE TABLE should_rollback (id TEXT PRIMARY KEY)");
        throw new Error("migration failed");
      }
    };

    try {
      expect(runMigrations(database, [successful])).toEqual(["0001_test"]);
      expect(runMigrations(database, [successful])).toEqual([]);
      expect(() => runMigrations(database, [successful, failing])).toThrow("migration failed");
      const rolledBack = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'")
        .get();
      expect(rolledBack).toBeUndefined();
    } finally {
      database.close();
    }
  });
});


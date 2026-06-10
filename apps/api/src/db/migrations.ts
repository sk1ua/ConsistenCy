import type { ConsistencyDatabase } from "./connection";

export type Migration = {
  id: string;
  up(database: ConsistencyDatabase): void;
};

export const migrations: readonly Migration[] = [];

function ensureMigrationTable(database: ConsistencyDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);
}

export function runMigrations(
  database: ConsistencyDatabase,
  pendingMigrations: readonly Migration[] = migrations
): string[] {
  ensureMigrationTable(database);
  const appliedIds = new Set(
    database.prepare("SELECT id FROM schema_migrations").all().map(row => (row as { id: string }).id)
  );
  const newlyApplied: string[] = [];

  for (const migration of [...pendingMigrations].sort((left, right) => left.id.localeCompare(right.id))) {
    if (appliedIds.has(migration.id)) {
      continue;
    }
    database.transaction(() => {
      migration.up(database);
      database
        .prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
        .run(migration.id, new Date().toISOString());
    })();
    newlyApplied.push(migration.id);
    appliedIds.add(migration.id);
  }

  return newlyApplied;
}


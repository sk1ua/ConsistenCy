import { describe, expect, it } from "vitest";
import { WORKING_TREE_REV } from "@consistency/schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryJobQueue } from "../jobQueue";
import { InMemoryNotebookStore } from "../notebook/store";
import { seedDemoData } from "./demoSeed";
import { openDatabase } from "../db/connection";
import { runMigrations } from "../db/migrations";
import { SQLiteJobStore } from "../jobs/sqliteJobStore";
import { SQLiteNotebookStore } from "../notebook/store";

describe("seedDemoData", () => {
  it("keeps working when a local review job already exists", () => {
    const jobs = new InMemoryJobQueue();
    const notebooks = new InMemoryNotebookStore();
    jobs.enqueue({
      kind: "pull_request",
      repository: "ConsistenCy",
      repoPath: "D:/workspaces/ConsistenCy",
      accessMode: "local_git",
      publicationPolicy: "disabled",
      baseSha: "a".repeat(40),
      headSha: WORKING_TREE_REV,
      action: "local_trigger"
    });

    const result = seedDemoData(jobs, notebooks);
    expect(result.created).toBe(8);
    expect(result.notebooks?.length).toBe(9);
  });

  it("keeps working with the SQLite stores when seeding after a local review job", () => {
    const root = mkdtempSync(join(tmpdir(), "demo-seed-"));
    try {
      const db = openDatabase(join(root, "consistency.db"));
      runMigrations(db);
      const jobs = new SQLiteJobStore(db);
      const notebooks = new SQLiteNotebookStore(db);
      const first = seedDemoData(jobs, notebooks);
      expect(first.created).toBe(8);
      jobs.enqueue({
        kind: "pull_request",
        repository: "ConsistenCy",
        repoPath: "D:/workspaces/ConsistenCy",
        accessMode: "local_git",
        publicationPolicy: "disabled",
        baseSha: "a".repeat(40),
        headSha: WORKING_TREE_REV,
        action: "local_trigger"
      });

      const result = seedDemoData(jobs, notebooks);
      expect(result.created).toBe(0);
      expect(result.notebooks?.length).toBe(9);
      db.close();
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup on Windows */ }
    }
  });

  it("creates a notebook source for a local job without a pull request", () => {
    const root = mkdtempSync(join(tmpdir(), "demo-seed-source-"));
    try {
      const db = openDatabase(join(root, "consistency.db"));
      runMigrations(db);
      const jobs = new SQLiteJobStore(db);
      const notebooks = new SQLiteNotebookStore(db);
      const job = jobs.enqueue({
        kind: "pull_request",
        repository: "ConsistenCy",
        repoPath: "D:/workspaces/ConsistenCy",
        accessMode: "local_git",
        publicationPolicy: "disabled",
        baseSha: "a".repeat(40),
        headSha: WORKING_TREE_REV,
        action: "local_trigger"
      });
      const ensured = notebooks.ensureForJob(job);
      expect(ensured.source.pullRequestNumber).toBeUndefined();
      db.close();
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort cleanup on Windows */ }
    }
  });
});

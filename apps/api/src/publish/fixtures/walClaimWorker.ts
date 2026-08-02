import { parentPort, workerData } from "node:worker_threads";
import { openDatabase } from "../../db/connection.js";
import { SQLiteJobStore } from "../../jobs/sqliteJobStore.js";

const { dbPath, workerId, sharedBuffer, failBeforeReady, blockBeforeReady } = workerData;
const typedArray = new Int32Array(sharedBuffer);

if (failBeforeReady) {
  throw new Error("Simulated worker failure before ready");
}

if (blockBeforeReady) {
  // Stay alive but do NOT signal ready; wait indefinitely on barrier
  Atomics.wait(typedArray, 1, 0);
}

// Open database connection and instantiate SQLiteJobStore BEFORE signaling ready
const database = openDatabase(dbPath);
database.pragma("busy_timeout = 5000");
const store = new SQLiteJobStore(database);

// Signal ready: independent database connection and SQLiteJobStore are initialized and ready
Atomics.add(typedArray, 0, 1);
Atomics.notify(typedArray, 0);

// Wait for main thread to release start barrier
Atomics.wait(typedArray, 1, 0);

try {
  const claimed = store.claimPublishOutboxItem(workerId, 30000, 1);
  parentPort?.postMessage({ workerId, claimedCount: claimed.length, success: true, item: claimed[0] });
} catch (err: any) {
  parentPort?.postMessage({ workerId, claimedCount: 0, success: false, error: err.message });
} finally {
  database.close();
}

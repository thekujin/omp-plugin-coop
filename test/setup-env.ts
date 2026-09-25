// Must be imported (and therefore evaluated) before src/coop.ts: the extension
// reads COOP_DIR once at module load, so the test directory has to exist first.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const testDir = mkdtempSync(join(tmpdir(), "coop-test-"));
process.env.COOP_DIR = testDir;

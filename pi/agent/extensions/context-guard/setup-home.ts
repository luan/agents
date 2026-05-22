import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "context-guard-test-home-"));

process.env.HOME = home;
process.env.USERPROFILE = home;

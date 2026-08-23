/**
 * Consistent backup of the database and the uploaded images.
 *
 *   node scripts/backup.js [destinationDir] [--keep N]
 *
 * Safe to run while the server is serving: the database snapshot is taken with
 * VACUUM INTO, which holds a read lock only, and images are immutable once
 * written so copying them cannot catch a half-written file.
 *
 * Restore: stop the server, put lumen.db back at data/lumen.db (delete any
 * stale -wal/-shm alongside it), restore data/uploads, start the server.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR ?? path.join(root, "data");
const args = process.argv.slice(2);
const keepIndex = args.indexOf("--keep");
const keep = keepIndex >= 0 ? Number(args[keepIndex + 1]) || 7 : 7;
const destRoot = args.find((a) => !a.startsWith("--") && a !== String(keep)) ?? path.join(dataDir, "backups");

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const target = path.join(destRoot, stamp);

function copyDir(from, to) {
  if (!fs.existsSync(from)) return 0;
  fs.mkdirSync(to, { recursive: true });
  let files = 0;
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) files += copyDir(src, dst);
    else {
      fs.copyFileSync(src, dst);
      files++;
    }
  }
  return files;
}

function directorySize(dir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(p) : fs.statSync(p).size;
  }
  return total;
}

const dbPath = path.join(dataDir, "lumen.db");
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}`);
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true, mode: 0o700 });

// VACUUM INTO produces a single defragmented file with the WAL already folded in.
const db = new DatabaseSync(dbPath, { readOnly: true });
const snapshot = path.join(target, "lumen.db");
db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
db.close();

const images = copyDir(path.join(dataDir, "uploads"), path.join(target, "uploads"));

fs.writeFileSync(
  path.join(target, "manifest.json"),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      database: path.basename(snapshot),
      databaseBytes: fs.statSync(snapshot).size,
      imageFiles: images,
      imageBytes: directorySize(path.join(target, "uploads")),
    },
    null,
    2,
  ),
);

// Rotate: keep the newest N snapshots.
const existing = fs
  .readdirSync(destRoot, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
  .reverse();
let pruned = 0;
for (const old of existing.slice(keep)) {
  fs.rmSync(path.join(destRoot, old), { recursive: true, force: true });
  pruned++;
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
console.log(`Backup written to ${target}`);
console.log(`  database  ${mb(fs.statSync(snapshot).size)}`);
console.log(`  images    ${images} files, ${mb(directorySize(path.join(target, "uploads")))}`);
console.log(`  retained  ${Math.min(existing.length + 1, keep)} snapshots${pruned ? `, pruned ${pruned}` : ""}`);

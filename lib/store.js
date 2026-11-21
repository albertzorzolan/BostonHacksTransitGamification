// Tiny JSON-file database + photo folder. Fine for a hackathon demo;
// swap for Supabase later without changing the game logic.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EMPTY = () => ({ users: [], eggs: [], attempts: [], finds: [], reports: [] });

export function createStore(dataDir) {
  const dbPath = path.join(dataDir, 'db.json');
  const photoDir = path.join(dataDir, 'photos');
  fs.mkdirSync(photoDir, { recursive: true });

  const db = EMPTY();
  if (fs.existsSync(dbPath)) Object.assign(db, JSON.parse(fs.readFileSync(dbPath, 'utf8')));

  function save() {
    const tmp = `${dbPath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, dbPath);
  }

  function savePhoto(buffer) {
    const name = `${crypto.randomUUID()}.jpg`;
    fs.writeFileSync(path.join(photoDir, name), buffer);
    return name;
  }

  // Only plain generated names are allowed, so no path tricks.
  function photoPath(name) {
    if (!/^[0-9a-f-]{36}\.jpg$/.test(name)) return null;
    return path.join(photoDir, name);
  }

  return { db, save, savePhoto, photoPath };
}

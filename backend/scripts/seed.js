// Adds (or removes) demo filler data. See src/seed.js for what it writes.
//
//   node --env-file=.env.seed backend/scripts/seed.js            # add the next batch not yet in
//   node --env-file=.env.seed backend/scripts/seed.js --batch 2  # add one specific batch
//   node --env-file=.env.seed backend/scripts/seed.js --refresh-photos # redraw seeded eggs' pictures
//   node --env-file=.env.seed backend/scripts/seed.js --remove   # delete every batch
//
// Reads MONGODB_URI (and MONGODB_DB) from the environment and never prints them.
import { createDb } from '../src/db.js';
import { addSeed, removeSeed, refreshSeedPhotos } from '../src/seed.js';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set. Run with --env-file pointing at a file that has it.');
  process.exit(1);
}
const db = await createDb({ uri, dbName: process.env.MONGODB_DB || 'egghunt', maxPoolSize: 4 });
try {
  const i = process.argv.indexOf('--batch');
  const batch = i > 0 ? Number(process.argv[i + 1]) : null;
  const result = process.argv.includes('--remove') ? await removeSeed(db.col)
    : process.argv.includes('--refresh-photos') ? await refreshSeedPhotos(db.col)
    : await addSeed(db.col, new Date(), batch);
  console.log(result.already ? 'Every seed batch is already in. Run with --remove to start over.' : result);
} finally {
  await db.close();
}

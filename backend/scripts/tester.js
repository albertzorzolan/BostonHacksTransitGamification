// Marks an account as a tester, which lets it use the "simulate a train ride" button on the
// live site (POST /api/trains/simulate). Nobody else can.
//
//   node --env-file=.env.seed backend/scripts/tester.js <username>        # turn on
//   node --env-file=.env.seed backend/scripts/tester.js <username> --off  # turn off
//   node --env-file=.env.seed backend/scripts/tester.js --list           # who has it
//
// The account must exist first (sign up in the app). Reads MONGODB_URI, never prints it.
import { createDb } from '../src/db.js';

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is not set. Run with --env-file pointing at a file that has it.');
  process.exit(1);
}
const args = process.argv.slice(2);
const db = await createDb({ uri, dbName: process.env.MONGODB_DB || 'egghunt', maxPoolSize: 2 });
try {
  if (args.includes('--list')) {
    const rows = await db.col.users.find({ tester: true }, { projection: { username: 1 } }).toArray();
    console.log(rows.length ? `Testers: ${rows.map((u) => u.username).join(', ')}` : 'No testers.');
  } else {
    const name = args.find((a) => !a.startsWith('--'));
    if (!name) throw new Error('Give a username.');
    const off = args.includes('--off');
    const r = await db.col.users.updateOne({ usernameLower: name.toLowerCase() }, off ? { $unset: { tester: 1 } } : { $set: { tester: true } });
    console.log(r.matchedCount ? `${name}: tester ${off ? 'off' : 'on'}.` : `No account named "${name}". Sign up in the app first.`);
  }
} finally {
  await db.close();
}

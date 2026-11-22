// MongoDB connection, collections, indexes and transactions.
// Transactions need a replica set: MongoDB Atlas always is one, and the
// in-memory server used for tests/dev is started as one.
import { MongoClient } from 'mongodb';

export async function createDb({ uri, dbName = 'egghunt', maxPoolSize = 10 }) {
  const client = new MongoClient(uri, { maxPoolSize, serverSelectionTimeoutMS: 10_000 });
  await client.connect();
  const db = client.db(dbName);

  const col = {
    users: db.collection('users'),
    sessions: db.collection('sessions'),
    photos: db.collection('photos'),
    eggs: db.collection('eggs'),
    attempts: db.collection('attempts'),
    finds: db.collection('finds'),
    reports: db.collection('reports'),
    locks: db.collection('locks'),
    groups: db.collection('groups'),
    groupMembers: db.collection('groupMembers'),
    groupMessages: db.collection('groupMessages'),
  };

  // Idempotent, so every instance runs it on startup.
  await Promise.all([
    col.users.createIndex({ usernameLower: 1 }, { unique: true }),
    // Anonymous chat names are unique too (accounts made before chat names existed have none).
    col.users.createIndex({ chatNameLower: 1 }, { unique: true, partialFilterExpression: { chatNameLower: { $exists: true } } }),
    col.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    col.sessions.createIndex({ userId: 1 }),
    // MongoDB deletes expired sessions on its own.
    col.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    // At most one active egg per (station, level) slot, enforced by the database.
    col.eggs.createIndex(
      { stationId: 1, level: 1 },
      { unique: true, partialFilterExpression: { status: 'active' }, name: 'one_active_per_slot' },
    ),
    col.eggs.createIndex({ stationId: 1, level: 1, status: 1 }),
    col.eggs.createIndex({ createdBy: 1 }),
    col.eggs.createIndex({ status: 1, activatedAt: 1 }),
    col.attempts.createIndex({ userId: 1 }),
    col.finds.createIndex({ userId: 1, eggId: 1 }, { unique: true }), // each egg scores once per player
    col.finds.createIndex({ month: 1, stationId: 1 }),
    col.finds.createIndex({ eggId: 1, foundAt: 1 }),
    col.finds.createIndex({ userId: 1, foundAt: -1 }),
    col.reports.createIndex({ eggId: 1, userId: 1 }, { unique: true }),
    col.groups.createIndex({ inviteCode: 1 }, { unique: true }),
    col.groupMembers.createIndex({ groupId: 1, userId: 1 }, { unique: true }),
    col.groupMembers.createIndex({ userId: 1, joinedAt: 1 }),
    col.groupMembers.createIndex({ groupId: 1, joinedAt: 1 }),
    col.groupMessages.createIndex({ groupId: 1, seq: 1 }, { unique: true }),
    col.groupMessages.createIndex({ groupId: 1, userId: 1, createdAt: -1 }), // rate limit
    // Chat history is kept for 30 days (keeps the free Atlas tier from filling up).
    col.groupMessages.createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 }),
  ]);

  // Runs fn(session) in a transaction. withTransaction retries the whole
  // callback on transient write conflicts, so fn must only touch the database.
  async function tx(fn) {
    const session = client.startSession();
    try {
      let result;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  return { client, db, col, tx, close: () => client.close() };
}

export const isDuplicateKey = (err) => err?.code === 11000;

// Local dev and tests: a throwaway single-node replica set (data is lost on exit).
export async function startMemoryMongo() {
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    binary: { version: process.env.MONGOMS_VERSION || '7.0.14' },
  });
  return { uri: replSet.getUri(), stop: () => replSet.stop() };
}

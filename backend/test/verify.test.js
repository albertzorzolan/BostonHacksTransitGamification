// The photo check's verdicts, with a fake Gemini (no key or network needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMatch, checkGemini, MIN_CONFIDENCE } from '../src/verify.js';

const EGG = Buffer.alloc(500, 1);
const PHOTO = Buffer.alloc(500, 2);

// A fake fetch that answers like Gemini with `answer`, and records what it was sent.
function gemini(answer, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    if (status !== 200) return new Response('quota exceeded', { status });
    const text = typeof answer === 'string' ? answer : JSON.stringify(answer);
    return Response.json({ candidates: [{ content: { parts: [{ text }] } }] });
  };
  return { fetchImpl, calls };
}
const check = (fake, extra = {}) =>
  verifyMatch({ originalJpeg: EGG, candidateJpeg: PHOTO, apiKey: 'k', model: 'gemini-2.5-flash', fetchImpl: fake.fetchImpl, ...extra });

test('same object with high confidence: cleared', async () => {
  const fake = gemini({ sameObject: true, confidence: 0.93, reason: 'Same torn corner on the sticker.' });
  const v = await check(fake);
  assert.deepEqual([v.verdict, v.match, v.method], ['cleared', true, 'gemini']);
  assert.equal(v.reason, 'Same torn corner on the sticker.');
  // Structured output was requested, both images were sent, the key went in a header (not the URL).
  const { body, url, headers } = fake.calls[0];
  assert.equal(body.generationConfig.responseSchema.required.includes('sameObject'), true);
  assert.equal(body.contents[0].parts.filter((p) => p.inlineData).length, 2);
  assert.equal(headers['x-goog-api-key'], 'k');
  assert.equal(url.includes('k='), false);
});

test('different object: failed', async () => {
  const v = await check(gemini({ sameObject: false, confidence: 0.95, reason: 'Different sticker: blue, not red.' }));
  assert.deepEqual([v.verdict, v.match], ['failed', false]);
  assert.match(v.reason, /blue, not red/);
});

test('same object but not confident enough: failed', async () => {
  const v = await check(gemini({ sameObject: true, confidence: MIN_CONFIDENCE - 0.05, reason: 'Hard to see.' }));
  assert.deepEqual([v.verdict, v.match], ['failed', false]);
  assert.match(v.reason, /Not sure/);
});

test('Gemini errors or garbage: failed (never the honor system when a key is set)', async () => {
  for (const fake of [gemini(null, { status: 429 }), gemini('not json'), gemini({ confidence: 1 })]) {
    const v = await check(fake);
    assert.deepEqual([v.verdict, v.match, v.method], ['failed', false, 'gemini']);
  }
  const v = await check(gemini(null, { status: 500 }));
  assert.equal(v.unavailable, true);
});

test("re-uploading the egg's own photo fails without calling Gemini", async () => {
  const fake = gemini({ sameObject: true, confidence: 1, reason: 'identical' });
  const v = await check(fake, { candidateJpeg: Buffer.from(EGG) });
  assert.deepEqual([v.verdict, v.match], ['failed', false]);
  assert.equal(fake.calls.length, 0);
});

test('each image is sent with its own type', async () => {
  const fake = gemini({ sameObject: true, confidence: 0.9, reason: 'ok' });
  await check(fake, { originalType: 'image/png', candidateType: 'image/webp' });
  const types = fake.calls[0].body.contents[0].parts.filter((p) => p.inlineData).map((p) => p.inlineData.mimeType);
  assert.deepEqual(types, ['image/png', 'image/webp']);
});

test('no key: honor system (local development)', async () => {
  const v = await verifyMatch({ originalJpeg: EGG, candidateJpeg: PHOTO, apiKey: '', model: 'x' });
  assert.deepEqual([v.method, v.match], ['honor', true]);
});

test('health check sends a tiny real request and reports a retired model', async () => {
  assert.deepEqual(await checkGemini({ apiKey: '', model: 'm' }), { gemini: 'off', model: 'm' });
  let sent = null;
  const ok = await checkGemini({ apiKey: 'k', model: 'm', fresh: true, fetchImpl: async (url, init) => ((sent = { url, init }), new Response('{}', { status: 200 })) });
  assert.equal(ok.gemini, 'ok');
  assert.match(sent.url, /models\/m:generateContent$/, 'a real generate call, not just a metadata lookup');
  const retired = await checkGemini({
    apiKey: 'k', model: 'old', fresh: true,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 404, message: 'This model models/old is no longer available to new users.' } }), { status: 404 }),
  });
  assert.deepEqual([retired.gemini, retired.status], ['error', 404]);
  assert.match(retired.detail, /GEMINI_MODEL/);
  assert.match(retired.message, /no longer available/);
  // Cached: a second call within 10 minutes doesn't hit Gemini again.
  let calls = 0;
  const count = async () => (calls++, new Response('{}', { status: 200 }));
  await checkGemini({ apiKey: 'k', model: 'c', now: 1000, fresh: true, fetchImpl: count });
  await checkGemini({ apiKey: 'k', model: 'c', now: 2000, fetchImpl: count });
  assert.equal(calls, 1);
});

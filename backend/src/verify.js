// Checks whether a player's photo shows the SAME physical object as the egg photo, using Gemini.
//
// With a key, every check ends in one of two verdicts:
//   cleared: Gemini is confident both photos show the same object  -> the find counts
//   failed:  a different object, low confidence, a cheat, or the check itself errored
//            -> the find does not count and the round stays open, so the player can try again
// Without a key (local development only) finds count on the honor system.
import crypto from 'node:crypto';

const PROMPT = `You are the judge in a scavenger hunt inside subway stations.
Image 1 is the hidden "egg": a photo of one specific physical object or spot (a sticker, a sign, a tile, a mark, a fixture).
Image 2 is a player's photo claiming they found that same thing in the station.

Decide whether image 2 shows the SAME physical object as image 1, the same individual instance in the same place.
Allowed differences: angle, distance, zoom, cropping, lighting, blur, partial occlusion, people walking past.
Answer sameObject=false when any of these is true:
- It is a different object of the same kind (another sticker, another bench, another sign with different details).
- The distinguishing details disagree (text, numbers, colours, damage, position relative to nearby things).
- Image 2 is a photo of a screen or a printout showing image 1, instead of the real object.
- Image 2 is too dark, blurry or zoomed out to tell.
When unsure, answer sameObject=false.
Give confidence from 0 to 1 for your answer, and one short sentence naming the deciding detail.`;

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sameObject: { type: 'BOOLEAN' },
    confidence: { type: 'NUMBER' },
    reason: { type: 'STRING' },
  },
  required: ['sameObject', 'confidence', 'reason'],
  propertyOrdering: ['sameObject', 'confidence', 'reason'],
};

export const MIN_CONFIDENCE = 0.7;
const TIMEOUT_MS = 25_000;

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const cleared = (confidence, reason) => ({ method: 'gemini', verdict: 'cleared', match: true, confidence, reason });
const failed = (reason, extra = {}) => ({ method: 'gemini', verdict: 'failed', match: false, reason, ...extra });

export async function verifyMatch({
  originalJpeg,
  candidateJpeg,
  originalType = 'image/jpeg',
  candidateType = 'image/jpeg',
  apiKey,
  model,
  fetchImpl = fetch,
}) {
  if (!apiKey) {
    return { method: 'honor', verdict: 'cleared', match: true, reason: 'Counted on the honor system (no Gemini key set).' };
  }
  // Re-uploading the egg's own photo is not a find.
  if (sha256(originalJpeg) === sha256(candidateJpeg)) {
    return failed("That's the egg's own photo. Take a new photo of the real thing.");
  }
  try {
    const res = await fetchImpl(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: PROMPT },
                { text: 'Image 1 (the egg):' },
                { inlineData: { mimeType: originalType, data: originalJpeg.toString('base64') } },
                { text: "Image 2 (the player's photo):" },
                { inlineData: { mimeType: candidateType, data: candidateJpeg.toString('base64') } },
              ],
            },
          ],
          generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!res.ok) throw new Error(`Gemini returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
    const reason = String(parsed.reason ?? '').slice(0, 200);
    if (parsed.sameObject === true && confidence >= MIN_CONFIDENCE) return cleared(confidence, reason);
    if (parsed.sameObject === true) return failed(`Not sure it's the same thing. ${reason}`.trim(), { confidence });
    return failed(reason || "That's not the same object.", { confidence });
  } catch (err) {
    // No silent honor-system fallback when a key is set: the find doesn't count, the round stays open.
    console.warn('[verify] Gemini check failed:', err.message);
    return failed('The photo check is unavailable right now. Try again in a moment.', { unavailable: true });
  }
}

// Sends a tiny real request to `model` with this key, so a retired model or a key that
// can't use it shows up here (a model can still exist but refuse new keys). The result is
// cached for 10 minutes per instance so the public health URL can't burn quota.
const HEALTH_TTL_MS = 10 * 60_000;
let lastHealth = null;

export async function checkGemini({ apiKey, model, fetchImpl = fetch, now = Date.now(), fresh = false }) {
  if (!apiKey) return { gemini: 'off', model };
  if (!fresh && lastHealth && lastHealth.model === model && now - lastHealth.at < HEALTH_TTL_MS) return lastHealth.result;
  let result;
  try {
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with OK.' }] }], generationConfig: { maxOutputTokens: 5, temperature: 0 } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) result = { gemini: 'ok', model };
    else {
      const text = (await res.text()).slice(0, 300);
      const detail = res.status === 404 ? 'model unavailable for this key: set GEMINI_MODEL'
        : res.status === 429 ? 'quota or rate limit reached'
        : res.status === 400 || res.status === 403 ? 'key rejected'
        : 'Gemini error';
      result = { gemini: 'error', model, status: res.status, detail, message: text.match(/"message":\s*"([^"]{0,200})/)?.[1] };
    }
  } catch (err) {
    result = { gemini: 'error', model, detail: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
  lastHealth = { at: now, model, result };
  return result;
}

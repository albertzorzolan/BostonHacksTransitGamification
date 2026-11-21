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

// Asks Google whether `model` exists and this key can use it. A metadata lookup:
// it does not generate anything or use generation quota.
export async function checkGemini({ apiKey, model, fetchImpl = fetch }) {
  if (!apiKey) return { gemini: 'off', model };
  try {
    const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}`, {
      headers: { 'x-goog-api-key': apiKey },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return { gemini: 'ok', model };
    return { gemini: 'error', model, status: res.status, detail: res.status === 404 ? 'model not found: set GEMINI_MODEL' : 'key rejected or quota problem' };
  } catch (err) {
    return { gemini: 'error', model, detail: err.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

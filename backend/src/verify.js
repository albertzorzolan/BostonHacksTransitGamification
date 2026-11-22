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
const TIMEOUT_MS = 15_000; // per model; two models fit inside Vercel's 60 s limit

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const cleared = (confidence, reason) => ({ method: 'gemini', verdict: 'cleared', match: true, confidence, reason });
const failed = (reason, extra = {}) => ({ method: 'gemini', verdict: 'failed', match: false, reason, ...extra });

// `model` may be a comma-separated list: if one model errors, is overloaded or is slow,
// the next one is tried. Only when every model fails is the check "unavailable".
export const modelList = (model) => String(model ?? '').split(',').map((m) => m.trim()).filter(Boolean);

export async function verifyMatch({
  originalJpeg,
  candidateJpeg,
  originalType = 'image/jpeg',
  candidateType = 'image/jpeg',
  apiKey,
  model,
  fetchImpl = fetch,
  timeoutMs = TIMEOUT_MS,
}) {
  if (!apiKey) {
    return { method: 'honor', verdict: 'cleared', match: true, reason: 'Counted on the honor system (no Gemini key set).' };
  }
  // Re-uploading the egg's own photo is not a find.
  if (sha256(originalJpeg) === sha256(candidateJpeg)) {
    return failed("That's the egg's own photo. Take a new photo of the real thing.");
  }
  const body = JSON.stringify({
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
  });

  for (const m of modelList(model)) {
    try {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Gemini returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
      if (typeof parsed.sameObject !== 'boolean') throw new Error('Gemini answer had no sameObject');
      const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
      const reason = String(parsed.reason ?? '').slice(0, 200);
      const extra = { confidence, model: m };
      if (parsed.sameObject && confidence >= MIN_CONFIDENCE) return { ...cleared(confidence, reason), model: m };
      if (parsed.sameObject) return failed(`Not sure it's the same thing. ${reason}`.trim(), extra);
      return failed(reason || "That's not the same object.", extra);
    } catch (err) {
      console.warn(`[verify] ${m} failed, trying the next model if any:`, err.message);
    }
  }
  // No silent honor-system fallback when a key is set: the find doesn't count, the round stays open.
  return failed('The photo check is unavailable right now. Try again in a moment.', { unavailable: true });
}

// Sends a tiny real request to `model` with this key, so a retired model or a key that
// can't use it shows up here (a model can still exist but refuse new keys). The result is
// cached for 10 minutes per instance so the public health URL can't burn quota.
const HEALTH_TTL_MS = 10 * 60_000;
let lastHealth = null;

export async function checkGemini({ apiKey, model: models, fetchImpl = fetch, now = Date.now(), fresh = false }) {
  const model = modelList(models)[0] ?? models;
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

// ---------- screening a photo before it's hidden as an egg ----------
// Every new egg photo is checked before it's saved. It's rejected when it shows a person's face,
// has no specific object in it, is too plain (a bare wall, floor or ceiling), is too dark or
// blurry to use, or is inappropriate. It has to show one clear thing another rider could go and
// find. Without a key (local development only) photos are accepted.
const SCREEN_PROMPT = `You review photos for a scavenger hunt inside subway stations.
A player took this photo to hide as an "egg": other riders will see it and must find that exact thing in the station.

Decide whether the photo is usable. It is usable only if it clearly shows one specific, findable physical thing
(a sticker, sign, tile, mark, fixture, poster detail, piece of art, damage, graffiti, a map, a number) with enough
detail that someone standing in the station could recognise it.

Pick the single most important problem, or "none":
- "face": any human face is visible, even partly, small, in the background, or on a poster or screen.
- "no_object": there is no specific object to find, only a general view, a crowd, a scene, or empty space.
- "too_plain": the photo is mostly a plain surface (a white wall, a bare floor, a ceiling, sky, a single flat colour) with nothing distinctive.
- "unclear": too dark, too blurry, or too zoomed in or out to tell what the thing is.
- "inappropriate": nudity, gore, hate symbols, or anything unsafe or offensive.
When unsure whether it is usable, do not answer "none".
Also name the thing to find in a few words (subject), and give one short sentence of reason.`;

const SCREEN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    problem: { type: 'STRING', enum: ['none', 'face', 'no_object', 'too_plain', 'unclear', 'inappropriate'] },
    subject: { type: 'STRING' },
    reason: { type: 'STRING' },
  },
  required: ['problem', 'subject', 'reason'],
  propertyOrdering: ['problem', 'subject', 'reason'],
};

// What the player is told for each problem.
export const SCREEN_MESSAGES = {
  face: "There's a face in this photo. Retake it without anyone in the shot.",
  no_object: 'There is nothing specific to find in this photo. Get closer to one thing, like a sticker, sign or mark.',
  too_plain: "This photo is too plain to find, like a bare wall. Pick something with details someone could spot.",
  unclear: 'This photo is too dark or blurry to tell what it is. Try again with more light or a steadier hand.',
  inappropriate: "This photo can't be used as an egg. Pick something else in the station.",
};

export async function screenEggPhoto({ jpeg, type = 'image/jpeg', apiKey, model, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  if (!apiKey) return { ok: true, method: 'honor' };
  const body = JSON.stringify({
    contents: [{ parts: [{ text: SCREEN_PROMPT }, { inlineData: { mimeType: type, data: jpeg.toString('base64') } }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: SCREEN_SCHEMA },
  });
  for (const m of modelList(model)) {
    try {
      const res = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`Gemini returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const json = await res.json();
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
      const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
      const problem = String(parsed.problem ?? '');
      if (problem !== 'none' && !SCREEN_MESSAGES[problem]) throw new Error(`Gemini answer had no usable problem: ${problem}`);
      const subject = String(parsed.subject ?? '').slice(0, 80);
      const reason = String(parsed.reason ?? '').slice(0, 200);
      if (problem === 'none') return { ok: true, method: 'gemini', subject, reason, model: m };
      return { ok: false, method: 'gemini', problem, message: SCREEN_MESSAGES[problem], reason, model: m };
    } catch (err) {
      console.warn(`[screen] ${m} failed, trying the next model if any:`, err.message);
    }
  }
  // As with finds: with a key set, an unchecked photo is never hidden.
  return { ok: false, method: 'gemini', problem: 'unavailable', message: 'The photo check is unavailable right now. Try again in a moment.' };
}

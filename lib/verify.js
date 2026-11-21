// Checks whether a player's photo shows the same thing as the egg photo,
// using Gemini's image input. Falls back to the honor system with no key or on error.

const PROMPT = `You are judging a scavenger hunt in a subway station.
Image 1 is the hidden "egg": a photo of a specific object or spot.
Image 2 is a player's photo claiming they found it.
Decide if image 2 shows the SAME specific object/spot as image 1 (same sticker, same sign, same mark),
allowing for different angle, distance, zoom and lighting. A different object of the same kind is NOT a match.
Reply with JSON only: {"match": true|false, "confidence": 0.0-1.0, "reason": "one short sentence"}`;

const MIN_CONFIDENCE = 0.6;

export async function verifyMatch({ originalJpeg, candidateJpeg, apiKey, model }) {
  if (!apiKey) {
    return { method: 'honor', match: true, reason: 'Counted on the honor system (no Gemini key set).' };
  }
  try {
    const body = {
      contents: [
        {
          parts: [
            { text: PROMPT },
            { inlineData: { mimeType: 'image/jpeg', data: originalJpeg.toString('base64') } },
            { inlineData: { mimeType: 'image/jpeg', data: candidateJpeg.toString('base64') } },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    };
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      },
    );
    if (!res.ok) throw new Error(`Gemini returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const parsed = JSON.parse(text.replace(/^```(?:json)?|```$/g, '').trim());
    const confidence = Number(parsed.confidence ?? 0);
    return {
      method: 'gemini',
      match: parsed.match === true && confidence >= MIN_CONFIDENCE,
      confidence,
      reason: String(parsed.reason ?? ''),
    };
  } catch (err) {
    console.warn('[verify] Gemini check failed, using honor system:', err.message);
    return {
      method: 'honor',
      match: true,
      reason: 'The photo check is unavailable right now, so this counts on the honor system.',
    };
  }
}

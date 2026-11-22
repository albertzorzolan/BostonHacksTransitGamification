// Pictures for demo eggs: a drawing of the object the hint describes (a plaque, a tile mosaic,
// a sticker, a clock...) on a subway-tile wall, so filler eggs look like something you'd find in
// a station. `view` shifts the angle a little, for a finder's photo of the same object.
import sharp from 'sharp';

const KINDS = [
  ['plaque', /plaque|granite|block|engraved|etched/i],
  ['clock', /clock/i],
  ['sticker', /sticker|decal/i],
  ['graffiti', /graffiti|smiley|painted|paint|handprint|stencil|doodle|drawn|heart|pickle|horseshoe|fluff|mouse/i],
  ['mosaic', /mosaic|tile|compass/i],
  ['lamp', /lamp|lantern/i],
  ['trinket', /key|pin|shell|lego|brick|bear|sculpture|handle|jar/i],
  ['sign', /sign|poster|map|letter|fare/i],
  ['railing', /railing|rack|bench|fence|bars?\b|bolt/i],
];
export const kindOf = (hint) => KINDS.find(([, re]) => re.test(hint ?? ''))?.[0] ?? 'sticker';

// Small deterministic random, so the same egg always draws the same way.
function rng(seed) {
  let h = 2166136261;
  for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) ^ Math.imul(h ^ (h >>> 13), 3266489909)) >>> 0) / 4294967296;
}

const wall = (tint) => {
  let tiles = '';
  for (let y = 0; y < 400; y += 40) {
    const off = (y / 40) % 2 ? 40 : 0;
    for (let x = -80; x < 700; x += 80) tiles += `<rect x="${x + off + 2}" y="${y + 2}" width="76" height="36" rx="3" fill="#f4f1ea" stroke="#d9d3c6" stroke-width="2"/>`;
  }
  return `<rect width="640" height="480" fill="#cfc8b8"/>${tiles}
    <rect y="236" width="640" height="26" fill="${tint}" opacity=".9"/>
    <rect y="400" width="640" height="80" fill="#8d8a84"/><rect y="400" width="640" height="8" fill="#f0c419"/>
    <radialGradient id="vig" cx="50%" cy="45%" r="75%"><stop offset=".6" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".35"/></radialGradient>`;
};

function object(kind, c, r, hint = '') {
  switch (kind) {
    case 'plaque':
      return `<rect x="190" y="130" width="260" height="170" rx="12" fill="#b5803a" stroke="#6b4a1f" stroke-width="8"/>
        <rect x="210" y="150" width="220" height="130" rx="6" fill="none" stroke="#e6c28a" stroke-width="3"/>
        ${[0, 1, 2, 3].map((i) => `<rect x="${232 + (i % 2) * 10}" y="${172 + i * 24}" width="${170 - (i % 2) * 40}" height="9" rx="4" fill="#6b4a1f" opacity=".75"/>`).join('')}
        ${[[200, 140], [440, 140], [200, 290], [440, 290]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="6" fill="#e6c28a" stroke="#6b4a1f" stroke-width="2"/>`).join('')}`;
    case 'clock':
      return `<line x1="320" y1="40" x2="320" y2="95" stroke="#333" stroke-width="10"/>
        <circle cx="320" cy="215" r="125" fill="#fdfbf6" stroke="${c}" stroke-width="16"/>
        ${[...Array(12)].map((_, i) => { const a = (i * Math.PI) / 6; return `<line x1="${320 + Math.sin(a) * 100}" y1="${215 - Math.cos(a) * 100}" x2="${320 + Math.sin(a) * 112}" y2="${215 - Math.cos(a) * 112}" stroke="#222" stroke-width="${i % 3 ? 4 : 8}"/>`; }).join('')}
        <line x1="320" y1="215" x2="${320 + 60 * Math.sin(r() * 6.28)}" y2="${215 - 60 * Math.cos(r() * 6.28)}" stroke="#222" stroke-width="9" stroke-linecap="round"/>
        <line x1="320" y1="215" x2="${320 + 92 * Math.sin(r() * 6.28)}" y2="${215 - 92 * Math.cos(r() * 6.28)}" stroke="#222" stroke-width="5" stroke-linecap="round"/>
        <circle cx="320" cy="215" r="9" fill="${c}"/><path d="M370 120l-18 40 12 6-20 38" fill="none" stroke="#888" stroke-width="2.5"/>`;
    case 'mosaic': {
      let cells = '';
      for (let y = 0; y < 7; y++) for (let x = 0; x < 9; x++) {
        const d = Math.abs(x - 4) + Math.abs(y - 3);
        const fill = d <= 1 ? c : d === 2 ? '#ffffff' : d === 3 ? c : r() > 0.5 ? '#e9e2d0' : '#d8cfb8';
        cells += `<rect x="${185 + x * 30}" y="${110 + y * 30}" width="27" height="27" rx="2" fill="${fill}" opacity="${d === 3 ? 0.65 : 1}"/>`;
      }
      return `<rect x="178" y="103" width="284" height="224" rx="6" fill="#5c574d"/>${cells}`;
    }
    case 'sign':
      return `<rect x="150" y="110" width="340" height="200" rx="10" fill="#fdfbf6" stroke="#2b2b2b" stroke-width="6"/>
        <rect x="150" y="110" width="340" height="52" rx="10" fill="${c}"/><rect x="150" y="140" width="340" height="22" fill="${c}"/>
        <circle cx="185" cy="136" r="14" fill="#fff"/><text x="185" y="143" font-family="Helvetica, Arial" font-size="20" font-weight="800" fill="${c}" text-anchor="middle">T</text>
        ${[0, 1, 2].map((i) => `<rect x="180" y="${185 + i * 34}" width="${250 - i * 50}" height="12" rx="6" fill="#444" opacity=".55"/>`).join('')}
        <circle cx="${300 + r() * 120}" cy="${200 + r() * 60}" r="20" fill="${c}" opacity=".9" stroke="#fff" stroke-width="4"/>`;
    case 'graffiti':
      return `<g transform="rotate(${-8 + r() * 16} 320 220)">
        <circle cx="320" cy="220" r="100" fill="none" stroke="${c}" stroke-width="14"/>
        <circle cx="285" cy="195" r="13" fill="${c}"/><circle cx="355" cy="195" r="13" fill="${c}"/>
        <path d="M265 245q55 50 110 0" fill="none" stroke="${c}" stroke-width="13" stroke-linecap="round"/>
        <path d="M430 150l12 30M440 300l18 10M200 310l-15 15" stroke="${c}" stroke-width="7" stroke-linecap="round" opacity=".7"/></g>`;
    case 'railing':
      return `<rect x="80" y="170" width="480" height="16" rx="8" fill="#6c757d"/><rect x="80" y="290" width="480" height="12" rx="6" fill="#6c757d"/>
        ${[...Array(9)].map((_, i) => `<rect x="${100 + i * 55}" y="170" width="9" height="230" fill="#868e96"/>`).join('')}
        <circle cx="${200 + r() * 240}" cy="232" r="24" fill="${c}" stroke="#fff" stroke-width="5"/>`;
    case 'lamp':
      return `<rect x="312" y="40" width="16" height="120" fill="#343a40"/>
        <path d="M250 160h140l-25 80h-90z" fill="#495057" stroke="#212529" stroke-width="5"/>
        <ellipse cx="320" cy="250" rx="58" ry="16" fill="#ffe066"/><path d="M262 250l-50 150h216l-50-150z" fill="#ffe066" opacity=".25"/>
        <rect x="300" y="170" width="40" height="30" rx="6" fill="${c}"/>`;
    case 'trinket': {
      const floor = `<rect x="170" y="300" width="300" height="100" fill="#a59f94"/><ellipse cx="320" cy="352" rx="100" ry="22" fill="#000" opacity=".2"/>`;
      if (/key/i.test(hint)) return `${floor}<circle cx="255" cy="320" r="34" fill="none" stroke="${c}" stroke-width="14"/><rect x="285" y="313" width="120" height="14" rx="4" fill="${c}"/><rect x="370" y="327" width="12" height="22" fill="${c}"/><rect x="392" y="327" width="12" height="16" fill="${c}"/>`;
      if (/lego|brick/i.test(hint)) return `${floor}<rect x="250" y="290" width="140" height="62" rx="4" fill="${c}" stroke="#1b1f24" stroke-width="4"/>${[0, 1, 2, 3].map((i) => `<rect x="${260 + i * 33}" y="274" width="24" height="18" rx="4" fill="${c}" stroke="#1b1f24" stroke-width="3"/>`).join('')}`;
      if (/shell/i.test(hint)) return `${floor}<path d="M320 250l-80 90h160z" fill="${c}" stroke="#1b1f24" stroke-width="4"/>${[-60, -30, 0, 30, 60].map((d) => `<line x1="320" y1="252" x2="${320 + d}" y2="338" stroke="#fff" stroke-width="3" opacity=".7"/>`).join('')}`;
      return `${floor}<path d="M270 345c0-60 25-110 50-110s50 50 50 110z" fill="${c}" stroke="#1b1f24" stroke-width="5"/><ellipse cx="300" cy="280" rx="9" ry="18" fill="#fff" opacity=".6"/>`;
    }
    default: // sticker
      return `<g transform="rotate(${-12 + r() * 24} 320 220)">
        <circle cx="320" cy="220" r="115" fill="#fff" stroke="#d0cbc0" stroke-width="3"/>
        <circle cx="320" cy="220" r="98" fill="${c}"/>
        ${/cat/i.test(hint) ? '<path d="M262 180l18-45 28 32h24l28-32 18 45v60a58 50 0 0 1-116 0z" fill="#fff"/><circle cx="296" cy="215" r="8" fill="#1b1f24"/><circle cx="344" cy="215" r="8" fill="#1b1f24"/>'
          : /fish/i.test(hint) ? '<path d="M240 220q60-60 130 0q-70 60-130 0zM370 220l40-35v70z" fill="#fff"/><circle cx="275" cy="212" r="7" fill="#1b1f24"/>'
          : /note|music/i.test(hint) ? '<path d="M300 150v100a25 20 0 1 1-12-17V170l70-15v80a25 20 0 1 1-12-17v-63z" fill="#fff"/>'
          : /gull|bird/i.test(hint) ? '<path d="M240 220q40-40 80 0q40-40 80 0" fill="none" stroke="#fff" stroke-width="16" stroke-linecap="round"/>'
          : '<path d="M320 150l20 45 48 4-37 31 12 47-43-26-43 26 12-47-37-31 48-4z" fill="#fff" opacity=".92"/>'}
        <path d="M410 160l18-12 6 22z" fill="#e9e4da"/></g>`;
  }
}

export function sceneSvg({ hint, colour = '#c94f3d', key = hint, view = 0 }) {
  const r = rng(`${key}|${hint}`);
  const kind = kindOf(hint);
  const zoom = 1 + view * 0.12;
  const tilt = view ? (r() > 0.5 ? 1 : -1) * 4 * view : 0;
  return `<svg width="640" height="480" xmlns="http://www.w3.org/2000/svg">
    ${wall(colour)}
    <g transform="translate(320 240) rotate(${tilt}) scale(${zoom}) translate(-320 -240)">${object(kind, colour, r, hint)}</g>
    <rect width="640" height="480" fill="url(#vig)"/>
    <rect x="16" y="16" width="70" height="26" rx="6" fill="#1b1f24" opacity=".7"/><text x="51" y="34" font-family="Helvetica, Arial" font-size="14" font-weight="700" fill="#fff" text-anchor="middle">DEMO</text>
  </svg>`;
}

export const scenePhoto = (opts) => sharp(Buffer.from(sceneSvg(opts))).jpeg({ quality: 82 }).toBuffer();

// Retired eggs (behind past finds) have no hint: give each a plausible object.
export const FIND_OBJECTS = ['Sticker on a pillar', 'Mosaic tile', 'Bronze plaque', 'Station clock', 'Painted smiley', 'Railing detail', 'Old lamp', 'Tiny trinket', 'Map sign'];

// A short "what it is" name for an egg, from its hint: "Brass plaque by the stairs" -> "brass plaque".
export function nameFromHint(hint) {
  const head = String(hint ?? '').split(/\s+(?:by|on|next to|near|at|in|above|with|set|glued|wedged|beside|under)\s+/i)[0];
  return head.replace(/["']/g, '').trim().toLowerCase().slice(0, 40) || 'something in the station';
}

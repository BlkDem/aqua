// Dumps fish geometry parameters from src/life/species.js for the Blender generator.
// Usage: node tools/blender/export_species.mjs
import { writeFileSync } from 'node:fs';
import { SPECIES } from '../../src/life/species.js';

const out = {};
for (const [id, s] of Object.entries(SPECIES)) {
  out[id] = {
    L: s.len, H: s.height, W: s.width, prof: s.profile, tail: s.tail, dorsal: s.dorsal, anal: s.anal,
    pect: s.pect, eyeR: s.eye * 0.82, bulgeEye: !!s.bulgeEye, streamers: s.ventralStreamers || 0,
    variants: s.texVariants ? s.variants : null,
  };
}
writeFileSync(new URL('./species.json', import.meta.url), JSON.stringify(out, null, 1));
console.log('species:', Object.keys(out).join(', '));

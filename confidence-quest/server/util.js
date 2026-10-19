import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();

export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export const randomToken = () => crypto.randomBytes(32).toString('base64url');

// Readable letters and digits with look-alikes removed (no 0/O, 1/I/L, 2/Z, 5/S, 6/G, 8/B).
export const CODE_ALPHABET = 'ACDEFHJKMNPQRTUVWXY3479';
export const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{6}$`);

export function randomCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

export function fillTemplate(template, values) {
  return template.replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

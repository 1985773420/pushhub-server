// Self-check for the two primitives every webhook payload runs through.
// Run: node scripts/lookup-check.js   (no network, no server needed)
import assert from 'node:assert/strict';
import { getPath, render, flatten, scrubEmails, oneLine, multiLine } from '../src/util.js';
import { normalize, adaptNtfy, adaptBark } from '../src/ingest.js';

let n = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    process.exitCode = 1;
  } else n++;
};

// Single-segment keys only (the ingest layer composes multi-segment lookups itself):
// flat contexts (flattened "data.title" keys) and the raw nested body.
const flatCtx = { title: 'T', 'data.title': 'T', 'a.0.b': 'B' };
const nestedData = { title: 'T', 'data.title': 'T', a: [{ b: 'B' }] };
const seg = [
  ['title', flatCtx, 'T'],
  ['data.title', { data: { title: 'T' } }, 'T'],
  ['title', nestedData, 'T'],
  ['data.title', { data: { title: 'T' } }, 'T'],
  ['a', nestedData, nestedData.a],
];
for (const [path, obj, want] of seg) ok(getPath(obj, path) === want, `getPath(${path}) = ${JSON.stringify(getPath(obj, path))} want ${JSON.stringify(want)}`);
ok(getPath(nestedData, 'a')?.[0]?.b === 'B', 'array element reachable');
ok(getPath({}, 'constructor') === undefined, 'constructor blocked');
ok(getPath({}, '__proto__') === undefined, '__proto__ blocked');
ok(getPath({ a: { b: 1 } }, '') === undefined, 'empty path');

ok(render('{title} / {data.x}', { title: 'a', data: { x: 'b' } }) === 'a / b', 'render');
ok(render('{raw.0.subject}', { raw: [{ subject: 's' }] }) === 's', 'render array');
ok(render('{missing}', {}) === '', 'render missing');

ok(flatten({ a: { b: 1 } })['a.b'] === 1, 'flatten');
ok(oneLine('a\n\nb  c ') === 'a b c', 'oneLine');
ok(scrubEmails('x me@example.com y') === 'x *** y', 'scrubEmails');
ok(multiLine('a\n\nb') === 'a\n\nb', 'multiLine keeps paragraphs');
ok(multiLine('a\r\nb') === 'a\nb', 'multiLine normalizes CRLF');
ok(multiLine('x'.repeat(30000)).length > 20000, 'multiLine truncates with a note');

const src = (extra = {}) => ({ id: 'manual', name: '手动', fields: {}, defaults: null, ...extra });
const P = (body, source = src(), special = {}) => normalize(source, body, null, special);

let m = P({ title: 'T1', message: 'B1' });
ok(m && m.title === 'T1' && m.body === 'B1', 'normalize title+message');

m = P({ data: { title: 'T2', description: 'B2' }, priority: 'high' });
ok(m && m.title === 'T2' && m.body === 'B2' && m.priority === 'high', 'normalize nested data + priority');

const longBody = ('第一段内容\n\n第二段内容\n' + 'x'.repeat(5000));
m = P({ title: '长消息', text: longBody });
ok(m && m.body.length > 5000, 'long body kept (was cut at 2000 before)');
ok(m && m.body.includes('\n\n'), 'body newlines kept');

m = P({ subject: 'S', snippet: 'SN', from: 'a@b.com' }, src({ defaults: { title: ['subject'], body: ['snippet'] }, scrubEmails: true }));
ok(m && m.title === 'S' && m.body === 'SN', 'normalize email style');

ok(P({}) === null, 'service ping -> null');
ok(P({ action: 'x' }) === null, 'action-only payload -> null');

m = P({ strings: ['Title', 'Body'] }, src({ fields: { title: '{strings.0}', body: '{strings.1}' } }));
ok(m && m.title === 'Title' && m.body === 'Body', 'template fields');

const nf = adaptNtfy({ title: 'N', message: 'NB', priority: 'max' }, {});
const nm = P(nf.body, src(), nf.special);
ok(nm && nm.title === 'N' && nm.body === 'NB' && nm.priority === 'high', 'ntfy adapter');

const bf = adaptBark({ title: 'K', body: 'KB' });
ok(P(bf.body).title === 'K', 'bark adapter');

// Attachments: arrays, single objects, aliases, legacy image, unsafe schemes and limits.
const att = (b) => P({ title: 'A', text: 'B', ...b })?.attachments || [];
ok(att({ attachments: [{ url: 'https://x.test/a.jpg' }] })[0]?.type === 'image', 'attachment https image');
ok(att({ attachments: 'https://x.test/a.jpg' })[0]?.url === 'https://x.test/a.jpg', 'attachment bare URL');
ok(att({ attachment: { url: 'https://x.test/v.mp4' } })[0]?.type === 'video', 'attachment singular alias');
ok(att({ data: { attachments: [{ url: 'https://x.test/d.pdf', name: 'd.pdf' }] } })[0]?.type === 'file', 'attachment nested data');
ok(att({ image: 'https://x.test/i.png' })[0]?.url === 'https://x.test/i.png', 'legacy image becomes attachment');
ok(att({ attachments: [{ url: 'javascript:alert(1)' }, { url: 'file:///etc/passwd' }] }).length === 0, 'unsafe attachment schemes dropped');
ok(att({ attachments: Array.from({ length: 15 }, (_, i) => 'https://x.test/' + i + '.png') }).length === 10, 'attachment limit 10');
ok(att({ attachments: ['https://x.test/a.png', 'https://x.test/a.png'] }).length === 1, 'attachment dedupe');

console.log(`${n} lookup/ingest checks passed${process.exitCode ? ' (with failures)' : ''}`);

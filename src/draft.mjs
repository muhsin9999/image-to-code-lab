// Deterministic first page from facts.json: every measured item placed exactly, no model involved.
// It is the agent's starting point and the no-AI floor in the test suite.
const q = v => JSON.stringify(String(v));
const px = v => Math.round(v * 100) / 100;
const hexRgb = h => [1, 3, 5].map(k => parseInt(h.slice(k, k + 2), 16));
const far = (a, b) => Math.max(...hexRgb(a).map((v, i) => Math.abs(v - hexRgb(b)[i])));

function borderStyle(border) {
  if (!border) return {};
  if (typeof border === 'string') return { border };
  return Object.fromEntries(Object.entries(border).map(([side, v]) => [`border${side[0].toUpperCase()}${side.slice(1)}`, v]));
}

function style(obj) {
  const parts = Object.entries(obj).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}: ${typeof v === 'number' ? v : q(v)}`);
  return `{{ ${parts.join(', ')} }}`;
}

export function draftApp(facts) {
  const { width: W, height: H } = facts.viewport;
  const out = [], notes = [];
  const items = facts.sections.flatMap(s => s.items);
  // section backgrounds
  for (const s of facts.sections) {
    const bg = typeof s.background === 'string' ? s.background
      : s.background.edgeMean ? s.background.edgeMean
      : s.background.gradient ? `linear-gradient(${s.background.gradient.direction}, ${s.background.gradient.colors.join(', ')})`
      : `linear-gradient(to bottom, ${s.background.top}, ${s.background.bottom})`;
    out.push(`      <div className="bg" data-section=${q(s.id)} style=${style({ top: s.y, height: s.height, background: bg })} />`);
  }
  const at = box => ({ left: box[0], top: box[1], width: box[2], height: box[3] });
  for (const it of items.filter(i => i.type === 'gradient')) {
    const g = it.gradient;
    const dir = it.stand ? `${it.stand.direction}, ${it.stand.colors.join(', ')}`
      : far(g.top, g.bottom) >= far(g.left, g.right) ? `to bottom, ${g.top}, ${g.bottom}` : `to right, ${g.left}, ${g.right}`;
    out.push(`      <div className="abs" data-i2c-id=${q(it.id)} style=${style({ ...at(it.box), background: `linear-gradient(${dir})`, borderRadius: it.radius || undefined })} />`);
  }
  for (const it of items.filter(i => i.type === 'image')) {
    if (it.file) out.push(`      <img className="abs" data-i2c-id=${q(it.id)} src=${q('./' + it.file)} alt="" style=${style(at(it.box))} />`);
    else {
      const stand = it.stand ? `linear-gradient(${it.stand.direction}, ${it.stand.colors.join(', ')})` : undefined;
      out.push(`      <div className="abs placeholder" data-i2c-id=${q(it.id)} style=${style({ ...at(it.box), background: stand })} />`);
      notes.push(`${it.id}: photo behind text; this is a colour stand-in. Replace with the real or a generated image (${it.route})`);
    }
  }
  for (const it of items.filter(i => i.type === 'box').sort((a, b) => b.box[2] * b.box[3] - a.box[2] * a.box[3]))
    out.push(`      <div className="abs" data-i2c-id=${q(it.id)} style=${style({ ...at(it.box), background: it.fill, borderRadius: it.radius || undefined, ...borderStyle(it.border) })} />`);
  for (const it of items.filter(i => i.type === 'line'))
    out.push(`      <div className="abs" style=${style({ ...at(it.box), background: it.color })} />`);
  for (const it of items.filter(i => i.type === 'icon'))
    out.push(`      <img className="abs" data-i2c-id=${q(it.id)} src=${q('./' + it.file)} alt="" style=${style(at(it.fileBox || it.box))} />`);
  for (const it of items.filter(i => i.type === 'text')) {
    const { ascent, descent } = it.metrics;
    const lines = it.lines.map(l => {
      const size = Math.abs(l.size / it.size - 1) > 0.06 ? l.size : null;
      const f = size || it.size;
      return `        <div style=${style({ left: px(l.x ?? l.box[0]), top: px(l.baseline - ascent * f), fontSize: size ? px(size) : undefined })}>{${q(l.text)}}</div>`;
    });
    if (it.partial) notes.push(`${it.id}: partly read, fix the wording`);
    out.push(`      <div className="t" data-i2c-id=${q(it.id)} style=${style({ fontFamily: `'${it.family}', sans-serif`, fontWeight: it.weight, fontSize: px(it.size),
      letterSpacing: it.spacing ? `${it.spacing}px` : undefined, lineHeight: px(ascent + descent), color: it.color })}>${it.partial ? ' {/* PARTLY READ: fix the wording */}' : ''}\n${lines.join('\n')}\n      </div>`);
  }
  for (const it of items.filter(i => i.type === 'unread')) notes.push(`${it.id} (optional): unread mark at ${it.box.join(', ')}`);
  const app = `// Draft generated from work/facts.md by "fast init". Edit freely: fix wording, add anything missing, restructure.
// Keep data-i2c-id on elements so "fast check" can measure them.
${notes.length ? notes.map(n => `// TODO ${n}`).join('\n') + '\n' : ''}export function App() {
  return (
    <main className="page">
${out.join('\n')}
    </main>
  );
}
`;
  const css = `* { box-sizing: border-box; }
html, body { margin: 0; }
body { -webkit-font-smoothing: antialiased; }
/* The screenshot is ${W}×${H}px. */
.page { width: ${W}px; min-height: ${H}px; position: relative; overflow: hidden; }
.bg { position: absolute; left: 0; width: 100%; }
.abs { position: absolute; display: block; }
.placeholder { background: rgba(0, 0, 0, 0.08); }
.t { position: absolute; left: 0; top: 0; }
.t > div { position: absolute; white-space: pre; }
`;
  return { app, css };
}

#!/usr/bin/env node
/* scripts/generate-bpmn-test-report.mjs
 * BPMN test coverage report (Tasks-only) -> JSON, CSV, HTML
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------- Config ----------
const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BPMN_PATH = path.join(REPO_ROOT, 'ci_test.bpmn');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');
const OUT_DIR   = path.join(REPO_ROOT, 'reports', 'coverage');

const OUT_JSON = path.join(OUT_DIR, 'bpmn-test-report.json');
const OUT_CSV  = path.join(OUT_DIR, 'bpmn-test-report.csv');
const OUT_HTML = path.join(OUT_DIR, 'index.html');

// ---------- Helpers ----------
async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function readTextIfExists(p) {
  try { return await fs.readFile(p, 'utf8'); } catch { return ''; }
}

async function listFilesRec(dir) {
  const out = [];
  async function walk(d) {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.push(abs);
    }
  }
  try { await walk(dir); } catch {}
  return out;
}

// Try use fast-xml-parser if available; else regex-fallback
let parseXML;
try {
  const { XMLParser } = await import('fast-xml-parser');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    allowBooleanAttributes: true,
    preserveOrder: true
  });
  parseXML = (xml) => parser.parse(xml);
} catch {
  parseXML = null;
}

// Extract text from node (preserveOrder structure)
function getAttr(node, name) {
  if (!node || typeof node !== 'object') return undefined;
  const k = Object.keys(node).find(k => k.startsWith(':@'));
  if (!k) return undefined;
  const attrs = node[k];
  return attrs ? attrs[name] : undefined;
}
function nodeName(node) {
  if (!node || typeof node !== 'object') return '';
  return Object.keys(node).find(k => !k.startsWith(':@')) || '';
}
function childNodes(node) {
  if (!node || typeof node !== 'object') return [];
  const name = nodeName(node);
  const children = node[name];
  return Array.isArray(children) ? children : [];
}

// Parse BPMN: prefer fast-xml-parser; otherwise do a regex scan for Task-like tags
function extractTasks(xml) {
  const tasks = [];

  if (parseXML) {
    const doc = parseXML(xml); // preserveOrder = true -> array
    // Walk the tree to find any element where localName endsWith 'Task'
    function walk(nodes) {
      for (const n of nodes) {
        const tag = nodeName(n);
        if (!tag) continue;

        const local = tag.split(':').pop().toLowerCase();
        const id = getAttr(n, 'id');
        const name = getAttr(n, 'name') || '';

        if (id && local.endsWith('task')) {
          tasks.push({ id, name, tag });
        }

        const kids = childNodes(n);
        if (kids && kids.length) walk(kids);
      }
    }
    walk(doc);
  } else {
    // Fallback: naive regex (won't read nested meta)
    const taskTagRegex = /<([a-zA-Z0-9:-]*task)\b([^>]*)>/g; // matches ...task tags
    let m;
    while ((m = taskTagRegex.exec(xml))) {
      const tag = m[1]; // e.g. bpmn:userTask
      const attrs = m[2] || '';
      const id = (attrs.match(/\bid="([^"]+)"/) || [])[1];
      const name = (attrs.match(/\bname="([^"]+)"/) || [])[1] || '';
      if (id) tasks.push({ id, name, tag });
    }
  }

  return tasks;
}

// Extract <test:playwrightRef> under extensionElements for given element IDs (simple string scan)
function extractPlaywrightRefsById(xml) {
  // This is a lightweight approach: for each element with an id, scan its extensionElements block.
  const refs = new Map();
  const elementRegex = /<([a-zA-Z0-9:]+)\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let em;
  while ((em = elementRegex.exec(xml))) {
    const [ , tag, id, inner ] = em;
    if (!id) continue;

    const extMatch = inner.match(/<bpmn:extensionElements[^>]*>([\s\S]*?)<\/bpmn:extensionElements>/);
    if (!extMatch) continue;

    const ext = extMatch[1];
    const refRegex = /<test:playwrightRef>([\s\S]*?)<\/test:playwrightRef>/g;
    let rm, list = [];
    while ((rm = refRegex.exec(ext))) {
      const v = String(rm[1] || '').trim();
      if (v) list.push(v);
    }
    if (list.length) refs.set(id, list);
  }
  return refs;
}

// Scan tests for [bpmn:ID] markers
async function scanTestMarkers(ids) {
  const files = (await listFilesRec(TESTS_DIR))
    .filter(f => /\.(spec\.)?(ts|js|tsx|jsx)$/.test(f));
  const markers = new Map(ids.map(id => [id, []]));
  for (const f of files) {
    const rel = path.relative(REPO_ROOT, f);
    const txt = await readTextIfExists(f);
    for (const id of ids) {
      if (txt.includes(`[bpmn:${id}]`)) {
        markers.get(id).push(rel);
      }
    }
  }
  return markers;
}

// Build CSV
function toCSV(rows) {
  const head = ['bpmnId','name','type','hasTests','testFiles','playwrightRefs'];
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      esc(r.id),
      esc(r.name),
      esc(r.type),
      esc(r.hasTests ? 'yes' : 'no'),
      esc(r.testFiles.join('\n')),
      esc(r.playwrightRefs.join('\n'))
    ].join(','));
  }
  return lines.join('\n');
}

// Build HTML (Material-ish)
function toHTML(rows, { total, covered, uncovered }) {
  const date = new Date().toISOString();
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>BPMN Test Coverage – Tasks</title>
<link href="https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Rounded:FILL@0..1" rel="stylesheet">
<style>
:root{
  --md-surface:#ffffff;
  --md-on-surface:#1f2937;
  --md-surface-variant:#f3f4f6;
  --md-outline:#e5e7eb;
  --md-primary:#1a73e8;
  --md-danger:#ef4444;
  --md-ok:#10b981;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;font-family:Roboto,system-ui,Segoe UI,Arial,sans-serif;color:var(--md-on-surface);background:#fafafa}
.appbar{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid var(--md-outline);padding:12px 16px;display:flex;align-items:center;gap:12px}
.title{font-size:18px;font-weight:700;margin:0;display:flex;align-items:center;gap:8px}
.container{max-width:1100px;margin:20px auto;padding:0 16px}
.summary{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0}
.card{background:#fff;border:1px solid var(--md-outline);border-radius:14px;padding:12px 14px;min-width:180px}
.card h3{margin:0 0 4px 0;font-size:13px;color:#374151}
.card .val{font-size:20px;font-weight:700}
.table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid var(--md-outline);border-radius:14px;overflow:hidden}
.table th,.table td{padding:10px 12px;border-bottom:1px solid var(--md-outline);vertical-align:top;font-size:14px}
.table th{background:#f8fafc;text-align:left;font-weight:600}
.badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 8px;font-size:12px}
.badge.ok{background:#ecfdf5;color:#065f46}
.badge.nok{background:#fef2f2;color:#991b1b}
.small{color:#6b7280;font-size:12px}
.mono{font-family:ui-monospace,Menlo,Consolas,monospace}
.actions{margin:12px 0;display:flex;gap:8px;flex-wrap:wrap}
.btn{border:1px solid var(--md-outline);background:#fff;border-radius:12px;padding:8px 12px;cursor:pointer}
.btn:hover{background:#f3f4f6}
</style>
</head>
<body>
  <div class="appbar">
    <h1 class="title"><span class="material-symbols-rounded" style="font-size:20px;">table</span> BPMN Test Coverage – Tasks</h1>
  </div>
  <div class="container">
    <div class="summary">
      <div class="card"><h3>Totalt Tasks</h3><div class="val">${total}</div></div>
      <div class="card"><h3>Täckta</h3><div class="val" style="color:var(--md-ok)">${covered}</div></div>
      <div class="card"><h3>Inte täckta</h3><div class="val" style="color:var(--md-danger)">${uncovered}</div></div>
      <div class="card"><h3>Senast genererad</h3><div class="val" style="font-size:14px;font-weight:500">${date}</div></div>
    </div>

    <div class="actions">
      <a class="btn" href="./bpmn-test-report.json" target="_blank" rel="noopener">Öppna JSON</a>
      <a class="btn" href="./bpmn-test-report.csv"  target="_blank" rel="noopener">Öppna CSV</a>
      <a class="btn" href="../../" rel="noopener">← Till index</a>
    </div>

    <table class="table">
      <thead>
        <tr>
          <th style="width:22%">BPMN ID</th>
          <th style="width:22%">Namn</th>
          <th style="width:14%">Typ</th>
          <th style="width:12%">Status</th>
          <th>Testfiler</th>
          <th>Playwright refs</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td class="mono">${r.id}</td>
            <td>${r.name || '—'}</td>
            <td class="mono">${r.type}</td>
            <td>${r.hasTests
              ? `<span class="badge ok">Täckning</span>`
              : `<span class="badge nok">Saknar test</span>`
            }</td>
            <td>${r.testFiles.length ? r.testFiles.map(f => `<div class="mono small">${f}</div>`).join('') : '<span class="small">—</span>'}</td>
            <td>${r.playwrightRefs.length ? r.playwrightRefs.map(v => `<div class="mono small">${v}</div>`).join('') : '<span class="small">—</span>'}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>

    <p class="small" style="margin-top:12px;">
      * Rapporten visar enbart element vars typ slutar med <code>Task</code> (t.ex. <code>bpmn:task</code>, <code>bpmn:userTask</code>, <code>bpmn:serviceTask</code>).
    </p>
  </div>
</body>
</html>`;
}

// ---------- Main ----------
(async () => {
  await ensureDir(OUT_DIR);

  const bpmnXML = await readTextIfExists(BPMN_PATH);
  if (!bpmnXML) {
    console.error(`❌ Hittar inte BPMN-filen: ${BPMN_PATH}`);
    process.exit(1);
  }

  // 1) Hämta alla Tasks (endast Task-typer)
  const tasks = extractTasks(bpmnXML); // [{id,name,tag}]
  // 2) ev. refs från extensionElements
  const refsById = extractPlaywrightRefsById(bpmnXML);

  // 3) Skanna tests efter [bpmn:ID]
  const ids = tasks.map(t => t.id);
  const markers = await scanTestMarkers(ids);

  // 4) Bygg rader
  const rows = tasks.map(t => {
    const testFiles = markers.get(t.id) || [];
    const playwrightRefs = refsById.get(t.id) || [];
    return {
      id: t.id,
      name: t.name || '',
      type: t.tag || '',
      hasTests: testFiles.length > 0 || playwrightRefs.length > 0,
      testFiles,
      playwrightRefs
    };
  }).sort((a,b) => a.id.localeCompare(b.id));

  const total = rows.length;
  const covered = rows.filter(r => r.hasTests).length;
  const uncovered = total - covered;

  // 5) Skriv ut JSON, CSV, HTML
  await fs.writeFile(OUT_JSON, JSON.stringify({ summary:{ total, covered, uncovered }, items: rows }, null, 2), 'utf8');
  await fs.writeFile(OUT_CSV, toCSV(rows), 'utf8');
  await fs.writeFile(OUT_HTML, toHTML(rows, { total, covered, uncovered }), 'utf8');

  console.log(`✅ Skrev rapport till:
  - ${path.relative(REPO_ROOT, OUT_HTML)}
  - ${path.relative(REPO_ROOT, OUT_JSON)}
  - ${path.relative(REPO_ROOT, OUT_CSV)}
  (Tasks-only)`);
})().catch(err => {
  console.error('❌ Fel vid generering:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Generate BPMN ↔︎ Test coverage report (HTML + CSV + JSON)
 *
 * - Parses BPMN XML (extensionElements: playwrightRef, jiraKeys, tags, priority, figmaUrl/nodeId)
 * - Scans test files for [bpmn:<ID>] in titles or body
 * - Writes:
 *    - bpmn-test-report.html      (root)
 *    - bpmn-test-report.csv       (root)
 *    - bpmn-test-report.json      (root)
 *    - reports/coverage/index.html
 *    - reports/coverage/bpmn-test-report.csv
 *    - reports/coverage/bpmn-test-report.json
 *
 * Run:  node scripts/generate-bpmn-test-report.mjs
 */

import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { XMLParser } from 'fast-xml-parser';

const ROOT = process.cwd();
const BPMN_PATH = path.join(ROOT, 'ci_test.bpmn');                // justera om du byter namn
const TEST_GLOB = 'tests/**/*.{spec,test}.{ts,tsx,js,jsx}';       // Playwright/Jest
const OUT_ROOT_HTML = path.join(ROOT, 'bpmn-test-report.html');
const OUT_ROOT_CSV  = path.join(ROOT, 'bpmn-test-report.csv');
const OUT_ROOT_JSON = path.join(ROOT, 'bpmn-test-report.json');
const OUT_DIR       = path.join(ROOT, 'reports', 'coverage');
const OUT_HTML      = path.join(OUT_DIR, 'index.html');
const OUT_CSV       = path.join(OUT_DIR, 'bpmn-test-report.csv');
const OUT_JSON      = path.join(OUT_DIR, 'bpmn-test-report.json');

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: false
});

/* ---------------------------- IO helpers ---------------------------- */

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readText(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeText(p, content) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, content, 'utf8');
}

/* ---------------------------- BPMN parsing ---------------------------- */

function loadBpmn(xmlPath) {
  const xml = readText(xmlPath);
  return parser.parse(xml);
}

// Recursiv traversal som hittar alla BPMN-element med id och plockar ut extensionElements
function collectBpmnElements(obj, tagName = '') {
  const out = [];
  const isObject = v => v && typeof v === 'object' && !Array.isArray(v);

  function visit(node, name) {
    if (!node) return;

    if (Array.isArray(node)) {
      node.forEach(n => visit(n, name));
      return;
    }
    if (!isObject(node)) return;

    if (node['@id']) {
      const el = {
        id: node['@id'],
        type: name,
        name: node['@name'] || '',
        meta: {
          playwrightRefs: [],
          jiraKeys: [],
          tags: [],
          priority: '',
          figmaUrl: '',
          figmaNodeId: '',
          figmaComponentKey: '',
          variant: ''
        }
      };

      const ext = node['bpmn:extensionElements'] || node['extensionElements'];
      if (ext) {
        Object.entries(ext).forEach(([k, v]) => {
          const arr = Array.isArray(v) ? v : [v];
          arr.filter(Boolean).forEach(ch => {
            if (typeof ch !== 'object') return;
            Object.entries(ch).forEach(([kk, vv]) => {
              const vvArr = Array.isArray(vv) ? vv : [vv];
              vvArr.filter(Boolean).forEach(x => {
                const key = kk.split(':').pop(); // ta bort ev namespace

                const str = s => {
                  if (typeof s === 'string') return s.trim();
                  if (s && typeof s === 'object') {
                    // fast-xml-parser kan lägga text som value i childobjekt
                    const val = Object.values(s).find(v => typeof v === 'string');
                    return (val || '').trim();
                  }
                  return '';
                };

                switch (key) {
                  case 'playwrightRef':
                    el.meta.playwrightRefs.push(str(x));
                    break;
                  case 'jiraKeys':
                    str(x).split(/[,|]/).map(s => s.trim()).filter(Boolean).forEach(k => el.meta.jiraKeys.push(k));
                    break;
                  case 'tags':
                    str(x).split(/[,|]/).map(s => s.trim()).filter(Boolean).forEach(t => el.meta.tags.push(t));
                    break;
                  case 'priority':
                    el.meta.priority = str(x);
                    break;
                  case 'figmaUrl':
                    el.meta.figmaUrl = str(x);
                    break;
                  case 'figmaNodeId':
                    el.meta.figmaNodeId = str(x);
                    break;
                  case 'figmaComponentKey':
                    el.meta.figmaComponentKey = str(x);
                    break;
                  case 'variant':
                    el.meta.variant = str(x);
                    break;
                  default:
                    break;
                }
              });
            });
          });
        });
      }

      out.push(el);
    }

    Object.entries(node).forEach(([k, v]) => {
      if (k.startsWith('@')) return;
      visit(v, k);
    });
  }

  visit(obj, tagName);
  return out;
}

/* ---------------------------- Test scanning ---------------------------- */

function scanTestsForBpmnTags() {
  const files = glob.sync(TEST_GLOB, { cwd: ROOT, dot: false, nodir: true });
  const re = /\[bpmn:([^\]]+)\]/g;

  const hitsById = new Map(); // id -> array of { file, line, titleSnippet }
  const titlesByFile = new Map();

  for (const file of files) {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) continue;

    const text = readText(full);

    // samla titlar (heuristik)
    const titleRe = /(test|it|describe)\s*\(\s*(['"`])(.*?)\2/gi;
    const titles = [];
    let m;
    while ((m = titleRe.exec(text)) !== null) {
      titles.push(m[3]);
    }
    titlesByFile.set(file, titles);

    // bpmn-taggar
    let mt;
    while ((mt = re.exec(text)) !== null) {
      const id = mt[1];
      const before = text.lastIndexOf('\n', mt.index);
      const line = before === -1 ? 1 : (text.substring(0, before).match(/\n/g)?.length || 0) + 1;
      const snippet = titles.find(t => t.includes(mt[0])) || '';
      const arr = hitsById.get(id) || [];
      arr.push({ file, line, title: snippet || '' });
      hitsById.set(id, arr);
    }
  }

  return { hitsById, titlesByFile };
}

/* ---------------------------- Report building ---------------------------- */

function buildReport(bpmnEls, hitsById) {
  const allIds = new Set(bpmnEls.map(e => e.id));
  const rows = bpmnEls.map(el => {
    const tests = hitsById.get(el.id) || [];
    const coverage = tests.length > 0 ? 'Covered' : 'Missing';
    return {
      id: el.id,
      name: el.name || '',
      type: String(el.type || '').replace(/^bpmn:/, ''),
      priority: el.meta.priority || '',
      tags: el.meta.tags.join(', '),
      jira: el.meta.jiraKeys.join(', '),
      playwrightRefs: el.meta.playwrightRefs.join(' | '),
      figma: el.meta.figmaUrl || (el.meta.figmaNodeId ? `node:${el.meta.figmaNodeId}` : ''),
      tests: tests.map(t => `${t.file}${t.title ? `#${t.title}` : ''}`).join(' | '),
      coverage
    };
  });

  // tester som pekar på ID som inte finns i BPMN
  const orphanIds = [...hitsById.keys()].filter(id => !allIds.has(id));
  const orphans = orphanIds.flatMap(id => hitsById.get(id).map(h => ({ id, ...h })));

  return { rows, orphans };
}

/* ---------------------------- Formats: CSV + HTML + JSON ---------------------------- */

function toCSV(rows) {
  const header = ['BPMN ID','Name','Type','Priority','Tags','Jira','PlaywrightRefs','Figma','Tests','Coverage'];
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.name, r.type, r.priority, r.tags, r.jira, r.playwrightRefs, r.figma, r.tests, r.coverage
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

// Material-inspirerad HTML (ingen extern JS-ram behövs)
function toHTML(rows, orphans) {
  const style = `
  @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap');

  :root{
    --md-surface:#fff;
    --md-on-surface:#1f2937;
    --md-surface-variant:#f3f4f6;
    --md-outline:#e5e7eb;
    --md-primary:#1a73e8;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0;font-family:Roboto,system-ui,-apple-system,Segoe UI,Arial,sans-serif;color:var(--md-on-surface);background:#fafafa}
  .appbar{position:sticky;top:0;z-index:10;background:var(--md-surface);border-bottom:1px solid var(--md-outline);padding:12px 16px;display:flex;gap:12px;align-items:center}
  .appbar h1{font-size:18px;margin:0;font-weight:600}
  .badge{display:inline-flex;align-items:center;gap:6px;padding:2px 8px;border-radius:999px;font-size:12px;border:1px solid var(--md-outline);background:var(--md-surface-variant)}
  .chip{display:inline-flex;gap:6px;padding:4px 8px;border-radius:999px;font-size:12px;background:var(--md-surface-variant)}
  .container{max-width:1200px;margin:18px auto;padding:0 16px}
  .card{background:var(--md-surface);border:1px solid var(--md-outline);border-radius:16px;box-shadow:0 1px 2px rgb(0 0 0 / 8%);overflow:hidden}
  .card-header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--md-outline)}
  .search{display:flex;align-items:center;gap:8px;border:1px solid var(--md-outline);border-radius:12px;padding:8px 10px;background:#fff;min-width:260px}
  .search input{border:none;outline:none;font-size:14px;width:220px}
  table{width:100%;border-collapse:separate;border-spacing:0}
  thead th{position:sticky;top:0;background:var(--md-surface-variant);text-align:left;font-weight:600;font-size:12px;letter-spacing:.02em;color:#374151;padding:10px;border-bottom:1px solid var(--md-outline)}
  tbody td{padding:10px;border-bottom:1px solid var(--md-outline);vertical-align:top;font-size:14px}
  tbody tr:hover{background:#f9fafb}
  .mono{font-family:ui-monospace,Menlo,Consolas,monospace}
  .pill-ok{background:rgba(34,197,94,.12);color:#065f46;border:1px solid rgba(34,197,94,.25);display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
  .pill-miss{background:rgba(239,68,68,.10);color:#7f1d1d;border:1px solid rgba(239,68,68,.25);display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px}
  .toolbar{display:flex;gap:8px;flex-wrap:wrap}
  .btn{border:1px solid var(--md-outline);background:#fff;border-radius:12px;padding:8px 12px;cursor:pointer;font-size:14px}
  .btn:hover{background:#f3f4f6}
  .section{margin-top:24px}
  a{color:var(--md-primary);text-decoration:none}
  a:hover{text-decoration:underline}
  `;

  const rowsHtml = rows.map(r => `
    <tr data-row>
      <td class="mono">${r.id}</td>
      <td>${r.name || ''}</td>
      <td>${r.type || ''}</td>
      <td>${r.priority ? `<span class="chip">${r.priority}</span>` : ''}</td>
      <td>${r.tags ? r.tags.split(',').map(t=>`<span class="chip">${t.trim()}</span>`).join(' ') : ''}</td>
      <td>${r.jira ? r.jira.split(',').map(j=>`<div><a href="https://jira.example.com/browse/${j.trim()}" target="_blank" rel="noopener">${j.trim()}</a></div>`).join('') : ''}</td>
      <td class="mono">${r.playwrightRefs || ''}</td>
      <td>${r.figma ? `<a href="${r.figma}" target="_blank" rel="noopener">Öppna</a>` : ''}</td>
      <td>${(r.tests || '').split(' | ').filter(Boolean).map(x=>`<div>${x}</div>`).join('')}</td>
      <td>${r.coverage === 'Covered'
        ? '<span class="pill-ok">Covered</span>'
        : '<span class="pill-miss">Missing</span>'}
      </td>
    </tr>
  `).join('');

  const orphansHtml = orphans.length ? `
    <div class="section card">
      <div class="card-header">
        <div style="display:flex;align-items:center;gap:8px">
          <h2 style="margin:0;font-size:16px">Orphan tests</h2>
        </div>
      </div>
      <div style="padding:12px 16px;overflow:auto">
        <table>
          <thead>
            <tr><th>BPMN ID (saknas)</th><th>Fil</th><th>Rad</th><th>Titel</th></tr>
          </thead>
          <tbody>
            ${orphans.map(o => `<tr>
              <td class="mono">${o.id}</td>
              <td class="mono">${o.file}</td>
              <td>${o.line}</td>
              <td>${o.title || ''}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  ` : '';

  return `<!doctype html>
  <html lang="sv">
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>BPMN ↔ Test Coverage</title>
  <style>${style}</style>
  <body>
    <div class="appbar">
      <h1>BPMN ↔ Test Coverage</h1>
      <span class="badge">Genererad: ${new Date().toISOString().replace('T',' ').replace('Z','')}</span>
      <div class="toolbar" style="margin-left:auto">
        <div class="search">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 21l-4.35-4.35m1.6-4.65a6.95 6.95 0 11-13.9 0 6.95 6.95 0 0113.9 0z" stroke="#6b7280" stroke-width="2" stroke-linecap="round"/></svg>
          <input id="q" placeholder="Filtrera (ID, namn, taggar, Jira, status)…" />
        </div>
        <button class="btn" id="show-missing">Visa bara Missing</button>
        <button class="btn" id="reset">Rensa filter</button>
      </div>
    </div>

    <div class="container">
      <div class="card">
        <div class="card-header">
          <div style="display:flex;align-items:center;gap:8px">
            <h2 style="margin:0;font-size:16px">Översikt</h2>
          </div>
          <div style="color:#6b7280;font-size:13px">Rader: ${rows.length} • Orphans: ${orphans.length}</div>
        </div>
        <div style="overflow:auto;max-height:70vh">
          <table id="tbl">
            <thead>
              <tr>
                <th>BPMN ID</th>
                <th>Namn</th>
                <th>Typ</th>
                <th>Prio</th>
                <th>Taggar</th>
                <th>Jira</th>
                <th>PlaywrightRefs</th>
                <th>Figma</th>
                <th>Tester</th>
                <th>Coverage</th>
              </tr>
            </thead>
            <tbody>
              ${rowsHtml}
            </tbody>
          </table>
        </div>
      </div>
      ${orphansHtml}
    </div>

    <script>
      const q = document.getElementById('q');
      const rows = Array.from(document.querySelectorAll('tbody tr[data-row]'));
      const btnMissing = document.getElementById('show-missing');
      const btnReset = document.getElementById('reset');

      function textOfRow(tr){ return tr.innerText.toLowerCase(); }
      function isMissing(tr){ return tr.querySelector('.pill-miss') !== null; }

      function applyFilter(){
        const v = (q.value || '').toLowerCase();
        rows.forEach(tr=>{
          const hit = textOfRow(tr).includes(v);
          tr.style.display = hit ? '' : 'none';
        });
      }
      q.addEventListener('input', applyFilter);

      let onlyMissing = false;
      btnMissing.addEventListener('click', ()=>{
        onlyMissing = !onlyMissing;
        btnMissing.style.fontWeight = onlyMissing ? '600' : '400';
        rows.forEach(tr=>{
          const show = !onlyMissing || isMissing(tr);
          tr.style.display = show ? '' : 'none';
        });
      });

      btnReset.addEventListener('click', ()=>{
        q.value=''; onlyMissing=false; btnMissing.style.fontWeight='400';
        rows.forEach(tr=> tr.style.display='');
      });
    </script>
  </body>
  </html>`;
}

/* ---------------------------- Main ---------------------------- */

function main() {
  if (!fs.existsSync(BPMN_PATH)) {
    console.error(`❌ BPMN-fil saknas: ${BPMN_PATH}`);
    process.exit(1);
  }

  const bpmn = loadBpmn(BPMN_PATH);
  const defs = bpmn['bpmn:definitions'] || bpmn.definitions || bpmn;
  const elements = collectBpmnElements(defs);

  const { hitsById } = scanTestsForBpmnTags();
  const { rows, orphans } = buildReport(elements, hitsById);

  const csv  = toCSV(rows);
  const html = toHTML(rows, orphans);
  const json = JSON.stringify({ rows, orphans }, null, 2);

  // root copies
  writeText(OUT_ROOT_CSV,  csv);
  writeText(OUT_ROOT_HTML, html);
  writeText(OUT_ROOT_JSON, json);

  // pages copies
  writeText(OUT_CSV,  csv);
  writeText(OUT_HTML, html);
  writeText(OUT_JSON, json);

  console.log(`✅ Skapade rapporter:
  - ${path.relative(ROOT, OUT_ROOT_HTML)}
  - ${path.relative(ROOT, OUT_ROOT_CSV)}
  - ${path.relative(ROOT, OUT_ROOT_JSON)}
  - ${path.relative(ROOT, OUT_HTML)}
  - ${path.relative(ROOT, OUT_CSV)}
  - ${path.relative(ROOT, OUT_JSON)}
  `);
}

main();

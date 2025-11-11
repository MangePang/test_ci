#!/usr/bin/env node
/**
 * Generates BPMN ↔︎ Test coverage report (HTML + CSV)
 *
 * - Parses BPMN XML (reads extensionElements: playwrightRef, jiraKeys, figmaUrl/nodeId)
 * - Scans test files for [bpmn:<ID>] in titles
 * - Produces:
 *    - bpmn-test-report.html
 *    - bpmn-test-report.csv
 *    - bpmn-test-report.json (rådata)
 *
 * Customize paths if needed.
 */
import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import { XMLParser } from 'fast-xml-parser';

const ROOT = process.cwd();
const BPMN_PATH = path.join(ROOT, 'ci_test.bpmn');            // ← ändra om du byter namn
const TEST_GLOB = 'tests/**/*.{spec,test}.{ts,tsx,js,jsx}';   // Playwright/Jest format

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: false
});

function loadBpmn(xmlPath) {
  const xml = fs.readFileSync(xmlPath, 'utf8');
  const dom = parser.parse(xml);
  return dom;
}

// Recursiv traversal som hittar alla BPMN-element med id
function collectBpmnElements(obj, tagName='') {
  const out = [];
  const isObject = v => v && typeof v === 'object' && !Array.isArray(v);

  function visit(node, name) {
    if (!node) return;

    // Om node är en array → besök varje
    if (Array.isArray(node)) {
      node.forEach(n => visit(n, name));
      return;
    }

    if (!isObject(node)) return;

    // Har id ⇒ kandidatelelement
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

      // extensionElements?
      const ext = node['bpmn:extensionElements'] || node['extensionElements'];
      if (ext) {
        // Under ext kan finnas egna namespaces, loopa igenom alla barn
        Object.entries(ext).forEach(([k, v]) => {
          const childArr = Array.isArray(v) ? v : [v];
          childArr.filter(Boolean).forEach(ch => {
            if (typeof ch !== 'object') return;
            Object.entries(ch).forEach(([kk, vv]) => {
              const vvArr = Array.isArray(vv) ? vv : [vv];
              vvArr.filter(Boolean).forEach(x => {
                // normalisera nycklar utan namespace
                const key = kk.split(':').pop();

                // barnen kan vara enkla strings eller objekt med _text
                const str = s => {
                  if (typeof s === 'string') return s.trim();
                  if (s && typeof s === 'object') {
                    // fast-xml-parser representerar text som value direkt i objektet
                    // när inga attribut finns; hantera en nivå till
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
                    // ignore others
                    break;
                }
              });
            });
          });
        });
      }

      out.push(el);
    }

    // Fortsätt gå igenom barn
    Object.entries(node).forEach(([k, v]) => {
      if (k.startsWith('@')) return; // attribut
      visit(v, k);
    });
  }

  visit(obj, tagName);
  return out;
}

function scanTestsForBpmnTags() {
  const files = glob.sync(TEST_GLOB, { cwd: ROOT, dot: false, nodir: true });
  const re = /\[bpmn:([^\]]+)\]/g;

  const hitsById = new Map(); // id -> array of { file, line, titleSnippet }
  const titlesByFile = new Map(); // file -> array of titles

  for (const file of files) {
    const full = path.join(ROOT, file);
    const text = fs.readFileSync(full, 'utf8');

    // samla titlar (enkelt heuristiskt)
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
      const snippet = titles.find(t => t.includes(mt[0])) || ''; // hitta ev. titel som innehåller taggen
      const arr = hitsById.get(id) || [];
      arr.push({ file, line, title: snippet || '' });
      hitsById.set(id, arr);
    }
  }

  return { hitsById, titlesByFile };
}

function buildReport(bpmnEls, hitsById) {
  const allIds = new Set(bpmnEls.map(e => e.id));
  const covered = new Set([...hitsById.keys()].filter(id => allIds.has(id)));

  const rows = bpmnEls.map(el => {
    const tests = hitsById.get(el.id) || [];
    const coverage = tests.length > 0 ? 'Covered' : 'Missing';
    return {
      id: el.id,
      name: el.name || '',
      type: el.type.replace(/^bpmn:/, ''),
      priority: el.meta.priority || '',
      tags: el.meta.tags.join(', '),
      jira: el.meta.jiraKeys.join(', '),
      playwrightRefs: el.meta.playwrightRefs.join(' | '),
      figma: el.meta.figmaUrl || (el.meta.figmaNodeId ? `node:${el.meta.figmaNodeId}` : ''),
      tests: tests.map(t => `${t.file}${t.title ? `#${t.title}` : ''}`).join(' | '),
      coverage
    };
  });

  // Orphans: tester som pekar på ID som inte längre finns
  const orphanIds = [...hitsById.keys()].filter(id => !allIds.has(id));
  const orphans = orphanIds.flatMap(id => hitsById.get(id).map(h => ({ id, ...h })));

  return { rows, orphans };
}

function toCSV(rows) {
  const header = ['BPMN ID','Name','Type','Priority','Tags','Jira','PlaywrightRefs','Figma','Tests','Coverage'];
  const esc = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const lines = [header.map(esc).join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.name, r.type, r.priority, r.tags, r.jira, r.playwrightRefs, r.figma, r.tests, r.coverage
    ].map(esc).join(','));
  }
  return lines.join('\n');
}

function toHTML(rows, orphans) {
  const style = `
    body{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #e5e7eb;padding:8px;text-align:left;vertical-align:top}
    th{background:#f9fafb}
    .badge{display:inline-block;padding:2px 6px;border-radius:8px;font-size:12px}
    .ok{background:#dcfce7}
    .miss{background:#fee2e2}
    .mono{font-family:ui-monospace,Menlo,Consolas,monospace}
    h1{margin:0 0 8px 0}
    small{color:#6b7280}
    .section{margin-top:24px}
  `;
  const rowsHtml = rows.map(r => `
    <tr>
      <td class="mono">${r.id}</td>
      <td>${r.name}</td>
      <td>${r.type}</td>
      <td>${r.priority || ''}</td>
      <td>${r.tags || ''}</td>
      <td>${r.jira || ''}</td>
      <td class="mono">${r.playwrightRefs || ''}</td>
      <td>${r.figma ? `<a href="${r.figma}" target="_blank">Open</a>` : ''}</td>
      <td>${(r.tests || '').split(' | ').map(x => x ? `<div>${x}</div>` : '').join('')}</td>
      <td>${r.coverage === 'Covered'
        ? '<span class="badge ok">Covered</span>'
        : '<span class="badge miss">Missing</span>'}
      </td>
    </tr>
  `).join('');

  const orphansHtml = orphans.length ? `
    <div class="section">
      <h2>Orphan tests (refererar [bpmn:ID] som inte finns)</h2>
      <table>
        <thead><tr><th>BPMN ID (saknas)</th><th>Fil</th><th>Rad</th><th>Titel</th></tr></thead>
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
  ` : '<div class="section"><h2>Orphan tests</h2><small>Inga.</small></div>';

  return `<!doctype html><meta charset="utf-8">
  <title>BPMN ↔︎ Test Coverage Report</title>
  <style>${style}</style>
  <h1>BPMN ↔︎ Test Coverage Report</h1>
  <small>Genererad: ${new Date().toISOString()}</small>
  <div class="section">
    <table>
      <thead>
        <tr>
          <th>BPMN ID</th><th>Name</th><th>Type</th><th>Priority</th><th>Tags</th>
          <th>Jira</th><th>PlaywrightRefs</th><th>Figma</th><th>Tests</th><th>Coverage</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}</tbody>
    </table>
  </div>
  ${orphansHtml}
  `;
}

function main() {
  if (!fs.existsSync(BPMN_PATH)) {
    console.error(`BPMN-fil saknas: ${BPMN_PATH}`);
    process.exit(1);
  }

  const bpmn = loadBpmn(BPMN_PATH);
  const defs = bpmn['bpmn:definitions'] || bpmn.definitions || bpmn;
  // samla alla element under definitions
  const elements = collectBpmnElements(defs);

  const { hitsById } = scanTestsForBpmnTags();
  const { rows, orphans } = buildReport(elements, hitsById);

  // outputs
  const csv = toCSV(rows);
  const html = toHTML(rows, orphans);
  const json = JSON.stringify({ rows, orphans }, null, 2);

  fs.writeFileSync(path.join(ROOT, 'bpmn-test-report.csv'), csv, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'bpmn-test-report.html'), html, 'utf8');
  fs.writeFileSync(path.join(ROOT, 'bpmn-test-report.json'), json, 'utf8');

  console.log(`✅ Skapade:
  - bpmn-test-report.html
  - bpmn-test-report.csv
  - bpmn-test-report.json`);
}

main();

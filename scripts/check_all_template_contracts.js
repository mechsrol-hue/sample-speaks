#!/usr/bin/env node
// Contract-check every template on disk. Part of `npm test` so any session — human
// or agent — can prove the templates are renderable before shipping a change.
'use strict';
const fs = require('fs');
const path = require('path');
const { validateTemplateContract } = require('../server/agent/template-contract');

const dir = path.join(__dirname, '..', 'public', 'is_templates');
let failed = 0;
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.json')).sort()) {
    let tpl;
    try { tpl = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
    catch (e) { failed++; console.error(`FAIL ${f}: unreadable JSON — ${e.message}`); continue; }
    const r = validateTemplateContract(tpl);
    if (!r.ok) { failed++; console.error(`FAIL ${f}`); r.errors.forEach(e => console.error(`   E: ${e}`)); }
    r.warnings.forEach(w => console.log(`   W: ${f}: ${w}`));
}
if (failed) { console.error(`${failed} template(s) fail the contract.`); process.exit(1); }
console.log('all templates pass the contract.');

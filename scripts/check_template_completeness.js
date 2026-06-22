#!/usr/bin/env node
/**
 * Completeness CLI for the IS report agent — ONE clean command.
 *
 *   node scripts/check_template_completeness.js <transcriptFile> <templateJsonPath>
 *
 * <transcriptFile>   the agent's OWN full read of the PDF (clean vision text). The agent must
 *                    Write its transcription to a file first — pdfplumber mangles the
 *                    size-designation clause, so we rely on the agent's read for the DN list.
 * <templateJsonPath> the draft template the agent produced.
 *
 * Verifies dimensionGrid covers every DN the standard specifies, and every referenced dimension
 * table is represented (via each param's sourceTable). Prints a JSON report; exits 0 (complete)
 * or 1 (incomplete — re-read the listed pages). The agent MUST run this and resolve before finishing.
 */
'use strict';
const fs = require('fs');
const C = require('../server/pipeline/completeness');

const [, , transcriptFile, tplPath] = process.argv;
if (!transcriptFile || !tplPath) {
  console.error('usage: check_template_completeness.js <transcriptFile> <templateJsonPath>');
  process.exit(2);
}

let fullText = '';
try { fullText = fs.readFileSync(transcriptFile, 'utf8'); }
catch (e) { console.error('cannot read transcript:', e.message); process.exit(2); }

let tpl;
try { tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8')); }
catch (e) { console.error('cannot read template:', e.message); process.exit(2); }

const rep = C.checkTemplateCompleteness(tpl, fullText);
console.log(JSON.stringify(rep, null, 2));
process.exit(rep.complete ? 0 : 1);

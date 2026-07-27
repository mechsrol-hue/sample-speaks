#!/usr/bin/env node
/**
 * Register an agent-format IS template into is_standards_vault WITHOUT the Agent SDK.
 * Replicates exactly what server.js /agent-extract does after a successful run
 * (vaultRow shape at server.js ~3148): testParameters v3 projection, dimensionData,
 * fullText from the transcript. Reuses the server's own supabase client + projector.
 *
 *   node scratch/register_template.js <SLUG> <originalPdfName>
 *   e.g. node scratch/register_template.js IS_368_2014 "IS 368 _ 2014.pdf"
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const supabase = require(path.join(REPO, 'database-supabase'));
const { agentTemplateToVaultParams } = require(path.join(REPO, 'server/agent/template-to-vault'));

const [, , slug, pdfName] = process.argv;
if (!slug) { console.error('usage: register_template.js <SLUG> [originalPdfName]'); process.exit(2); }

// The standalone IS Intelligence port (separate app, same Supabase vault) serves its own
// public/is_templates — mirror every template there so both UIs render the clause-by-clause view.
const MIRROR_DIR = '/Users/saurabh/Desktop/Antigravity/is-intelligence-app/public/is_templates';

(async () => {
  const tplPath = path.join(REPO, 'public/is_templates', `${slug}.json`);
  const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  if (fs.existsSync(MIRROR_DIR)) {
    fs.copyFileSync(tplPath, path.join(MIRROR_DIR, `${slug}.json`));
    console.log(`[register] mirrored template to is-intelligence-app`);
  }
  const isNumber = tpl.isNumber || '';
  if (!isNumber) throw new Error('template has no isNumber');

  const vaultParams = agentTemplateToVaultParams(tpl);
  let fullText = '';
  const tp = path.join(REPO, 'scratch', `${slug}_transcript.txt`);
  if (fs.existsSync(tp)) fullText = fs.readFileSync(tp, 'utf8');

  const vaultRow = {
    isNumber,
    title: tpl.title || '',
    pdfFileName: pdfName || `${slug}.pdf`,
    confidenceScore: 1.0,
    isFullyResolved: true,
    uploadedAt: new Date().toISOString(),
    testParameters: JSON.stringify({
      version: 3,
      flat: vaultParams.flat,
      sections: vaultParams.sections,
      referenced_standards: vaultParams.referenced_standards,
    }),
    dimensionData: JSON.stringify({
      parameterizationDims: tpl.parameterizationDims || [],
      dimensionOptions: tpl.dimensionOptions || {},
      defaults: tpl.defaults || {},
    }),
    ...(fullText ? { fullText } : {}),
  };

  console.log(`[register] ${isNumber}: ${vaultParams.flat.length} flat rows from ${(tpl.parameters || []).length} parameters; fullText ${fullText.length} chars`);
  const { data: existing, error: selErr } = await supabase.from('is_standards_vault').select('id').eq('isNumber', isNumber).limit(1);
  if (selErr) throw selErr;
  if (existing && existing.length) {
    const { error } = await supabase.from('is_standards_vault').update(vaultRow).eq('id', existing[0].id);
    if (error) throw error;
    console.log(`[register] UPDATED vault row id ${existing[0].id} for ${isNumber}`);
  } else {
    const { data: ins, error } = await supabase.from('is_standards_vault').insert(vaultRow).select('id');
    if (error) throw error;
    console.log(`[register] INSERTED vault row id ${ins && ins[0] ? ins[0].id : '?'} for ${isNumber}`);
  }
})().catch(e => { console.error('[register] FAILED:', e.message); process.exit(1); });

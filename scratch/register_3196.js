// One-off recovery: IS 3196 was extracted successfully (file on disk) but the (Part 1) regex bug
// skipped its vault registration. This upserts the vault row from the existing template — same
// logic as the /agent-extract endpoint. Idempotent.
const supabase = require('../database-supabase');
const fs = require('fs');
const path = require('path');

const tplPath = path.join(__dirname, '..', 'public/is_templates/IS_3196_Part_1_2013.json');
const tpl = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
const isNumber = tpl.isNumber;
const vaultRow = {
  isNumber,
  title: tpl.title || '',
  pdfFileName: 'IS 3196 _ Part 1 _ 2013.pdf',
  confidenceScore: 1.0,
  isFullyResolved: true,
  uploadedAt: new Date().toISOString(),
};

(async () => {
  const { data: existing, error: selErr } = await supabase
    .from('is_standards_vault').select('id').eq('isNumber', isNumber).limit(1);
  if (selErr) throw selErr;
  if (existing && existing.length) {
    const { error } = await supabase.from('is_standards_vault').update(vaultRow).eq('id', existing[0].id);
    if (error) throw error;
    console.log('UPDATED existing vault row id', existing[0].id, 'for', isNumber);
  } else {
    const { data: ins, error } = await supabase.from('is_standards_vault').insert(vaultRow).select('id');
    if (error) throw error;
    console.log('INSERTED vault row id', ins && ins[0] && ins[0].id, 'for', isNumber);
  }
  const { data: all } = await supabase.from('is_standards_vault').select('isNumber');
  console.log('vault now has', all ? all.length : '?', 'standards:', (all || []).map(r => r.isNumber).join(' | '));
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });

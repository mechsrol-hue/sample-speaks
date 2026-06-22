// READ-ONLY probe: is IS 4985 still in the vault + conformance limits?
// Does only SELECT/count — never writes. Safe to run alongside other dev.
const supabase = require('../database-supabase');

(async () => {
    // 1. Everything in the vault
    const { data: vault, error: vErr } = await supabase
        .from('is_standards_vault')
        .select('id, isNumber, title, pdfFileName, confidenceScore, uploadedAt')
        .order('uploadedAt', { ascending: false });
    console.log('=== is_standards_vault ===');
    if (vErr) console.log('ERROR:', vErr.message || vErr);
    else {
        console.log(`rows: ${vault.length}`);
        vault.forEach(r => console.log(`  [${r.id}] ${r.isNumber}  conf=${r.confidenceScore}  file=${r.pdfFileName}  at=${r.uploadedAt}`));
    }

    // 2. Specifically any 4985 row
    const { data: is4985, error: e4985 } = await supabase
        .from('is_standards_vault')
        .select('id, isNumber, uploadedAt')
        .ilike('isNumber', '%4985%');
    console.log('\n=== rows matching 4985 ===');
    if (e4985) console.log('ERROR:', e4985.message || e4985);
    else console.log(`rows: ${is4985.length}`, JSON.stringify(is4985));

    // 3. Conformance limits for 4985 (what LIMS reads)
    const { data: lim, error: lErr } = await supabase
        .from('is_conformance_limits')
        .select('id, isNumber, varietyTag')
        .ilike('isNumber', '%4985%');
    console.log('\n=== is_conformance_limits matching 4985 ===');
    if (lErr) console.log('ERROR:', lErr.message || lErr);
    else {
        console.log(`rows: ${lim.length}`);
        const varieties = [...new Set(lim.map(l => l.varietyTag))];
        console.log('distinct varietyTags:', varieties.length, JSON.stringify(varieties.slice(0, 10)));
    }
    process.exit(0);
})();

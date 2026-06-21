// Local deterministic template auditor.
// Re-extracts BIS testing-charge PDFs (pdftotext -layout) with a regex parser,
// compares against templates stored in system_preferences, and writes:
//   docs/TEMPLATE_AUDIT.md          - human-readable old-vs-new audit
//   scripts/corrected_templates.json - corrected templates ready to commit
// No cloud calls. Run: node scripts/audit_templates.js [--commit]
//   --commit  also upserts corrected templates into system_preferences,
//             backing up old values under template_backup_IS X.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const supabase = require('../database-supabase');

const PDF_DIR = path.join(__dirname, '..', 'Testing Charges', 'Testing charges BIS 09.2.2026');
const TMP_DIR = '/tmp';

const TARGET_STANDARDS = [
    'IS 14756', 'IS 9873', 'IS 2185', 'IS 269', 'IS 4246', 'IS 14735', 'IS 1660', 'IS 1038',
    'IS 3196', 'IS 4985', 'IS 4413', 'IS 4283',
    'IS 303', 'IS 12330', 'IS 2556', 'IS 455', 'IS 710', 'IS 1489'
];

// ---------------------------------------------------------------------------
// 1. Text extraction (pdftotext -layout keeps column alignment)
// ---------------------------------------------------------------------------
function extractAllText() {
    const files = fs.readdirSync(PDF_DIR).filter(f => f.endsWith('.pdf'));
    let combined = '';
    for (const f of files) {
        const txtPath = path.join(TMP_DIR, 'tc_' + f.replace(/[ ()&]/g, '_') + '.txt');
        if (!fs.existsSync(txtPath)) {
            execSync(`pdftotext -layout "${path.join(PDF_DIR, f)}" "${txtPath}"`);
        }
        combined += '\n\n' + fs.readFileSync(txtPath, 'utf8');
    }
    return combined;
}

// ---------------------------------------------------------------------------
// 2. Section splitting - every "TESTING CHARGES FOR IS XXXX" heading starts a
//    section; a given IS can appear multiple times (revisions). We parse all
//    and keep the best section per IS.
// ---------------------------------------------------------------------------
function splitSections(text) {
    // Collect EVERY "testing charges for ..." heading as a boundary marker, even
    // ones we can't resolve to a target IS. This guarantees each table is bounded
    // by the *next* heading, so no slice can swallow a neighbouring standard's
    // table (the cause of the 1000h+ row-sum bleed).
    const boundaryRe = /testing\s+charges\s+for\b/gi;
    const boundaries = [];
    let bm;
    while ((bm = boundaryRe.exec(text)) !== null) boundaries.push(bm.index);
    boundaries.push(text.length);

    // Resolve which IS each boundary heading refers to, by reading the heading
    // line itself (handles both "...FOR IS 4985" and "...as per IS 14735").
    const isRe = /\bIS[\s:]*(\d{3,5})/i;
    const sections = [];
    for (let i = 0; i < boundaries.length - 1; i++) {
        const start = boundaries[i];
        const end = boundaries[i + 1];
        const headingLine = text.slice(start, start + 200);
        const m = headingLine.match(isRe);
        if (!m) continue;
        sections.push({ isNumber: m[1], body: text.slice(start, end) });
    }
    return sections;
}

// ---------------------------------------------------------------------------
// 3. Row parsing - layout columns separated by 2+ spaces.
//    Hours cell can be: number, fraction, or an inactive marker
//    ("Test facility not available", "As per IS XXXX", @, *, --, N/A).
// ---------------------------------------------------------------------------
const FRAC = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 0.33, '⅔': 0.67, '⅛': 0.125 };

function parseHoursCell(raw) {
    if (!raw) return { hours: null, inactive: true, note: 'empty' };
    raw = raw.trim();
    if (/test\s+facility\s+not\s+available/i.test(raw)) return { hours: null, inactive: true, note: 'facility N/A' };
    if (/as\s+per\s+IS/i.test(raw)) return { hours: null, inactive: true, note: raw };
    if (/^[@*]+$|^--$|^—$|^N\/?A$/i.test(raw)) return { hours: null, inactive: true, note: 'marked inactive' };
    const mixed = raw.match(/^([\d.]+)\s*([½¼¾⅓⅔⅛])$/);
    if (mixed) return { hours: parseFloat(mixed[1]) + FRAC[mixed[2]], inactive: false };
    if (FRAC[raw] !== undefined) return { hours: FRAC[raw], inactive: false };
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0 && n <= 200) return { hours: n, inactive: false };
    return { hours: null, inactive: true, note: raw.slice(0, 30) };
}

function parseSection(section) {
    const lines = section.body.split('\n');
    const clauses = {};
    let totalDeclared = 0;
    let rowsParsed = 0;
    let sumActive = 0;

    for (const line of lines) {
        // A "TOTAL TIME / TOTAL MAN HOURS" line ends the table. BIS prints it in
        // many layouts — "TOTAL TIME : 9", "TOTAL TIME 15 15" (two cols),
        // "Total Man Hours 29.0". Grab the LAST plausible numeric token on the line.
        if (/\bTOTAL\s*(?:TIME|MAN[-\s]*HOURS?)/i.test(line)) {
            const nums = (line.match(/\d+(?:\.\d+)?(?:\s*[½¼¾⅓⅔⅛])?|[½¼¾⅓⅔⅛]/g) || [])
                .map(t => parseHoursCell(t).hours)
                .filter(h => h !== null && h > 0 && h <= 200);
            if (nums.length) totalDeclared = nums[nums.length - 1];
            // Everything after TOTAL (footer, signatures, stale revisions) must NOT
            // be summed — that was the source of the 1000h+ bleed. Stop here.
            break;
        }

        // Report preparation row (often unnumbered)
        const rp = line.match(/PREPARATION\s+OF\s+TEST\s+REPORT\s{2,}([\d.½¼¾]+)\s*$/i);
        if (rp) {
            const p = parseHoursCell(rp[1]);
            clauses['Report Prep'] = { active: !p.inactive, activeHours: p.hours || 0, passiveHours: 0, equipment: '', name: 'Preparation of Test Report' };
            if (p.hours) sumActive += p.hours;
            continue;
        }

        // Numbered test rows: "1.   Name    clause    hours-or-marker"
        const cols = line.trim().split(/\s{2,}/);
        if (cols.length < 2) continue;
        if (!/^\d{1,2}\.?$/.test(cols[0])) continue;

        const hoursCell = cols[cols.length - 1];
        const p = parseHoursCell(hoursCell);
        // Middle columns: clause ref is a bare dotted number; rest is the name
        let clauseRef = '', nameParts = [];
        for (let i = 1; i < cols.length - 1; i++) {
            if (/^(?:Cl\.?\s*)?\d[\d.]*(?:\s*&\s*\d[\d.]*)?$/.test(cols[i].trim())) clauseRef = cols[i].trim();
            else nameParts.push(cols[i].trim());
        }
        const name = nameParts.join(' ').replace(/\s+/g, ' ').trim();
        if (!name) continue;
        // Skip header-ish rows
        if (/^(sl|sr|s\.?\s*no|characteristics|clause|man[-\s]*hours)/i.test(name)) continue;

        let key = clauseRef || name.slice(0, 40);
        let dup = 2;
        while (clauses[key]) key = `${clauseRef || name.slice(0, 40)} (${dup++})`;
        clauses[key] = { active: !p.inactive, activeHours: p.hours || 0, passiveHours: 0, equipment: '', name, note: p.note || undefined };
        rowsParsed++;
        if (!p.inactive && p.hours) sumActive += p.hours;
    }

    return { isNumber: `IS ${section.isNumber}`, clauses, totalDeclared, rowsParsed, sumActive };
}

function bestSectionPerIS(sections) {
    const byIS = {};
    for (const sec of sections) {
        const parsed = parseSection(sec);
        if (parsed.rowsParsed === 0) continue;
        const key = parsed.isNumber;
        // A section that exposes a BIS-declared TOTAL dominates: that total is the
        // billable, authoritative figure. Among total-bearing sections prefer the
        // one whose summed rows best corroborate the declared total (smallest gap).
        let score;
        if (parsed.totalDeclared > 0) {
            const gap = Math.abs(parsed.totalDeclared - parsed.sumActive) / parsed.totalDeclared;
            score = 100000 - gap * 1000 + parsed.rowsParsed;
        } else {
            score = parsed.rowsParsed; // no total -> weakest, only wins if nothing better
        }
        if (!byIS[key] || score > byIS[key].score) byIS[key] = { ...parsed, score };
    }
    return byIS;
}

// ---------------------------------------------------------------------------
// 4. Compare with DB templates and report
// ---------------------------------------------------------------------------
async function main() {
    const commit = process.argv.includes('--commit');
    console.log('Extracting text from PDFs (local, deterministic)...');
    const text = extractAllText();
    const sections = splitSections(text);
    console.log(`Found ${sections.length} IS sections in PDFs`);
    const parsed = bestSectionPerIS(sections);

    const { data: prefs } = await supabase.from('system_preferences').select('key, value').like('key', 'template_IS%');
    const dbTemplates = {};
    (prefs || []).forEach(r => {
        const v = typeof r.value === 'string' ? JSON.parse(r.value) : r.value;
        dbTemplates[r.key.replace('template_', '')] = v;
    });

    let md = `# Template Audit — local deterministic re-extraction\n\nGenerated: ${new Date().toISOString()}\nSource: Testing charges BIS 09.2.2026 (pdftotext, no cloud/LLM)\n\n| IS | DB hours | PDF declared total | PDF row-sum (active) | Verdict |\n|---|---|---|---|---|\n`;
    const corrected = {};

    for (const is of TARGET_STANDARDS) {
        const db = dbTemplates[is];
        const pdf = parsed[is];
        if (!pdf) {
            md += `| ${is} | ${db ? db.totalHours : '—'} | NOT FOUND in PDFs | — | ⚠️ needs manual review |\n`;
            continue;
        }
        const hasDeclared = pdf.totalDeclared > 0;
        // Authoritative figure = BIS declared total. Row-sum is only a corroborating
        // cross-check (and is unreliable on tables whose last column isn't man-hours,
        // e.g. gas-stove pressure/flow values). NEVER fall back to row-sum as the total.
        const pdfTotal = hasDeclared ? pdf.totalDeclared : null;
        const dbTotal = db ? db.totalHours : null;
        const sumOK = hasDeclared && Math.abs(pdf.totalDeclared - pdf.sumActive) / pdf.totalDeclared <= 0.25;

        let verdict;
        if (!hasDeclared) verdict = '🔍 no clean total — needs local-LLM/OIC pass';
        else if (dbTotal === null) verdict = '🆕 missing in DB';
        else if (Math.abs(dbTotal - pdfTotal) / Math.max(pdfTotal, 1) <= 0.1) verdict = '✅ matches';
        else verdict = `❌ DB off by ${(dbTotal - pdfTotal) > 0 ? '+' : ''}${(dbTotal - pdfTotal).toFixed(1)}h`;
        md += `| ${is} | ${dbTotal ?? '—'} | ${hasDeclared ? pdf.totalDeclared : '—'} | ${pdf.sumActive.toFixed(1)} | ${verdict} |\n`;

        // MERGE, don't replace: correcting the headline totalHours is the high-value,
        // low-risk fix (it's what drives the auto-assigner's load math). Preserve any
        // OIC-curated clause/equipment data on the existing template — the parser
        // can't recover equipment mappings, and clobbering them would degrade the
        // machine-bottleneck feature. Parsed clauses are only used when none exist.
        corrected[is] = {
            ...(db || {}),
            isNumber: is,
            productName: (db && db.productName) || '',
            totalHours: pdfTotal,                              // null when no declared total
            tatDays: (db && db.tatDays) || 7,
            activeClauses: (db && db.activeClauses && Object.keys(db.activeClauses).length) ? db.activeClauses : pdf.clauses,
            parsedClauses: pdf.clauses,                        // keep parse for OIC review
            rowSum: Math.round(pdf.sumActive * 10) / 10,       // cross-check only
            _oldTotalHours: db ? db.totalHours : null,
            // high  = declared total, rows corroborate -> safe to auto-commit
            // review= declared total, rows disagree     -> commit total, flag clauses
            // low   = no declared total                 -> DO NOT auto-commit, enrich locally
            confidence: !hasDeclared ? 'low' : (sumOK ? 'high' : 'review'),
            source: 'local-deterministic pdftotext 2026-06-13',
            samplesPerRun: (db && db.samplesPerRun) || 1
        };
    }

    md += `\n## Per-IS clause detail (corrected)\n`;
    for (const is of Object.keys(corrected)) {
        const t = corrected[is];
        md += `\n### ${is} — total ${t.totalHours}h (confidence: ${t.confidence})\n`;
        for (const [k, c] of Object.entries(t.activeClauses)) {
            md += `- ${c.active ? '🟢' : '⚪'} \`${k}\` ${c.name} — ${c.active ? c.activeHours + 'h' : (c.note || 'inactive')}\n`;
        }
    }

    fs.mkdirSync(path.join(__dirname, '..', 'docs'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'TEMPLATE_AUDIT.md'), md);
    fs.writeFileSync(path.join(__dirname, 'corrected_templates.json'), JSON.stringify(corrected, null, 2));
    console.log('Wrote docs/TEMPLATE_AUDIT.md and scripts/corrected_templates.json');

    const lowConf = Object.entries(corrected).filter(([, t]) => t.confidence === 'low').map(([is]) => is);
    md += `\n## Needs local-LLM / OIC enrichment (no clean declared total)\n${lowConf.length ? lowConf.map(is => `- ${is}`).join('\n') : '- none'}\n`;
    fs.writeFileSync(path.join(__dirname, '..', 'docs', 'TEMPLATE_AUDIT.md'), md);

    if (commit) {
        // Read existing backups ONCE so re-running --commit never overwrites a true
        // original with an already-corrected value (idempotent backup).
        const { data: backupRows } = await supabase.from('system_preferences').select('key').like('key', 'template_backup_IS%');
        const existingBackups = new Set((backupRows || []).map(r => r.key));

        for (const [is, tmpl] of Object.entries(corrected)) {
            // Only auto-commit standards with a trustworthy BIS-declared total.
            // 'low' (no declared total) is left for the local-LLM enrichment pass.
            if (tmpl.confidence !== 'high' && tmpl.confidence !== 'review') {
                console.log(`Skipped ${is} — confidence=${tmpl.confidence}, needs local-LLM/OIC pass`);
                continue;
            }
            const old = dbTemplates[is];
            const backupKey = `template_backup_${is}`;

            // Back up the ORIGINAL exactly once. For a brand-new template (no prior
            // row) write a tombstone so rollback can DELETE it rather than leave it.
            if (!existingBackups.has(backupKey)) {
                const backupValue = old ? JSON.stringify(old) : JSON.stringify({ __absent: true });
                const { error: bErr } = await supabase.from('system_preferences').upsert({ key: backupKey, value: backupValue }, { onConflict: 'key' });
                if (bErr) {
                    // A failed backup must abort the overwrite — never overwrite unrecoverably.
                    console.error(`ABORT ${is}: backup failed (${bErr.message}); template left unchanged`);
                    continue;
                }
                existingBackups.add(backupKey);
            }

            const { error: wErr } = await supabase.from('system_preferences').upsert({ key: `template_${is}`, value: JSON.stringify(tmpl) }, { onConflict: 'key' });
            if (wErr) { console.error(`Write failed for ${is}: ${wErr.message}`); continue; }
            console.log(`Committed ${is} (${tmpl.totalHours}h, ${tmpl.confidence}) — ${old ? 'original backed up' : 'tombstone backup (new template)'}`);
        }
    }
}

main().catch(e => { console.error(e); process.exit(1); });

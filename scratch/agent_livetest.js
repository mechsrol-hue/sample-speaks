#!/usr/bin/env node
'use strict';
/**
 * Live-test harness for the IS Report Agent (server/agent/is-report-agent.js).
 *
 *   node scratch/agent_livetest.js            # both 4985 + 13592
 *   node scratch/agent_livetest.js 4985       # just 4985
 *   node scratch/agent_livetest.js 13592      # just 13592
 *
 * Runs the SAME in-process agent loop the /agent-extract endpoint uses, directly on the
 * source PDFs (no HTTP). Streams the agent's reasoning, then INDEPENDENTLY re-runs the
 * completeness CLI on the produced transcript+template and reports PASS/FAIL.
 *
 * Requires ANTHROPIC_API_KEY in .env. Cost ≈ ~$1 per standard, one-time.
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { runReportAgent, slugify } = require('../server/agent/is-report-agent');

const REPO = path.join(__dirname, '..');

const TARGETS = {
  '4985': {
    isHint: 'IS 4985:2021',
    pdf: path.join(REPO, 'scratch/isp_362a81a3d8efc1f4.pdf'), // in-repo, "IS 4985 : 2021"
  },
  '13592': {
    isHint: 'IS 13592:2013',
    pdf: '/Users/saurabh/Downloads/IS 13592 _ 2013.pdf',
  },
  '1786': {
    isHint: 'IS 1786:2008',
    pdf: '/Users/saurabh/Downloads/IS 1786 _ 2008.pdf',  // steel reinforcement bars — non-pipe; generality test
  },
};

function reCheckCompleteness(slug) {
  const transcript = path.join(REPO, `scratch/${slug}_transcript.txt`);
  const template = path.join(REPO, `public/is_templates/${slug}.json`);
  if (!fs.existsSync(transcript) || !fs.existsSync(template)) {
    return { ran: false, why: `missing ${!fs.existsSync(transcript) ? 'transcript' : 'template'}` };
  }
  try {
    const out = execFileSync('node', ['scripts/check_template_completeness.js', transcript, template], { cwd: REPO }).toString();
    return { ran: true, complete: true, report: JSON.parse(out) };
  } catch (e) {
    // CLI exits 1 when incomplete — stdout still holds the JSON report
    const stdout = (e.stdout || '').toString();
    let report = null; try { report = JSON.parse(stdout); } catch (_) {}
    return { ran: true, complete: false, report };
  }
}

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('\n❌ ANTHROPIC_API_KEY not set in .env.');
    console.error('   Add it (console.anthropic.com → API keys), then re-run this script.\n');
    process.exit(1);
  }

  const which = (process.argv[2] || '13592').toLowerCase();  // default: ONE standard (trial-budget safe)
  const keys = which === 'both' ? Object.keys(TARGETS) : [which];
  const summary = [];

  // Trial-budget guard: with only ~$5 of credit, don't START a second standard if the spend
  // so far suggests the next run could blow the cap. Override with TRIAL_BUDGET_USD=999.
  const TRIAL_BUDGET = parseFloat(process.env.TRIAL_BUDGET_USD || '5');
  let spent = 0;

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const t = TARGETS[k];
    if (!t) { console.error(`unknown target "${k}" — use 4985 | 13592 | both`); continue; }
    if (!fs.existsSync(t.pdf)) { console.error(`\n❌ ${k}: PDF not found at ${t.pdf}\n`); summary.push({ k, ok: false, note: 'PDF missing' }); continue; }

    // Before a SECOND+ run, check we have headroom (assume the next run could cost as much as the last).
    if (i > 0 && spent > 0) {
      const projected = spent * 2;  // worst case: next run ~= previous run
      if (projected > TRIAL_BUDGET) {
        console.log(`\n⏸  Stopping before "${k}": spent $${spent.toFixed(2)} so far; a second run could reach ~$${projected.toFixed(2)} > $${TRIAL_BUDGET} trial cap.`);
        console.log(`   Re-run just this one when ready:  node scratch/agent_livetest.js ${k}    (or raise TRIAL_BUDGET_USD=)`);
        summary.push({ k, ok: false, note: 'skipped — trial budget guard' });
        break;
      }
    }

    console.log(`\n${'='.repeat(70)}\n▶  AGENT LIVE TEST — ${t.isHint}\n   PDF: ${t.pdf}\n${'='.repeat(70)}`);
    const started = Date.now();
    const out = await runReportAgent(t.pdf, {
      isHint: t.isHint,
      maxTurns: 50,
      onEvent: (line) => process.stdout.write(line.endsWith('\n') ? line : line + '\n'),
    });
    const secs = ((Date.now() - started) / 1000).toFixed(0);
    const cost = typeof out.costUsd === 'number' ? out.costUsd : null;
    if (cost != null) spent += cost;
    const costStr = cost != null ? `$${cost.toFixed(2)}` : 'n/a';

    if (!out.ok) {
      console.error(`\n❌ ${k}: agent FAILED after ${secs}s (cost ${costStr}) — ${out.error}`);
      summary.push({ k, ok: false, secs, cost, note: out.error });
      continue;
    }
    const slug = slugify(out.isNumber || t.isHint);
    const chk = reCheckCompleteness(slug);
    console.log(`\n✓ ${k}: agent finished in ${secs}s`);
    console.log(`   isNumber:  ${out.isNumber}`);
    console.log(`   template:  ${out.templatePath}`);
    console.log(`   cost:      ${costStr}   (turns: ${out.numTurns ?? '?'})   running total: $${spent.toFixed(2)}`);
    console.log(`   summary:   ${out.summary}`);
    if (chk.ran) {
      const r = chk.report || {};
      console.log(`   completeness (independent re-check): ${chk.complete ? 'PASS ✅' : 'FLAGGED ⚠️'}`);
      if (r.expectedDn) console.log(`     DN expected: ${r.expectedDn.length} | grid: ${(r.gridKeys || []).length} | missing: ${JSON.stringify(r.missingDn || [])}`);
    } else {
      console.log(`   completeness re-check skipped: ${chk.why}`);
    }
    summary.push({ k, ok: true, secs, cost, isNumber: out.isNumber, complete: chk.complete, slug });
  }

  console.log(`\n${'='.repeat(70)}\nSUMMARY   (total spend: $${spent.toFixed(2)} of $${TRIAL_BUDGET} trial)`);
  for (const s of summary) {
    const c = typeof s.cost === 'number' ? `$${s.cost.toFixed(2)}` : '   -';
    console.log(`  ${s.ok ? '✓' : '✗'} ${s.k.padEnd(6)} ${c.padStart(6)}  ${s.ok ? `${s.secs}s  ${s.isNumber}  completeness=${s.complete ? 'PASS' : 'FLAGGED'}` : s.note}`);
  }
  console.log('='.repeat(70) + '\n');
  process.exit(summary.every(s => s.ok) ? 0 : 1);
})();

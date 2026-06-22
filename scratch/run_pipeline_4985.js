// Drive the live is-pipeline on the real IS 4985 PDF and report the result + row counts.
require('dotenv').config();
const fs = require('fs');
const pipeline = require('../server/pipeline/is-pipeline');

(async () => {
    const buf = fs.readFileSync('/Users/saurabh/Desktop/Antigravity/Office/4985.pdf');
    const jobId = pipeline.startPipeline(buf, '4985.pdf');
    console.log('jobId:', jobId);
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let lastPhase = -1, lastLogLen = 0;
    for (let i = 0; i < 220; i++) {
        await sleep(4000);
        const j = pipeline.getJob(jobId);
        if (!j) { console.log('job vanished'); break; }
        if (j.phase !== lastPhase) { console.log(`\n[phase ${j.phase} · ${j.progress}%] ${j.phaseLabel}`); lastPhase = j.phase; }
        // stream new log lines
        if (j.log.length > lastLogLen) { j.log.slice(lastLogLen).forEach(l => console.log('   ', l)); lastLogLen = j.log.length; }
        if (j.status !== 'running') {
            console.log('\n=== FINAL STATUS:', j.status, '===', `(${Math.round(j.elapsedMs/1000)}s)`);
            if (j.error) console.log('ERROR:', j.error);
            if (j.result) console.log('RESULT:', JSON.stringify(j.result, null, 2));
            break;
        }
    }
    process.exit(0);
})();

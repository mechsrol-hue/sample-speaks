const fs = require('fs');
const jsdom = require('jsdom');
const { JSDOM } = jsdom;
const html = fs.readFileSync('public/index.html', 'utf8');
const dom = new JSDOM(html);
const document = dom.window.document;

const kpiRow = document.querySelector('#tab-new-sample-receive .kpi-row');
if (kpiRow) console.log('Found kpiRow');
const nsrPending = document.getElementById('nsr-sub-pending');
if (nsrPending) {
    console.log('nsrPending children count:', nsrPending.children.length);
    Array.from(nsrPending.children).forEach(child => {
        console.log('child id:', child.id, 'class:', child.className);
    });
}

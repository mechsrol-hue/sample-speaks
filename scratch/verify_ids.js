const fs = require('fs');
let html = fs.readFileSync('public/index.html', 'utf8');

// Replace Dashboard IDs
html = html.replace('<h2 style="margin: 8px 0 0 0; font-size: 1.8rem; color: #1f2937;">1,248</h2>', '<h2 id="kpi-total-dash" style="margin: 8px 0 0 0; font-size: 1.8rem; color: #1f2937;">0</h2>');
html = html.replace('<h2 style="margin: 8px 0 0 0; font-size: 1.8rem; color: #be123c;">342</h2>', '<h2 id="kpi-fresh-warning-dash" style="margin: 8px 0 0 0; font-size: 1.8rem; color: #be123c;">0</h2>');
html = html.replace('<h2 style="margin: 8px 0 0 0; font-size: 1.8rem; color: #1f2937;">185</h2>', '<h2 id="kpi-age-15" style="margin: 8px 0 0 0; font-size: 1.8rem; color: #1f2937;">0</h2>');
html = html.replace('<h2 style="margin: 8px 0 0 0; font-size: 1.8rem; color: #1f2937;">89</h2>', '<h2 id="kpi-age-30" style="margin: 8px 0 0 0; font-size: 1.8rem; color: #1f2937;">0</h2>');
html = html.replace('<h2 style="margin: 8px 0 0 0; font-size: 1.8rem; color: #1f2937;">42</h2>', '<h2 id="kpi-age-45" style="margin: 8px 0 0 0; font-size: 1.8rem; color: #1f2937;">0</h2>');
html = html.replace('<h2 style="margin: 8px 0 0 0; font-size: 1.8rem; color: #991b1b;">26</h2>', '<h2 id="kpi-age-90" style="margin: 8px 0 0 0; font-size: 1.8rem; color: #991b1b;">0</h2>');

// Table Body ID
html = html.replace('<tbody>', '<tbody id="table-body">');

// Update Filter Inputs to have our app.js IDs
html = html.replace('<input type="text" placeholder=""', '<input type="text" placeholder="" id="encoded-filter" oninput="renderTable()"');
html = html.replace('<input type="text" placeholder=""', '<input type="text" placeholder="" id="is-filter" oninput="renderTable()"');
html = html.replace('<select>', '<select id="priority-filter" onchange="renderTable()"><option value="all">All Priorities</option><option value="Priority">Priority</option><option value="Non-Priority">Non-Priority</option></select>');
html = html.replace('<input type="text" placeholder=""', '<select id="date-filter" onchange="renderTable()"><option value="all">All Time</option><option value="15">0-15 Days</option><option value="30">16-30 Days</option><option value="45">31-45 Days</option><option value="90">46-90 Days</option><option value="90+">> 90 Days</option></select>');
html = html.replace('<input type="text" placeholder=""', '<select id="assigned-filter" onchange="renderTable()"><option value="all">All Users</option></select>');

fs.writeFileSync('public/index.html', html);
console.log("Verified IDs!");

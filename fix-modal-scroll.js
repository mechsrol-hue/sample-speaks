const fs = require('fs');

const indexPath = '/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/public/index.html';
let indexContent = fs.readFileSync(indexPath, 'utf-8');

// The Content Body is currently:
// <div style="padding: 32px; display: flex; flex-direction: column; gap: 24px; background: #ffffff;">
indexContent = indexContent.replace(
    '<div style="padding: 32px; display: flex; flex-direction: column; gap: 24px; background: #ffffff;">',
    '<div style="padding: 32px; display: flex; flex-direction: column; gap: 24px; background: #ffffff; flex: 1; overflow-y: auto;">'
);

// We should also make sure the table wrapper itself has a better max-height so it doesn't push down
indexContent = indexContent.replace(
    'max-height: 450px;',
    'max-height: 400px;'
);

fs.writeFileSync(indexPath, indexContent);
console.log("Fixed modal scrolling");

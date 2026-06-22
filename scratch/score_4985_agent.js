// Keyless agent-quality test: values I (acting as the agent) read from the IS 4985 PDF Table 1,
// scored cell-by-cell against the hand-verified specs_db.js ground truth.
const fs = require('fs');
const specsCode = fs.readFileSync(__dirname + '/../public/specs_db.js', 'utf8');
const SPECS = new Function(specsCode + '\nreturn IS_4985_SPECS;')();
const GT = SPECS.sizes_db;

// --- What the "agent" extracted from the PDF (Table 1, OD columns 3-6), all 24 DN rows ---
const extracted = {
  20:[20.0,20.3,19.5,20.5], 25:[25.0,25.3,24.5,25.5], 32:[32.0,32.3,31.5,32.5], 40:[40.0,40.3,39.5,40.5],
  50:[50.0,50.3,49.4,50.6], 63:[63.0,63.3,62.2,63.8], 75:[75.0,75.3,74.1,75.9], 90:[90.0,90.3,88.9,91.1],
  110:[110.0,110.4,108.6,111.4], 125:[125.0,125.4,123.5,126.5], 140:[140.0,140.5,138.3,141.7],
  160:[160.0,160.5,158.0,162.0], 180:[180.0,180.6,177.8,182.2], 200:[200.0,200.6,197.6,202.4],
  225:[225.0,225.7,222.3,227.7], 250:[250.0,250.8,247.0,253.0], 280:[280.0,280.9,276.6,283.4],
  315:[315.0,316.0,311.2,318.8], 355:[355.0,356.1,350.7,359.3], 400:[400.0,401.2,395.2,404.8],
  450:[450.0,451.4,444.6,455.4], 500:[500.0,501.5,494.0,506.0], 560:[560.0,561.7,553.2,566.8],
  630:[630.0,631.9,622.4,637.6],
};
// Spot-check wall thickness (Avg,Min,Max) for a few sizes vs specs_db thickness[class]
const thickSpot = {
  20:{5:[1.5,1.1,1.5],6:[1.8,1.4,1.8]},
  90:{1:[1.7,1.3,1.7],2:[2.6,2.1,2.6],3:[3.7,3.1,3.7],4:[4.6,4.0,4.6],5:[5.7,5.0,5.7],6:[7.0,6.1,7.1]},
  315:{1:[5.3,4.6,5.3],2:[8.2,7.2,8.3],3:[12.0,10.7,12.4],4:[15.6,14.0,16.1],5:[19.3,17.3,19.9],6:[23.8,21.4,24.7]},
  630:{1:[10.3,9.1,10.5],2:[16.1,14.4,16.6],3:[23.7,21.3,24.5],4:[31.0,28.0,32.2],5:[38.4,34.7,40.0]},
};

const fields = ['min_od','max_od','min_od_any','max_od_any'];
let ok=0,total=0; const diffs=[];
for (const [dn,vals] of Object.entries(extracted)) {
  const g = GT[dn]; if(!g){diffs.push(`DN${dn}: not in specs_db`);continue;}
  fields.forEach((f,i)=>{ total++; if(Math.abs(vals[i]-g[f])<=0.05) ok++; else diffs.push(`DN${dn}.${f}: agent=${vals[i]} specs=${g[f]}`); });
}
let tOk=0,tTotal=0; const tDiffs=[];
for (const [dn,classes] of Object.entries(thickSpot)) {
  for (const [cls,trip] of Object.entries(classes)) {
    const g = GT[dn] && GT[dn].thickness && GT[dn].thickness[cls];
    trip.forEach((v,i)=>{ tTotal++; if(g && Math.abs(v-g[i])<=0.05) tOk++; else tDiffs.push(`DN${dn} C${cls}[${i}]: agent=${v} specs=${g?g[i]:'?'}`); });
  }
}

console.log('=== IS 4985 — AGENT EXTRACTION vs hand-verified specs_db ===');
console.log(`DN rows captured: ${Object.keys(extracted).length} / ${Object.keys(GT).length} (completeness)`);
console.log(`OD grid cells:    ${ok}/${total} match  → ${(ok/total*100).toFixed(1)}%`);
console.log(`Thickness (spot): ${tOk}/${tTotal} match → ${(tOk/tTotal*100).toFixed(1)}%`);
console.log(`Overall:          ${ok+tOk}/${total+tTotal} → ${((ok+tOk)/(total+tTotal)*100).toFixed(1)}%`);
if (diffs.length) { console.log('\nOD diffs:'); diffs.forEach(d=>console.log('  '+d)); } else console.log('\n✅ OD grid: zero diffs');
if (tDiffs.length) { console.log('Thickness diffs:'); tDiffs.forEach(d=>console.log('  '+d)); } else console.log('✅ Thickness spot-check: zero diffs');

'use strict';
const fs = require('fs');

const sizes = [16,20,25,32,40,50,63,75,90,110,125,140,160,180,200,225,250,280,315,355,400,450,500,560,630,710,800,900,1000,1200,1400,1600,1800,2000];
const sdrs = [41,33,26,21,17,13.6,11,9,7.4,6];
const sdrLabels = sdrs.map(s => 'SDR ' + s);

// ---- Wall thickness derivation (validated against printed Table 4) ----
const ceil1 = x => Math.ceil(x*10 - 1e-9)/10;          // round UP to next 0.1
const near1 = x => Math.round(x*10 + 1e-9)/10;         // round to NEAREST 0.1 (half up)
function wall(dn, sdr){
  const eMin = ceil1(dn/sdr);
  const tol  = near1(0.1*eMin + 0.1);
  const eMax = Math.round((eMin + tol)*10)/10;
  return { min: eMin, max: eMax };
}
const wallVT = {};
for (const dn of sizes) for (let i=0;i<sdrs.length;i++){
  wallVT[`${dn}|${sdrLabels[i]}`] = wall(dn, sdrs[i]);
}

// ---- Table 3: mean OD (min/max) and ovality (max) per size ----
const t3 = {
16:[16.0,16.3,1.2],20:[20.0,20.3,1.2],25:[25.0,25.3,1.2],32:[32.0,32.3,1.3],40:[40.0,40.4,1.4],
50:[50.0,50.4,1.4],63:[63.0,63.4,1.5],75:[75.0,75.5,1.6],90:[90.0,90.6,1.8],110:[110.0,110.7,2.2],
125:[125.0,125.8,2.5],140:[140.0,140.9,2.8],160:[160.0,161.0,3.2],180:[180.0,181.1,3.6],200:[200.0,201.2,4.0],
225:[225.0,226.4,4.5],250:[250.0,251.5,5.0],280:[280.0,281.7,9.8],315:[315.0,316.9,11.1],355:[355.0,357.2,12.5],
400:[400.0,402.4,14.0],450:[450.0,452.7,15.6],500:[500.0,503.0,17.5],560:[560.0,563.4,19.6],630:[630.0,633.8,22.1],
710:[710.0,714.6,null],800:[800.0,807.2,null],900:[900.0,908.1,null],1000:[1000.0,1009.0,null],1200:[1200.0,1210.8,null],
1400:[1400.0,1412.6,null],1600:[1600.0,1614.4,null],1800:[1800.0,1816.2,null],2000:[2000.0,2018.0,null]
};
const meanODvt = {}, ovalityVT = {};
for (const dn of sizes){
  meanODvt[String(dn)] = { min: t3[dn][0], max: t3[dn][1] };
  const ov = t3[dn][2];
  ovalityVT[String(dn)] = (ov==null) ? { value: "As agreed between manufacturer and purchaser" } : { max: ov };
}

// ---- Cl 7.1: out-of-square of pipe end (max) per size band ----
function outSq(dn){ if(dn<=75)return 2; if(dn<=125)return 3; if(dn<=180)return 4; if(dn<=280)return 5; return 7; }
const outSqVT = {}; for (const dn of sizes) outSqVT[String(dn)] = { max: outSq(dn) };

// ---- Grade-varying hydraulic tables (Table 5 + slow crack) ----
const grades = ["PE 63","PE 80","PE 100"];
const hoop = { "27/100":[6.9,8.6,10.7], "80/48":[3.8,4.9,5.7], "80/165":[3.5,4.5,5.4], "80/1000":[3.2,4.0,5.0] };
function hoopVT(key){ const v=hoop[key]; const o={}; grades.forEach((g,i)=>o[g]={expected:`No localized swelling, leakage, weeping or burst at induced hoop stress ${v[i]} MPa`}); return o; }
const scgPress=[0.64,0.8,0.92];
const scgVT={}; grades.forEach((g,i)=>scgVT[g]={expected:`No localized swelling, leakage, weeping or burst at internal test pressure ${scgPress[i]} MPa`});

const template = {
  isNumber: "IS 4984:2016",
  title: "Polyethylene Pipes for Water Supply — Specification",
  revision: "Fifth Revision",
  parameterizationDims: ["size","grade","SDR"],
  dimensionOptions: {
    size: sizes,
    grade: grades,
    SDR: sdrLabels
  },
  defaults: { size: 110, grade: "PE 80", SDR: "SDR 11" },
  parameters: [
    // ---------- Dimensional ----------
    { clauseRef:"Cl 7.4", section:"Dimensions", parameterName:"Mean outside diameter (dem)", unit:"mm",
      limitType:"range", acceptanceOrType:"acceptance", variesBy:["size"], sourceTable:"Table 3",
      valueTable: meanODvt },
    { clauseRef:"Cl 7.4", section:"Dimensions", parameterName:"Maximum out-of-roundness (ovality)", unit:"mm",
      limitType:"max", acceptanceOrType:"acceptance", variesBy:["size"], sourceTable:"Table 3",
      valueTable: ovalityVT,
      note:"For dn >= 710 mm and coiled pipes, ovality is as agreed between manufacturer and purchaser." },
    { clauseRef:"Cl 7.4", section:"Dimensions", parameterName:"Wall thickness (e)", unit:"mm",
      limitType:"range", acceptanceOrType:"acceptance", variesBy:["size","SDR"], sourceTable:"Table 4",
      valueTable: wallVT,
      note:"Computed per Table 4 Note 1: eMin = dn/SDR rounded up to next 0.1 mm; tolerance = (0.1*eMin + 0.1) rounded to nearest 0.1 mm; eMax = eMin + tolerance. Validated against readable cells." },
    { clauseRef:"Cl 7.1", section:"Dimensions", parameterName:"Out of square of pipe end, Max", unit:"mm",
      limitType:"max", acceptanceOrType:"acceptance", variesBy:["size"], sourceTable:"Cl 7.1",
      valueTable: outSqVT },
    { clauseRef:"Cl 7.1", section:"Dimensions", parameterName:"Visual appearance",
      limitType:"qualitative", acceptanceOrType:"acceptance", variesBy:[],
      expected:"Internal and external surface smooth, clean and free from grooving and other defects; ends cleanly cut square" },
    { clauseRef:"Cl 7.2", section:"Dimensions", parameterName:"Length of straight pipe", unit:"m",
      limitType:"range", acceptanceOrType:"acceptance", variesBy:[], min:5, max:20,
      specText:"5 m to 20 m as agreed; short lengths of 3 m (min) up to 10 percent of supply permitted" },

    // ---------- Hydraulic / Mechanical ----------
    { clauseRef:"Cl 8.1.1", section:"Hydraulic", parameterName:"Internal pressure creep rupture test at 27°C for 100 h",
      limitType:"qualitative", acceptanceOrType:"type", variesBy:["grade"], sourceTable:"Table 5", testMethod:"Annex E (IS 4984)",
      valueTable: hoopVT("27/100") },
    { clauseRef:"Cl 8.1.1", section:"Hydraulic", parameterName:"Internal pressure creep rupture test at 80°C for 48 h",
      limitType:"qualitative", acceptanceOrType:"acceptance", variesBy:["grade"], sourceTable:"Table 5", testMethod:"Annex E (IS 4984)",
      valueTable: hoopVT("80/48") },
    { clauseRef:"Cl 8.1.1", section:"Hydraulic", parameterName:"Internal pressure creep rupture test at 80°C for 165 h",
      limitType:"qualitative", acceptanceOrType:"type", variesBy:["grade"], sourceTable:"Table 5", testMethod:"Annex E (IS 4984)",
      valueTable: hoopVT("80/165") },
    { clauseRef:"Cl 8.1.1", section:"Hydraulic", parameterName:"Internal pressure creep rupture test at 80°C for 1000 h",
      limitType:"qualitative", acceptanceOrType:"type", variesBy:["grade"], sourceTable:"Table 5", testMethod:"Annex E (IS 4984)",
      valueTable: hoopVT("80/1000") },
    { clauseRef:"Cl 8.1.2", section:"Hydraulic", parameterName:"Internal pressure creep rupture test of pipe joints at 80°C for 48 h",
      limitType:"qualitative", acceptanceOrType:"acceptance", variesBy:["grade"], sourceTable:"Table 5", testMethod:"Annex E (IS 4984)",
      valueTable: hoopVT("80/48") },
    { clauseRef:"Cl 8.10", section:"Mechanical", parameterName:"Slow crack growth rate (notched test) at 80°C for 500 h",
      limitType:"qualitative", acceptanceOrType:"type", variesBy:["grade"], testMethod:"Annex E and Annex J (IS 4984)",
      valueTable: scgVT },
    { clauseRef:"Cl 8.8", section:"Mechanical", parameterName:"Tensile strength for butt-fusion (failure mode)",
      limitType:"qualitative", acceptanceOrType:"type", variesBy:[], testMethod:"Annex G (IS 4984)",
      expected:"Ductile failure (brittle failure shall be considered a failure)" },
    { clauseRef:"Cl 8.9", section:"Mechanical", parameterName:"Elongation at break, Min", unit:"percent",
      limitType:"min", acceptanceOrType:"acceptance", variesBy:[], min:350, sourceTable:"Table 6", testMethod:"Annex H (IS 4984)",
      specText:">= 350 percent for all wall thicknesses" },
    { clauseRef:"Cl 8.2", section:"Mechanical", parameterName:"Longitudinal reversion, Max", unit:"percent",
      limitType:"max", acceptanceOrType:"acceptance", variesBy:[], max:3, testMethod:"Annex F (IS 4984)" },

    // ---------- Physical / Chemical ----------
    { clauseRef:"Cl 8.3", section:"Chemical", parameterName:"Carbon black content", unit:"percent",
      limitType:"range", acceptanceOrType:"acceptance", variesBy:[], min:2.0, max:3.0, testMethod:"IS 2530",
      specText:"2.5 ± 0.5 percent" },
    { clauseRef:"Cl 8.3", section:"Chemical", parameterName:"Carbon black dispersion",
      limitType:"qualitative", acceptanceOrType:"acceptance", variesBy:[], testMethod:"IS 2530",
      expected:"Satisfactory" },
    { clauseRef:"Cl 8.4", section:"Physical", parameterName:"Melt flow rate (pipe vs resin deviation)",
      limitType:"qualitative", acceptanceOrType:"acceptance", variesBy:[], testMethod:"IS 2530 (190°C, 5 kgf)",
      expected:"Shall not deviate from the MFR of the resin by more than 30 percent" },
    { clauseRef:"Cl 8.5", section:"Physical", parameterName:"Oxidation induction time, Min", unit:"min",
      limitType:"min", acceptanceOrType:"acceptance", variesBy:[], min:20, testMethod:"Annex B (IS 4984)" },
    { clauseRef:"Cl 8.6", section:"Chemical", parameterName:"Overall migration",
      limitType:"qualitative", acceptanceOrType:"type", variesBy:[], testMethod:"IS 9845",
      expected:"Within the limits stipulated in IS 10146" },
    { clauseRef:"Cl 8.7", section:"Physical", parameterName:"Density of pipe", unit:"kg/m3",
      limitType:"range", acceptanceOrType:"acceptance", variesBy:[], min:930, max:960, testMethod:"IS 7328" },

    // ---------- Resin (raw material, Table 2) ----------
    { clauseRef:"Cl 5.2", section:"Resin", parameterName:"Base density of PE resin", unit:"kg/m3",
      limitType:"range", acceptanceOrType:"acceptance", variesBy:[], min:930, max:960, sourceTable:"Table 2", testMethod:"IS 7328" },
    { clauseRef:"Cl 5.2", section:"Resin", parameterName:"Melt flow rate of PE resin", unit:"g/10 min",
      limitType:"range", acceptanceOrType:"acceptance", variesBy:[], min:0.2, max:1.1, sourceTable:"Table 2", testMethod:"IS 2530 (190°C, 5 kg)" },
    { clauseRef:"Cl 5.2", section:"Resin", parameterName:"Volatile matter of PE resin, Max", unit:"mg/kg",
      limitType:"max", acceptanceOrType:"acceptance", variesBy:[], max:350, sourceTable:"Table 2", testMethod:"Annex C (IS 4984)" },
    { clauseRef:"Cl 5.2", section:"Resin", parameterName:"Water content of PE resin, Max", unit:"mg/kg",
      limitType:"max", acceptanceOrType:"acceptance", variesBy:[], max:300, sourceTable:"Table 2", testMethod:"Annex D (IS 2362)",
      note:"Applicable only if measured volatile content is not in conformity." },
    { clauseRef:"Cl 5.4", section:"Chemical", parameterName:"Anti-oxidant content, Max", unit:"percent",
      limitType:"max", acceptanceOrType:"type", variesBy:[], max:0.3,
      specText:"Not more than 0.3 percent by mass of finished resin" }
  ]
};

fs.writeFileSync('/Users/saurabh/Desktop/Antigravity/SampleSpeaks_MacTransfer/public/is_templates/IS_4984_2016.json', JSON.stringify(template, null, 2));
console.log('params:', template.parameters.length, 'wall combos:', Object.keys(wallVT).length, 'sizes:', sizes.length);
console.log('wall 110|SDR 11 =', JSON.stringify(wallVT['110|SDR 11']));
console.log('wall 20|SDR 9 =', JSON.stringify(wallVT['20|SDR 9']));
console.log('wall 20|SDR 6 =', JSON.stringify(wallVT['20|SDR 6']));
console.log('wall 110|SDR 6 =', JSON.stringify(wallVT['110|SDR 6']));
console.log('wall 90|SDR 41 =', JSON.stringify(wallVT['90|SDR 41']));
console.log('wall 75|SDR 6 =', JSON.stringify(wallVT['75|SDR 6']));
console.log('wall 50|SDR 6 =', JSON.stringify(wallVT['50|SDR 6']));
console.log('wall 140|SDR 9 =', JSON.stringify(wallVT['140|SDR 9']));

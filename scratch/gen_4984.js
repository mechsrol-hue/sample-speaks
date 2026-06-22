'use strict';
const fs = require('fs');

const SIZES = [16,20,25,32,40,50,63,75,90,110,125,140,160,180,200,225,250,280,315,355,400,450,500,560,630,710,800,900,1000,1200,1400,1600,1800,2000];
const GRADES = ["PE 63","PE 80","PE 100"];
const SDRS = [41,33,26,21,17,13.6,11,9,7.4,6]; // string forms used as keys below

// Table 3: dn -> [dem_min, dem_max, ovality_max]   (ovality null for >=710)
const T3 = {
16:[16.0,16.3,1.2], 20:[20.0,20.3,1.2], 25:[25.0,25.3,1.2], 32:[32.0,32.3,1.3],
40:[40.0,40.4,1.4], 50:[50.0,50.4,1.4], 63:[63.0,63.4,1.5], 75:[75.0,75.5,1.6],
90:[90.0,90.6,1.8], 110:[110.0,110.7,2.2], 125:[125.0,125.8,2.5], 140:[140.0,140.9,2.8],
160:[160.0,161.0,3.2], 180:[180.0,181.1,3.6], 200:[200.0,201.2,4.0], 225:[225.0,226.4,4.5],
250:[250.0,251.5,5.0], 280:[280.0,281.7,9.8], 315:[315.0,316.9,11.1], 355:[355.0,357.2,12.5],
400:[400.0,402.4,14.0], 450:[450.0,452.7,15.6], 500:[500.0,503.0,17.5], 560:[560.0,563.4,19.6],
630:[630.0,633.8,22.1], 710:[710.0,716.4,null], 800:[800.0,807.2,null], 900:[900.0,908.1,null],
1000:[1000.0,1009.0,null], 1200:[1200.0,1210.8,null], 1400:[1400.0,1412.6,null],
1600:[1600.0,1614.4,null], 1800:[1800.0,1816.2,null], 2000:[2000.0,2018.0,null]
};

const r1 = x => Math.round(x*10)/10;                 // round to nearest 0.1
const ceil1 = x => Math.ceil(x*10 - 1e-9)/10;        // round up to next 0.1

// Wall thickness per IS 4984 Table 4 derivation rule (validated against readable cells):
//   eMin = ceil(dn/SDR, 0.1);  tolerance = round(0.1*eMin + 0.1, 0.1);  eMax = eMin + tol
// Cell exists only when 1.9 <= eMin <= 130 mm (max wall ~130; min wall 1.9).
function wall(dn, sdr) {
  const emin = ceil1(dn / sdr);
  if (emin < 1.9 || emin > 130) return null;
  const tol = r1(0.1 * emin + 0.1);
  const emax = r1(emin + tol);
  return { min: emin, max: emax };
}

// ---- build valueTables ----
const meanOD = {}, ovality = {}, outSq = {}, coil = {};
for (const dn of SIZES) {
  const [mn, mx, ov] = T3[dn];
  meanOD[String(dn)] = { min: mn, max: mx };
  ovality[String(dn)] = (ov == null) ? { value: "As agreed between manufacturer and purchaser (DN >= 710 mm)" } : { max: ov };
  // out-of-square bands (Cl 7.1)
  let os;
  if (dn <= 75) os = 2; else if (dn <= 125) os = 3; else if (dn <= 180) os = 4; else if (dn <= 280) os = 5; else os = 7;
  outSq[String(dn)] = { max: os };
  // minimum internal coil diameter (Cl 7.3): >= 18 dn
  coil[String(dn)] = { min: 18 * dn };
}

const wallVT = {};
for (const dn of SIZES) for (const sdr of SDRS) {
  const key = String(dn) + "|" + String(sdr);
  const w = wall(dn, sdr);
  wallVT[key] = w ? { min: w.min, max: w.max } : { value: "—" };
}

// Table 5 induced hoop stress (MPa) by grade for each test condition
const hoop = {
  "27/100":  { "PE 63": 6.9, "PE 80": 8.6, "PE 100": 10.7 },
  "80/48":   { "PE 63": 3.8, "PE 80": 4.9, "PE 100": 5.7 },
  "80/165":  { "PE 63": 3.5, "PE 80": 4.5, "PE 100": 5.4 },
  "80/1000": { "PE 63": 3.2, "PE 80": 4.0, "PE 100": 5.0 }
};
function hoopVT(cond, label) {
  const h = hoop[cond], vt = {};
  for (const g of GRADES) vt[g] = { expected: `No localized swelling, leakage or weeping and no bursting at induced hoop stress ${h[g]} MPa (${label})` };
  return vt;
}
const scgVT = {
  "PE 63": { expected: "No swelling, leakage, weeping or bursting at internal test pressure 0.64 MPa, 80±1°C, 500 h" },
  "PE 80": { expected: "No swelling, leakage, weeping or bursting at internal test pressure 0.8 MPa, 80±1°C, 500 h" },
  "PE 100":{ expected: "No swelling, leakage, weeping or bursting at internal test pressure 0.92 MPa, 80±1°C, 500 h" }
};

const WALL_NOTE = "Values computed per Table 4's stated derivation rule (eMin = ceil(dn/SDR to 0.1 mm); tolerance = round(0.1*eMin+0.1 to 0.1 mm); eMax = eMin+tolerance), validated against readable Table 4 cells. Cells where eMin would exceed ~130 mm or fall below 1.9 mm are marked '—' (size not offered in that SDR). Dense Table 4 could not be transcribed cell-by-cell at scan resolution; a few eMax cells may differ by +/-0.1 mm from the printed table — verify against printed Table 4.";

const parameters = [
  // ---- Raw material / PE resin granules (Table 2, Cl 5.2) ----
  { clauseRef:"Cl 5.2", section:"Material (Resin)", parameterName:"Base density of PE resin", unit:"kg/m3", limitType:"range", acceptanceOrType:"type", variesBy:[], sourceTable:"Table 2", testMethod:"IS 7328", min:930, max:960 },
  { clauseRef:"Cl 5.2", section:"Material (Resin)", parameterName:"Melt flow rate of PE resin", unit:"g/10 min", limitType:"range", acceptanceOrType:"type", variesBy:[], sourceTable:"Table 2", testMethod:"IS 2530", min:0.2, max:1.1 },
  { clauseRef:"Cl 5.2", section:"Material (Resin)", parameterName:"Thermal stability (oxidation induction time) of PE resin, Min", unit:"min", limitType:"min", acceptanceOrType:"type", variesBy:[], sourceTable:"Table 2", testMethod:"Annex B", min:20 },
  { clauseRef:"Cl 5.2", section:"Material (Resin)", parameterName:"Volatile matter of PE resin, Max", unit:"mg/kg", limitType:"max", acceptanceOrType:"type", variesBy:[], sourceTable:"Table 2", testMethod:"Annex C", max:350 },
  { clauseRef:"Cl 5.2", section:"Material (Resin)", parameterName:"Water content of PE resin, Max", unit:"mg/kg", limitType:"max", acceptanceOrType:"type", variesBy:[], sourceTable:"Table 2", testMethod:"Annex D", max:300 },

  // ---- Designation / general ----
  { clauseRef:"Cl 6.1", section:"General", parameterName:"Pipe designation and marking (grade, SDR, DN, PN, mfr, lot no.)", limitType:"text", acceptanceOrType:"acceptance", variesBy:[], specText:"Designated and marked by grade (Table 1), SDR, nominal OD, pressure rating PN, manufacturer's name/trade-mark, outside diameter and Lot/Batch No. per Cl 6.1 and Cl 10" },

  // ---- Geometric (Section 7) ----
  { clauseRef:"Cl 7.1", section:"Visual / Dimensions", parameterName:"Visual appearance (surface smooth, clean, free from defects; ends square)", limitType:"qualitative", acceptanceOrType:"acceptance", variesBy:[], expected:"Internal and external surface smooth, clean and free from grooving and other defects; ends cleanly cut square and free from deformity" },
  { clauseRef:"Cl 7.1", section:"Dimensions", parameterName:"Maximum out of square of pipe end, Max", unit:"mm", limitType:"max", acceptanceOrType:"acceptance", variesBy:["size"], sourceTable:"Cl 7.1 (out-of-square table)", valueTable: outSq },
  { clauseRef:"Cl 7.3", section:"Dimensions", parameterName:"Minimum internal diameter of coil, Min (>= 18 dn)", unit:"mm", limitType:"min", acceptanceOrType:"acceptance", variesBy:["size"], sourceTable:"Cl 7.3", valueTable: coil },
  { clauseRef:"Cl 7.4", section:"Dimensions", parameterName:"Mean outside diameter (dem)", unit:"mm", limitType:"range", acceptanceOrType:"acceptance", variesBy:["size"], sourceTable:"Table 3", valueTable: meanOD },
  { clauseRef:"Cl 7.4", section:"Dimensions", parameterName:"Maximum out-of-roundness (ovality), Max", unit:"mm", limitType:"max", acceptanceOrType:"acceptance", variesBy:["size"], sourceTable:"Table 3", valueTable: ovality },
  { clauseRef:"Cl 7.4", section:"Dimensions", parameterName:"Wall thickness at any point (e)", unit:"mm", limitType:"range", acceptanceOrType:"acceptance", variesBy:["size","SDR"], sourceTable:"Table 4", needsReview:true, note: WALL_NOTE, valueTable: wallVT },

  // ---- Performance (Section 8) ----
  { clauseRef:"Cl 8.1.1", section:"Hydraulic", parameterName:"Internal pressure creep rupture test of pipe at 27°C for 100 h", limitType:"qualitative", acceptanceOrType:"type", variesBy:["grade"], sourceTable:"Table 5", testMethod:"Annex E", valueTable: hoopVT("27/100","27°C, 100 h") },
  { clauseRef:"Cl 8.1.1", section:"Hydraulic", parameterName:"Internal pressure creep rupture test of pipe at 80°C for 48 h", limitType:"qualitative", acceptanceOrType:"acceptance", variesBy:["grade"], sourceTable:"Table 5", testMethod:"Annex E", valueTable: hoopVT("80/48","80°C, 48 h") },
  { clauseRef:"Cl 8.1.1", section:"Hydraulic", parameterName:"Internal pressure creep rupture test of pipe at 80°C for 165 h", limitType:"qualitative", acceptanceOrType:"type", variesBy:["grade"], sourceTable:"Table 5", testMethod:"Annex E", valueTable: hoopVT("80/165","80°C, 165 h") },
  { clauseRef:"Cl 8.1.1", section:"Hydraulic", parameterName:"Internal pressure creep rupture test of pipe at 80°C for 1000 h", limitType:"qualitative", acceptanceOrType:"type", variesBy:["grade"], sourceTable:"Table 5", testMethod:"Annex E", valueTable: hoopVT("80/1000","80°C, 1000 h") },
  { clauseRef:"Cl 8.1.2", section:"Hydraulic", parameterName:"Internal pressure creep rupture test of pipe joints (butt/electro fusion) at 80°C for 48 h", limitType:"qualitative", acceptanceOrType:"acceptance", variesBy:["grade"], sourceTable:"Table 5", testMethod:"Annex E", valueTable: hoopVT("80/48","joint, 80°C, 48 h") },
  { clauseRef:"Cl 8.2", section:"Physical", parameterName:"Longitudinal reversion, Max", unit:"%", limitType:"max", acceptanceOrType:"acceptance", variesBy:[], testMethod:"Annex F", max:3 },
  { clauseRef:"Cl 8.3", section:"Physical", parameterName:"Carbon black content", unit:"%", limitType:"range", acceptanceOrType:"acceptance", variesBy:[], testMethod:"IS 2530", min:2.0, max:3.0 },
  { clauseRef:"Cl 8.3", section:"Physical", parameterName:"Carbon black dispersion", limitType:"qualitative", acceptanceOrType:"acceptance", variesBy:[], testMethod:"IS 2530", expected:"Satisfactory dispersion of carbon black" },
  { clauseRef:"Cl 8.4", section:"Physical", parameterName:"Melt flow rate of pipe — deviation from resin MFR, Max", unit:"%", limitType:"max", acceptanceOrType:"acceptance", variesBy:[], testMethod:"IS 2530", max:30 },
  { clauseRef:"Cl 8.5", section:"Physical", parameterName:"Oxidation induction time of pipe, Min", unit:"min", limitType:"min", acceptanceOrType:"acceptance", variesBy:[], testMethod:"Annex B", min:20 },
  { clauseRef:"Cl 8.6", section:"Physical", parameterName:"Overall migration of constituents", limitType:"text", acceptanceOrType:"type", variesBy:[], testMethod:"IS 9845", specText:"Within the limits stipulated in IS 10146" },
  { clauseRef:"Cl 8.7", section:"Physical", parameterName:"Base density of pipe", unit:"kg/m3", limitType:"range", acceptanceOrType:"acceptance", variesBy:[], testMethod:"IS 7328", min:930, max:960 },
  { clauseRef:"Cl 8.8", section:"Mechanical", parameterName:"Tensile strength for butt-fusion (failure mode)", limitType:"qualitative", acceptanceOrType:"type", variesBy:[], testMethod:"Annex G", expected:"Ductile failure (brittle failure is a failure)" },
  { clauseRef:"Cl 8.9", section:"Mechanical", parameterName:"Elongation at break, Min", unit:"%", limitType:"min", acceptanceOrType:"acceptance", variesBy:[], sourceTable:"Table 6", testMethod:"Annex H", min:350 },
  { clauseRef:"Cl 8.10", section:"Mechanical", parameterName:"Slow crack growth rate (notched pipe, 80±1°C, 500 h)", limitType:"qualitative", acceptanceOrType:"type", variesBy:["grade"], testMethod:"Annex E / Annex J", valueTable: scgVT }
];

const template = {
  isNumber: "IS 4984:2016",
  title: "Polyethylene Pipes for Water Supply — Specification",
  revision: "Fifth Revision",
  parameterizationDims: ["size","grade","SDR"],
  dimensionOptions: { size: SIZES, grade: GRADES, SDR: SDRS },
  defaults: { size: 110, grade: "PE 80", SDR: 11 },
  parameters
};

fs.writeFileSync(process.argv[2] || 'public/is_templates/IS_4984_2016.json', JSON.stringify(template, null, 2));
console.log('wrote template with', parameters.length, 'parameters; wall cells:', Object.keys(wallVT).length);

#!/usr/bin/env node
/**
 * Demo data for Report ▸ IS Standards & Report Formats.
 *
 *   node scripts/seed_is_manager_demo.js --seed     insert the demo standards
 *   node scripts/seed_is_manager_demo.js --clean    remove every trace of them
 *   node scripts/seed_is_manager_demo.js --status   show what is currently seeded
 *
 * The set is chosen so the manager screen shows EVERY state it can render — a
 * healthy linked standard, one with unresolved flags, one with no report format,
 * one carrying amendments, and a report format on disk with no standard behind it.
 * A demo that only shows "✓ Ready" rows demonstrates nothing.
 *
 * SAFETY — these are fabricated limits, not extractions from real BIS documents:
 *   · every title ends in "(DEMO)", so a fabricated row can never be mistaken for
 *     a real standard in the list, in a generated report, or in a screenshot;
 *   · pdfFileName is prefixed "DEMO_";
 *   · nothing is written to is_conformance_limits, so no demo value can reach a
 *     real sample's pass/fail decision;
 *   · --clean is exact — it targets this file's IS numbers and nothing else.
 */

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const supabase = require('../database-supabase');
const { agentTemplateToVaultParams } = require('../server/agent/template-to-vault');

const TEMPLATE_DIR = path.join(__dirname, '..', 'public', 'is_templates');
const slug = (isNumber) => String(isNumber).replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '');

// ── The demo standards ─────────────────────────────────────────────────────────

const IS_9000 = {
    isNumber: 'IS 9000 (Part 5) : 2026',
    title: 'Environmental Testing for Electronic and Electrical Items — Damp Heat (DEMO)',
    revision: '2026',
    parameterizationDims: ['severity', 'duration'],
    dimensionOptions: { severity: ['Ca', 'Cb', 'Cx'], duration: [4, 10, 21, 56] },
    defaults: { severity: 'Cb', duration: 21 },
    parameters: [
        { clauseRef: 'Cl 4.1', section: 'Conditioning', parameterName: 'Chamber temperature', unit: '°C', limitType: 'range', acceptanceOrType: 'type', variesBy: ['severity'], sourceTable: 'Table 1',
          valueTable: { 'Ca': { min: 39, max: 41 }, 'Cb': { min: 39, max: 41 }, 'Cx': { min: 54, max: 56 } } },
        { clauseRef: 'Cl 4.2', section: 'Conditioning', parameterName: 'Relative humidity', unit: '%', limitType: 'range', acceptanceOrType: 'type', variesBy: ['severity'], sourceTable: 'Table 1',
          valueTable: { 'Ca': { min: 90, max: 95 }, 'Cb': { min: 92, max: 96 }, 'Cx': { min: 92, max: 96 } } },
        { clauseRef: 'Cl 4.3', section: 'Conditioning', parameterName: 'Test duration', unit: 'days', limitType: 'min', acceptanceOrType: 'type', variesBy: ['duration'], sourceTable: 'Table 2',
          valueTable: { '4': { min: 4 }, '10': { min: 10 }, '21': { min: 21 }, '56': { min: 56 } } },
        { clauseRef: 'Cl 5.1', section: 'Recovery', parameterName: 'Recovery period', unit: 'h', limitType: 'range', acceptanceOrType: 'type', min: 1, max: 2 },
        { clauseRef: 'Cl 5.2', section: 'Recovery', parameterName: 'Recovery temperature', unit: '°C', limitType: 'range', acceptanceOrType: 'type', min: 15, max: 35 },
        { clauseRef: 'Cl 6.1', section: 'Electrical', parameterName: 'Insulation resistance after conditioning', unit: 'MΩ', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['severity'], sourceTable: 'Table 3',
          valueTable: { 'Ca': { min: 10 }, 'Cb': { min: 5 }, 'Cx': { min: 2 } } },
        { clauseRef: 'Cl 6.2', section: 'Electrical', parameterName: 'Dielectric strength', unit: 'kV', limitType: 'min', acceptanceOrType: 'acceptance', min: 1.5 },
        { clauseRef: 'Cl 6.3', section: 'Electrical', parameterName: 'Contact resistance variation', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', max: 15 },
        { clauseRef: 'Cl 7.1', section: 'Visual', parameterName: 'Corrosion of metallic parts', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: 'No visible corrosion impairing function' },
        { clauseRef: 'Cl 7.2', section: 'Visual', parameterName: 'Marking legibility', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: 'Marking shall remain legible' },
        { clauseRef: 'Cl 7.3', section: 'Visual', parameterName: 'Deformation of enclosure', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: 'No cracking, blistering or permanent deformation' },
        { clauseRef: 'Cl 8.1', section: 'Mechanical', parameterName: 'Mass change after conditioning', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', max: 2 },
    ],
};

const IS_8008 = {
    isNumber: 'IS 8008 (Part 2) : 2025',
    title: 'Injection Moulded HDPE Fittings for Potable Water Supplies (DEMO)',
    revision: '2025',
    parameterizationDims: ['size', 'pressureRating'],
    dimensionOptions: { size: [20, 25, 32, 40, 50, 63, 75, 90, 110], pressureRating: ['PN 4', 'PN 6', 'PN 10', 'PN 16'] },
    defaults: { size: 63, pressureRating: 'PN 6' },
    parameters: [
        { clauseRef: 'Cl 6.1', section: 'Dimensions', parameterName: 'Mean outside diameter', unit: 'mm', limitType: 'range', acceptanceOrType: 'acceptance', variesBy: ['size'], sourceTable: 'Table 2',
          valueTable: {
              '20': { min: 20.0, max: 20.3 }, '25': { min: 25.0, max: 25.3 }, '32': { min: 32.0, max: 32.3 },
              '40': { min: 40.0, max: 40.4 }, '50': { min: 50.0, max: 50.4 }, '63': { min: 63.0, max: 63.4 },
              '75': { min: 75.0, max: 75.5 }, '90': { min: 90.0, max: 90.6 }, '110': { min: 110.0, max: 110.7 },
          } },
        { clauseRef: 'Cl 6.2', section: 'Dimensions', parameterName: 'Wall thickness', unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['size', 'pressureRating'], sourceTable: 'Table 3',
          valueTable: {
              '20|PN 6': { min: 2.0 }, '25|PN 6': { min: 2.3 }, '32|PN 6': { min: 3.0 }, '40|PN 6': { min: 3.7 },
              '50|PN 6': { min: 4.6 }, '63|PN 6': { min: 5.8 }, '75|PN 6': { min: 6.8 }, '90|PN 6': { min: 8.2 },
              '110|PN 6': { min: 10.0 }, '20|PN 10': { min: 2.3 }, '25|PN 10': { min: 2.8 }, '32|PN 10': { min: 3.6 },
              '40|PN 10': { min: 4.5 }, '50|PN 10': { min: 5.6 }, '63|PN 10': { min: 7.1 }, '75|PN 10': { min: 8.4 },
              '90|PN 10': { min: 10.1 }, '110|PN 10': { min: 12.3 },
          } },
        { clauseRef: 'Cl 7.1', section: 'Material', parameterName: 'Density of compound', unit: 'kg/m³', limitType: 'min', acceptanceOrType: 'type', min: 940 },
        { clauseRef: 'Cl 7.2', section: 'Material', parameterName: 'Melt flow rate (190 °C / 5 kg)', unit: 'g/10 min', limitType: 'range', acceptanceOrType: 'type', min: 0.2, max: 1.4 },
        { clauseRef: 'Cl 7.3', section: 'Material', parameterName: 'Carbon black content', unit: '%', limitType: 'range', acceptanceOrType: 'type', min: 2.0, max: 2.5 },
        { clauseRef: 'Cl 7.4', section: 'Material', parameterName: 'Carbon black dispersion', limitType: 'qualitative', acceptanceOrType: 'type', expected: 'Grade 3 or better' },
        { clauseRef: 'Cl 8.1', section: 'Performance', parameterName: 'Hydrostatic strength at 20 °C / 100 h', unit: 'MPa', limitType: 'min', acceptanceOrType: 'type', min: 12.4 },
        { clauseRef: 'Cl 8.2', section: 'Performance', parameterName: 'Hydrostatic strength at 80 °C / 165 h', unit: 'MPa', limitType: 'min', acceptanceOrType: 'type', min: 5.4 },
        { clauseRef: 'Cl 8.3', section: 'Performance', parameterName: 'Oxidation induction time', unit: 'min', limitType: 'min', acceptanceOrType: 'type', min: 20 },
        { clauseRef: 'Cl 8.4', section: 'Performance', parameterName: 'Thermal stability', limitType: 'qualitative', acceptanceOrType: 'type', expected: 'No failure in 165 h at 80 °C' },
        { clauseRef: 'Cl 9.1', section: 'Appearance', parameterName: 'Internal and external surface', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: 'Smooth, free from grooving, blisters and other defects' },
        { clauseRef: 'Cl 9.2', section: 'Appearance', parameterName: 'Colour', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: 'Black, uniform throughout' },
        { clauseRef: 'Cl 10.1', section: 'Marking', parameterName: 'Manufacturer identification', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: "Manufacturer's name or trade-mark legibly marked" },
        { clauseRef: 'Cl 10.2', section: 'Marking', parameterName: 'Size and pressure rating marking', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: 'Nominal size and pressure rating marked on each fitting' },
    ],
};

const IS_2062 = {
    isNumber: 'IS 2062 : 2023',
    title: 'Hot Rolled Medium and High Tensile Structural Steel (DEMO)',
    revision: '2023',
    parameterizationDims: ['grade', 'thickness'],
    dimensionOptions: { grade: ['E 250', 'E 300', 'E 350', 'E 410'], thickness: [10, 20, 40, 63] },
    defaults: { grade: 'E 250', thickness: 20 },
    parameters: [
        { clauseRef: 'Cl 9.1', section: 'Mechanical', parameterName: 'Yield stress', unit: 'MPa', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['grade', 'thickness'], sourceTable: 'Table 3',
          valueTable: {
              'E 250|10': { min: 250 }, 'E 250|20': { min: 240 }, 'E 250|40': { min: 230 }, 'E 250|63': { min: 220 },
              'E 300|10': { min: 300 }, 'E 300|20': { min: 290 }, 'E 300|40': { min: 280 }, 'E 300|63': { min: 270 },
              'E 350|10': { min: 350 }, 'E 350|20': { min: 340 }, 'E 350|40': { min: 330 }, 'E 350|63': { min: 320 },
              'E 410|10': { min: 410 }, 'E 410|20': { min: 400 }, 'E 410|40': { min: 390 }, 'E 410|63': { min: 380 },
          } },
        { clauseRef: 'Cl 9.2', section: 'Mechanical', parameterName: 'Tensile strength', unit: 'MPa', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['grade'], sourceTable: 'Table 3',
          valueTable: { 'E 250': { min: 410 }, 'E 300': { min: 440 }, 'E 350': { min: 490 }, 'E 410': { min: 540 } } },
        { clauseRef: 'Cl 9.3', section: 'Mechanical', parameterName: 'Percentage elongation (gauge length 5.65√So)', unit: '%', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['grade'], sourceTable: 'Table 3',
          valueTable: { 'E 250': { min: 23 }, 'E 300': { min: 22 }, 'E 350': { min: 22 }, 'E 410': { min: 20 } } },
        { clauseRef: 'Cl 9.4', section: 'Mechanical', parameterName: 'Charpy V-notch impact energy at 0 °C', unit: 'J', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['grade'], sourceTable: 'Table 4',
          valueTable: { 'E 250': { min: 27 }, 'E 300': { min: 27 }, 'E 350': { min: 27 }, 'E 410': { min: 27 } } },
        { clauseRef: 'Cl 8.1', section: 'Chemical', parameterName: 'Carbon, Max', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: ['grade'], sourceTable: 'Table 1',
          valueTable: { 'E 250': { max: 0.23 }, 'E 300': { max: 0.20 }, 'E 350': { max: 0.20 }, 'E 410': { max: 0.20 } } },
        { clauseRef: 'Cl 8.2', section: 'Chemical', parameterName: 'Manganese, Max', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', max: 1.50 },
        { clauseRef: 'Cl 8.3', section: 'Chemical', parameterName: 'Sulphur, Max', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', max: 0.045 },
        { clauseRef: 'Cl 8.4', section: 'Chemical', parameterName: 'Phosphorus, Max', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', max: 0.045 },
        { clauseRef: 'Cl 8.5', section: 'Chemical', parameterName: 'Carbon equivalent, Max', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: ['grade'], sourceTable: 'Table 1',
          valueTable: { 'E 250': { max: 0.42 }, 'E 300': { max: 0.44 }, 'E 350': { max: 0.45 }, 'E 410': { max: 0.47 } } },
        { clauseRef: 'Cl 10.1', section: 'Dimensions', parameterName: 'Thickness tolerance', unit: 'mm', limitType: 'range', acceptanceOrType: 'acceptance', min: -0.3, max: 0.3 },
        { clauseRef: 'Cl 11.1', section: 'Workmanship', parameterName: 'Surface condition', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: 'Free from harmful defects such as cracks, laps and shell' },
        { clauseRef: 'Cl 12.1', section: 'Marking', parameterName: 'Grade designation marking', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: 'Grade and cast number legibly marked on each piece' },
    ],
};

// No report format on disk — this row demonstrates the "— no template —" state,
// where the report falls back to the vault's flat parameters.
const IS_15410_VAULT_PARAMS = [
    ['Cl 5.1', 'Rated capacity', 'l', 'min_only', 6, null, 'Capacity'],
    ['Cl 5.2', 'Rated pressure', 'MPa', 'max_only', null, 0.8, 'Capacity'],
    ['Cl 6.1', 'Standing heat loss', 'kWh/24h', 'max_only', null, 1.2, 'Performance'],
    ['Cl 6.2', 'Heat-up time to 60 °C', 'min', 'max_only', null, 45, 'Performance'],
    ['Cl 6.3', 'Thermal efficiency', '%', 'min_only', 80, null, 'Performance'],
    ['Cl 7.1', 'Insulation resistance', 'MΩ', 'min_only', 2, null, 'Electrical'],
    ['Cl 7.2', 'Electric strength', 'kV', 'min_only', 1.5, null, 'Electrical'],
    ['Cl 7.3', 'Earth continuity resistance', 'Ω', 'max_only', null, 0.1, 'Electrical'],
    ['Cl 7.4', 'Leakage current', 'mA', 'max_only', null, 0.75, 'Electrical'],
    ['Cl 8.1', 'Thermostat cut-out accuracy', '°C', 'two_sided', -5, 5, 'Controls'],
    ['Cl 8.2', 'Thermal cut-out operation', '', 'qualitative', null, null, 'Controls'],
    ['Cl 9.1', 'Hydrostatic pressure test', 'MPa', 'min_only', 1.6, null, 'Mechanical'],
    ['Cl 9.2', 'Container material thickness', 'mm', 'min_only', 1.6, null, 'Mechanical'],
    ['Cl 10.1', 'Corrosion resistance of container', '', 'qualitative', null, null, 'Durability'],
    ['Cl 10.2', 'Enamel coating adhesion', '', 'qualitative', null, null, 'Durability'],
    ['Cl 11.1', 'Marking of rated voltage and capacity', '', 'qualitative', null, null, 'Marking'],
].map(([clause, param, unit, limit_type, min, max, section]) => ({
    clause, param, unit, limit_type, min, max, section, variety: '',
    type: 'acceptance', test_method: '', spec_text: '', expected: '',
}));

const IS_15410 = {
    isNumber: 'IS 15410 : 2024',
    title: 'Storage Type Electric Water Heaters (DEMO)',
};

// Two more so the Cement and Gas Stove sections aren't empty on the scope screens —
// a section picker with nothing behind two of its five buttons demos badly.
const IS_269 = {
    isNumber: 'IS 269 : 2025',
    title: 'Ordinary Portland Cement — Specification (DEMO)',
    revision: '2025',
    parameterizationDims: ['grade'],
    dimensionOptions: { grade: ['33', '43', '53'] },
    defaults: { grade: '43' },
    parameters: [
        { clauseRef: 'Cl 6.1', section: 'Physical', parameterName: 'Compressive strength at 3 days', unit: 'MPa', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['grade'], sourceTable: 'Table 3',
          valueTable: { '33': { min: 16 }, '43': { min: 23 }, '53': { min: 27 } } },
        { clauseRef: 'Cl 6.1', section: 'Physical', parameterName: 'Compressive strength at 7 days', unit: 'MPa', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['grade'], sourceTable: 'Table 3',
          valueTable: { '33': { min: 22 }, '43': { min: 33 }, '53': { min: 37 } } },
        { clauseRef: 'Cl 6.1', section: 'Physical', parameterName: 'Compressive strength at 28 days', unit: 'MPa', limitType: 'min', acceptanceOrType: 'acceptance', variesBy: ['grade'], sourceTable: 'Table 3',
          valueTable: { '33': { min: 33 }, '43': { min: 43 }, '53': { min: 53 } } },
        { clauseRef: 'Cl 6.2', section: 'Physical', parameterName: 'Fineness (specific surface)', unit: 'm²/kg', limitType: 'min', acceptanceOrType: 'acceptance', min: 225 },
        { clauseRef: 'Cl 6.3', section: 'Physical', parameterName: 'Soundness — Le Chatelier expansion', unit: 'mm', limitType: 'max', acceptanceOrType: 'acceptance', max: 10 },
        { clauseRef: 'Cl 6.4', section: 'Physical', parameterName: 'Initial setting time', unit: 'min', limitType: 'min', acceptanceOrType: 'acceptance', min: 30 },
        { clauseRef: 'Cl 6.5', section: 'Physical', parameterName: 'Final setting time', unit: 'min', limitType: 'max', acceptanceOrType: 'acceptance', max: 600 },
        { clauseRef: 'Cl 5.1', section: 'Chemical', parameterName: 'Lime saturation factor', limitType: 'range', acceptanceOrType: 'acceptance', min: 0.66, max: 1.02 },
        { clauseRef: 'Cl 5.2', section: 'Chemical', parameterName: 'Alumina to iron oxide ratio', limitType: 'min', acceptanceOrType: 'acceptance', min: 0.66 },
        { clauseRef: 'Cl 5.3', section: 'Chemical', parameterName: 'Insoluble residue', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', max: 5.0 },
        { clauseRef: 'Cl 5.4', section: 'Chemical', parameterName: 'Magnesia', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', max: 6.0 },
        { clauseRef: 'Cl 5.5', section: 'Chemical', parameterName: 'Sulphuric anhydride', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', max: 3.5 },
        { clauseRef: 'Cl 5.6', section: 'Chemical', parameterName: 'Loss on ignition', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', max: 5.0 },
    ],
};

const IS_4246 = {
    isNumber: 'IS 4246 : 2024',
    title: 'Domestic Gas Stoves for Use with Liquefied Petroleum Gases (DEMO)',
    revision: '2024',
    parameterizationDims: ['burners'],
    dimensionOptions: { burners: [1, 2, 3, 4] },
    defaults: { burners: 2 },
    parameters: [
        { clauseRef: 'Cl 7.1', section: 'Performance', parameterName: 'Thermal efficiency', unit: '%', limitType: 'min', acceptanceOrType: 'acceptance', min: 68 },
        { clauseRef: 'Cl 7.2', section: 'Performance', parameterName: 'Gas consumption per burner', unit: 'g/h', limitType: 'max', acceptanceOrType: 'acceptance', variesBy: ['burners'], sourceTable: 'Table 2',
          valueTable: { '1': { max: 120 }, '2': { max: 240 }, '3': { max: 360 }, '4': { max: 480 } } },
        { clauseRef: 'Cl 7.3', section: 'Performance', parameterName: 'Carbon monoxide in dry flue gas', unit: '%', limitType: 'max', acceptanceOrType: 'acceptance', max: 0.1 },
        { clauseRef: 'Cl 7.4', section: 'Performance', parameterName: 'Flame stability — lighting back', limitType: 'qualitative', acceptanceOrType: 'type', expected: 'No lighting back or flame lift at rated pressure' },
        { clauseRef: 'Cl 8.1', section: 'Safety', parameterName: 'Gas soundness of the assembly', limitType: 'qualitative', acceptanceOrType: 'type', expected: 'No leakage at 1.5 times working pressure' },
        { clauseRef: 'Cl 8.2', section: 'Safety', parameterName: 'Stability of the stove on an inclined plane', limitType: 'qualitative', acceptanceOrType: 'type', expected: 'Shall not overturn at 15° inclination' },
        { clauseRef: 'Cl 8.3', section: 'Safety', parameterName: 'Temperature rise of control knobs', unit: '°C', limitType: 'max', acceptanceOrType: 'acceptance', max: 35 },
        { clauseRef: 'Cl 9.1', section: 'Construction', parameterName: 'Sheet thickness of the body', unit: 'mm', limitType: 'min', acceptanceOrType: 'acceptance', min: 0.5 },
        { clauseRef: 'Cl 9.2', section: 'Construction', parameterName: 'Burner material', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: 'Brass or equivalent corrosion-resistant material' },
        { clauseRef: 'Cl 9.3', section: 'Construction', parameterName: 'Pan support deflection under load', unit: 'mm', limitType: 'max', acceptanceOrType: 'acceptance', max: 3 },
        { clauseRef: 'Cl 10.1', section: 'Endurance', parameterName: 'Knob operation endurance', unit: 'cycles', limitType: 'min', acceptanceOrType: 'type', min: 5000 },
        { clauseRef: 'Cl 11.1', section: 'Marking', parameterName: 'Marking of gas type and pressure', limitType: 'qualitative', acceptanceOrType: 'acceptance', expected: 'LPG type and working pressure legibly marked' },
    ],
};

// A sensible section filing for everything in the vault, so the scope screens have
// real data. Keyed by the vault's exact isNumber; anything not listed stays unfiled
// (which the admin screen already flags).
const SECTION_FILING = {
    'IS 4985:2021': 'Plastic',
    'IS 4984:2016': 'Plastic',
    'IS 13592:2013': 'Plastic',
    'IS 8008 (Part 2) : 2025': 'Plastic',
    'IS 1786:2008': 'Metal',
    'IS 2062 : 2023': 'Metal',
    'IS 3196 (Part 1) : 2013': 'Metal',
    'IS 2347:2023': 'Metal',
    'IS 4246 : 2024': 'Gas Stove',
    'IS 269 : 2025': 'Cement',
    'IS 303:2024': 'Miscellaneous',
    'IS 368:2014': 'Miscellaneous',
    'IS 694:2010': 'Miscellaneous',
    'IS 1180 (Part 1) : 2014': 'Miscellaneous',
    'IS 3854:2023': 'Miscellaneous',
    'IS 4250:2025': 'Miscellaneous',
    'IS 7098 (Part 1) : 2025': 'Miscellaneous',
    'IS 9000 (Part 5) : 2026': 'Miscellaneous',
    'IS 15410 : 2024': 'Miscellaneous',
};

// A report format with no standard behind it — drives the orphan warning panel.
const ORPHAN = {
    file: 'IS_10500_2012.json',
    body: {
        isNumber: 'IS 10500 : 2012',
        title: 'Drinking Water — Specification (DEMO orphan format)',
        parameterizationDims: [],
        dimensionOptions: {},
        defaults: {},
        parameters: [
            { clauseRef: 'Cl 4.1', section: 'Organoleptic', parameterName: 'Turbidity', unit: 'NTU', limitType: 'max', acceptanceOrType: 'acceptance', max: 1 },
            { clauseRef: 'Cl 4.2', section: 'Organoleptic', parameterName: 'pH value', limitType: 'range', acceptanceOrType: 'acceptance', min: 6.5, max: 8.5 },
            { clauseRef: 'Cl 4.3', section: 'Chemical', parameterName: 'Total dissolved solids', unit: 'mg/l', limitType: 'max', acceptanceOrType: 'acceptance', max: 500 },
        ],
    },
};

const FLAGS_8008 = [
    { id: 'u1', clause: 'Cl 6.2', question: 'Table 3 wall-thickness column for PN 16 is cut off in the scan — values for sizes 75 mm and above could not be read.', resolved: false },
    { id: 'u2', clause: 'Cl 7.2', question: 'Melt flow rate condition is printed as "190 °C / 5 kg" in Cl 7.2 but "190 °C / 2.16 kg" in Annex B. Which governs?', resolved: false },
    { id: 'u3', clause: 'Cl 8.3', question: 'Oxidation induction time minimum differs between the clause text (20 min) and Table 5 (25 min).', resolved: false },
    { id: 'u4', clause: 'Cl 9.2', question: 'Colour requirement resolved against Amendment 1 — black confirmed.', resolved: true },
];

const AMENDMENTS_2062 = [
    { isNumber: 'IS 2062', amendmentNumber: 'Amd 1', title: 'Amendment No. 1 to IS 2062:2023 (DEMO)', isNew: false, publishDate: '2024-08-14' },
    { isNumber: 'IS 2062', amendmentNumber: 'Amd 2', title: 'Amendment No. 2 to IS 2062:2023 — revised carbon equivalent limits (DEMO)', isNew: true, publishDate: '2026-06-30' },
];

const TEMPLATED = [IS_9000, IS_8008, IS_2062, IS_269, IS_4246];
const ALL_IS_NUMBERS = [...TEMPLATED.map(t => t.isNumber), IS_15410.isNumber];

// Two TPs waiting on approval and one sent back — so the review queue has something
// to show. Deliberately no pre-"approved" submission: approving is what writes
// employee_competencies, and the seed must never quietly make someone assignable.
// Approve one of these live during the demo to show that step working.
const DEMO_SUBMISSIONS = [
    { username: 'Kaduluri Yashwanth', sections: ['Plastic'], isNumbers: ['IS 4985:2021', 'IS 4984:2016', 'IS 13592:2013'],
      status: 'pending', note: 'Mostly pipes — I have run 4985 for two years.', proposedSection: '', ageDays: 1 },
    { username: 'Mageshwaran S', sections: ['Metal', 'Cement'], isNumbers: ['IS 1786:2008', 'IS 2062 : 2023', 'IS 269 : 2025'],
      status: 'pending', note: '', proposedSection: 'Rubber & Elastomers', ageDays: 3 },
    { username: 'Karthick K', sections: ['Miscellaneous'], isNumbers: ['IS 694:2010', 'IS 7098 (Part 1) : 2025'],
      status: 'rejected', note: 'Cables only.', proposedSection: '', ageDays: 6,
      reviewedBy: 'Admin', reviewNote: 'Add IS 3854 — you have been doing switches all quarter.' },
];

// ── Actions ────────────────────────────────────────────────────────────────────

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

async function seed() {
    const rows = [];

    for (const tpl of TEMPLATED) {
        fs.writeFileSync(path.join(TEMPLATE_DIR, `${slug(tpl.isNumber)}.json`), JSON.stringify(tpl, null, 2));
        console.log(`  format  ${slug(tpl.isNumber)}.json (${tpl.parameters.length} parameters)`);
    }
    fs.writeFileSync(path.join(TEMPLATE_DIR, ORPHAN.file), JSON.stringify(ORPHAN.body, null, 2));
    console.log(`  format  ${ORPHAN.file} (orphan — no vault row, on purpose)`);

    const vaultRow = (isNumber, title, params, extra) => Object.assign({
        isNumber,
        title,
        pdfFileName: `DEMO_${slug(isNumber)}.pdf`,
        uploadedAt: daysAgo(extra && extra.age != null ? extra.age : 5),
        confidenceScore: 1,
        testParameters: JSON.stringify(params),
        uncertainItems: JSON.stringify((extra && extra.flags) || []),
        extractedClauses: JSON.stringify([]),
        extractedTables: JSON.stringify([]),
        isFullyResolved: !(extra && extra.flags && extra.flags.some(f => !f.resolved)),
    }, (extra && extra.overrides) || {});

    rows.push(vaultRow(IS_269.isNumber, IS_269.title, agentTemplateToVaultParams(IS_269), { age: 6 }));
    rows.push(vaultRow(IS_4246.isNumber, IS_4246.title, agentTemplateToVaultParams(IS_4246), { age: 9 }));
    rows.push(vaultRow(IS_9000.isNumber, IS_9000.title, agentTemplateToVaultParams(IS_9000), { age: 3 }));
    rows.push(vaultRow(IS_8008.isNumber, IS_8008.title, agentTemplateToVaultParams(IS_8008), { age: 11, flags: FLAGS_8008, overrides: { confidenceScore: 0.72 } }));
    rows.push(vaultRow(IS_2062.isNumber, IS_2062.title, agentTemplateToVaultParams(IS_2062), { age: 27 }));
    rows.push(vaultRow(IS_15410.isNumber, IS_15410.title,
        { flat: IS_15410_VAULT_PARAMS, sections: [...new Set(IS_15410_VAULT_PARAMS.map(p => p.section))], referenced_standards: [] },
        { age: 40, overrides: { confidenceScore: 0.88 } }));

    for (const row of rows) {
        const { data: existing } = await supabase.from('is_standards_vault').select('id').eq('isNumber', row.isNumber).limit(1);
        if (existing && existing.length) {
            const { error } = await supabase.from('is_standards_vault').update(row).eq('id', existing[0].id);
            if (error) throw new Error(`${row.isNumber}: ${error.message}`);
            console.log(`  vault   ${row.isNumber} (updated)`);
        } else {
            const { error } = await supabase.from('is_standards_vault').insert(row);
            if (error) throw new Error(`${row.isNumber}: ${error.message}`);
            console.log(`  vault   ${row.isNumber} (inserted)`);
        }
    }

    // Amendments — drives the "2 amd" badge and the red "New" pill on IS 2062.
    try {
        await supabase.from('is_amendments').delete().eq('isNumber', 'IS 2062');
        const { error } = await supabase.from('is_amendments').insert(AMENDMENTS_2062);
        if (error) throw error;
        console.log(`  amend   IS 2062 × ${AMENDMENTS_2062.length} (one flagged New)`);
    } catch (e) {
        console.log(`  amend   skipped (${e.message})`);
    }

    // Master-template link marker for IS 9000 — makes one row show "↪ Linked" with a
    // healthy hours match. Written directly rather than via /sync-to-master so that
    // NO demo value is ever written to is_conformance_limits.
    const linkKey = `template_IS 9000`;
    const linkValue = {
        tatDays: 7,
        totalHours: 18,
        activeClauses: {
            'Cl 4.1 Chamber temperature': { activeHours: 2 },
            'Cl 4.2 Relative humidity': { activeHours: 2 },
            'Cl 6.1 Insulation resistance': { activeHours: 3 },
            'Cl 6.2 Dielectric strength': { activeHours: 2 },
        },
        paramsSource: 'is_intelligence',
        linkedISNumber: IS_9000.isNumber,
        hoursMatch: { totalParams: 24, matchedToHours: 21, syncedAt: daysAgo(2) },
    };
    const { error: linkErr } = await supabase.from('system_preferences')
        .upsert({ key: linkKey, value: JSON.stringify(linkValue) }, { onConflict: 'key' });
    console.log(linkErr ? `  link    skipped (${linkErr.message})` : `  link    ${linkKey} → 21/24 params matched to hours`);

    await seedScope();
}

// ── IS Scope demo data ─────────────────────────────────────────────────────────
async function seedScope() {
    const sections = ['Plastic', 'Metal', 'Gas Stove', 'Cement', 'Miscellaneous'];
    await supabase.from('system_preferences')
        .upsert({ key: 'is_scope_sections', value: JSON.stringify(sections) }, { onConflict: 'key' });

    // Only file standards that actually exist in the vault right now.
    const { data: vault } = await supabase.from('is_standards_vault').select('isNumber');
    const present = new Set((vault || []).map(r => r.isNumber));
    const map = {};
    for (const [isNumber, section] of Object.entries(SECTION_FILING)) {
        if (present.has(isNumber)) map[isNumber] = section;
    }
    await supabase.from('system_preferences')
        .upsert({ key: 'is_scope_section_map', value: JSON.stringify(map) }, { onConflict: 'key' });
    const per = sections.map(s => `${s} ${Object.values(map).filter(v => v === s).length}`).join(' · ');
    console.log(`  scope   ${Object.keys(map).length} standards filed — ${per}`);

    const { data: users } = await supabase.from('users').select('id, username');
    for (const d of DEMO_SUBMISSIONS) {
        const user = (users || []).find(u => u.username === d.username);
        if (!user) { console.log(`  scope   skipped submission for ${d.username} (no such account)`); continue; }
        const submission = {
            userId: user.id,
            username: user.username,
            sections: d.sections,
            isNumbers: d.isNumbers.filter(n => present.has(n)),
            proposedSection: d.proposedSection || '',
            note: d.note || '',
            status: d.status,
            submittedAt: daysAgo(d.ageDays),
            previousStatus: null,
            reviewedBy: d.reviewedBy || null,
            reviewedAt: d.reviewedBy ? daysAgo(d.ageDays - 1) : null,
            reviewNote: d.reviewNote || '',
            competenciesAdded: 0,
            demo: true
        };
        await supabase.from('system_preferences')
            .upsert({ key: `is_scope_tp_${user.id}`, value: JSON.stringify(submission) }, { onConflict: 'key' });
        console.log(`  scope   submission from ${user.username} (${d.status})`);
    }
}

async function clean() {
    for (const isNumber of ALL_IS_NUMBERS) {
        const f = path.join(TEMPLATE_DIR, `${slug(isNumber)}.json`);
        if (fs.existsSync(f)) { fs.unlinkSync(f); console.log(`  removed format  ${slug(isNumber)}.json`); }
        const { data } = await supabase.from('is_standards_vault').delete().eq('isNumber', isNumber).select('id');
        if (data && data.length) console.log(`  removed vault   ${isNumber}`);
        await supabase.from('is_conformance_limits').delete().eq('isNumber', isNumber);
    }
    const orphanPath = path.join(TEMPLATE_DIR, ORPHAN.file);
    if (fs.existsSync(orphanPath)) { fs.unlinkSync(orphanPath); console.log(`  removed format  ${ORPHAN.file}`); }

    try {
        const { data } = await supabase.from('is_amendments').delete().eq('isNumber', 'IS 2062').select('id');
        if (data && data.length) console.log(`  removed amend   IS 2062 × ${data.length}`);
    } catch (e) {}

    const { error } = await supabase.from('system_preferences').delete().eq('key', 'template_IS 9000');
    if (!error) console.log('  removed link    template_IS 9000');

    // Scope: drop the section config and only the submissions this script created.
    // A real TP's own submission must survive --clean.
    await supabase.from('system_preferences').delete().in('key', ['is_scope_sections', 'is_scope_section_map']);
    console.log('  removed scope   section list + filing');
    const { data: subs } = await supabase.from('system_preferences').select('key, value').like('key', 'is_scope_tp_%');
    for (const row of (subs || [])) {
        let parsed = null;
        try { parsed = JSON.parse(row.value); } catch (_) {}
        if (parsed && parsed.demo === true) {
            await supabase.from('system_preferences').delete().eq('key', row.key);
            console.log(`  removed scope   submission from ${parsed.username}`);
        }
    }
}

async function status() {
    for (const isNumber of ALL_IS_NUMBERS) {
        const { data } = await supabase.from('is_standards_vault').select('id').eq('isNumber', isNumber);
        const f = fs.existsSync(path.join(TEMPLATE_DIR, `${slug(isNumber)}.json`));
        console.log(`  ${(data && data.length) ? 'present ' : 'absent  '} ${isNumber}${f ? '  + format' : ''}`);
    }
    console.log(`  ${fs.existsSync(path.join(TEMPLATE_DIR, ORPHAN.file)) ? 'present ' : 'absent  '} ${ORPHAN.file} (orphan format)`);
}

(async () => {
    const mode = process.argv[2];
    try {
        if (mode === '--seed') { console.log('Seeding IS manager demo data…'); await seed(); console.log('\nDone. Open Report ▸ IS Standards & Report Formats.'); }
        else if (mode === '--clean') { console.log('Removing IS manager demo data…'); await clean(); console.log('\nDone. Nothing demo-related remains.'); }
        else if (mode === '--status') { console.log('IS manager demo data:'); await status(); }
        else {
            console.log('Usage: node scripts/seed_is_manager_demo.js --seed | --clean | --status');
            process.exit(1);
        }
    } catch (e) {
        console.error('\nFailed:', e.message);
        process.exit(1);
    }
})();

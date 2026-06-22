import json, math

sizes = [16,20,25,32,40,50,63,75,90,110,125,140,160,180,200,225,250,280,315,355,
         400,450,500,560,630,710,800,900,1000,1200,1400,1600,1800,2000]
sdrs = [41,33,26,21,17,13.6,11,9,7.4,6]
grades = ["PE 63","PE 80","PE 100"]

# offered OD range per SDR (inclusive), from printed Table 4
offered = {
 41:(75,2000), 33:(63,2000), 26:(50,2000), 21:(40,2000), 17:(32,2000),
 13.6:(25,1600), 11:(20,1200), 9:(16,1000), 7.4:(16,900), 6:(16,710)
}
def sdr_key(s):
    return str(int(s)) if float(s).is_integer() else str(s)

def rhu(x):  # round half up to 0.1
    return math.floor(x*10 + 0.5 + 1e-9)/10.0
def emin(dn,sdr):
    return math.ceil(dn/sdr*10 - 1e-9)/10.0
def emax(dn,sdr):
    em = emin(dn,sdr); tol = rhu(0.1*em+0.1)
    return round(em+tol,1)

# sanity checks against known printed cells
assert emin(16,9)==1.8 and emax(16,9)==2.1
assert emin(2000,41)==48.8 and emax(2000,41)==53.8
assert emin(1600,13.6)==117.7 and emax(1600,13.6)==129.6
assert emin(710,6)==118.4 and emax(710,6)==130.3
assert emin(900,7.4)==121.7 and emax(900,7.4)==134.0
assert emin(500,9)==55.6 and emax(500,9)==61.3

# Table 4 valueTable
wall = {}
for dn in sizes:
    for s in sdrs:
        lo,hi = offered[s]
        k = f"{dn}|{sdr_key(s)}"
        if lo <= dn <= hi:
            wall[k] = {"min": round(emin(dn,s),1), "max": emax(dn,s)}
        else:
            wall[k] = {"value":"Not specified in IS (combination not offered)"}

# Table 3 mean OD + ovality
t3 = {
16:(16.0,16.3,1.2),20:(20.0,20.3,1.2),25:(25.0,25.3,1.2),32:(32.0,32.3,1.3),
40:(40.0,40.4,1.4),50:(50.0,50.4,1.4),63:(63.0,63.4,1.5),75:(75.0,75.5,1.6),
90:(90.0,90.6,1.8),110:(110.0,110.7,2.2),125:(125.0,125.8,2.5),140:(140.0,140.9,2.8),
160:(160.0,161.0,3.2),180:(180.0,181.1,3.6),200:(200.0,201.2,4.0),225:(225.0,226.4,4.5),
250:(250.0,251.5,5.0),280:(280.0,281.7,9.8),315:(315.0,316.9,11.1),355:(355.0,357.2,12.5),
400:(400.0,402.4,14.0),450:(450.0,452.7,15.6),500:(500.0,503.0,17.5),560:(560.0,563.4,19.6),
630:(630.0,633.8,22.1),710:(710.0,716.4,None),800:(800.0,807.2,None),900:(900.0,908.1,None),
1000:(1000.0,1009.0,None),1200:(1200.0,1210.8,None),1400:(1400.0,1412.6,None),
1600:(1600.0,1614.4,None),1800:(1800.0,1816.2,None),2000:(2000.0,2018.0,None)}

mean_od = {str(dn):{"min":v[0],"max":v[1]} for dn,v in t3.items()}
ovality = {}
for dn,v in t3.items():
    if v[2] is None:
        ovality[str(dn)] = {"value":"As agreed between manufacturer and purchaser"}
    else:
        ovality[str(dn)] = {"max":v[2]}

def out_sq(dn):
    if dn<=75: return 2
    if dn<=125: return 3
    if dn<=180: return 4
    if dn<=280: return 5
    return 7
out_square = {str(dn):{"max":out_sq(dn)} for dn in sizes}
coil = {str(dn):{"min":round(18*dn,1)} for dn in sizes}

# grade-varying hydraulic creep (Table 5) qualitative
hoop = {"27|100":{"PE 63":6.9,"PE 80":8.6,"PE 100":10.7},
        "80|48":{"PE 63":3.8,"PE 80":4.9,"PE 100":5.7},
        "80|165":{"PE 63":3.5,"PE 80":4.5,"PE 100":5.4},
        "80|1000":{"PE 63":3.2,"PE 80":4.0,"PE 100":5.0}}
def creep_vt(cond):
    d=hoop[cond]; return {g:{"expected":f"No localized swelling, leakage or weeping; no burst at induced hoop stress {d[g]} MPa"} for g in grades}
scg = {"PE 63":0.64,"PE 80":0.8,"PE 100":0.92}
scg_vt = {g:{"expected":f"No localized swelling, leakage or weeping; no burst at internal test pressure {scg[g]} MPa (80°C, 500 h)"} for g in grades}

params = [
 # ---- Dimensions (size) ----
 {"clauseRef":"Cl 7.4","section":"Dimensions","parameterName":"Mean outside diameter (dem)","unit":"mm",
  "limitType":"range","acceptanceOrType":"acceptance","variesBy":["size"],"sourceTable":"Table 3","valueTable":mean_od},
 {"clauseRef":"Cl 7.4","section":"Dimensions","parameterName":"Out-of-roundness (Ovality), Max","unit":"mm",
  "limitType":"max","acceptanceOrType":"acceptance","variesBy":["size"],"sourceTable":"Table 3",
  "note":"Ovality specified for DN 16-630; for DN >= 710 and coiled pipes as agreed between manufacturer and purchaser.","valueTable":ovality},
 {"clauseRef":"Cl 7.4","section":"Dimensions","parameterName":"Wall thickness (e)","unit":"mm",
  "limitType":"range","acceptanceOrType":"acceptance","variesBy":["size","SDR"],"sourceTable":"Table 4",
  "note":"eMin/eMax per Table 4. Blank combinations are not offered in the standard. eMin = dn/SDR rounded up to next 0.1 mm; tolerance = (0.1 eMin + 0.1) mm (printed cells rounded to nearest 0.1).","valueTable":wall},
 {"clauseRef":"Cl 7.1","section":"Dimensions","parameterName":"Maximum out of square of pipe end, Max","unit":"mm",
  "limitType":"max","acceptanceOrType":"acceptance","variesBy":["size"],"valueTable":out_square},
 {"clauseRef":"Cl 7.3","section":"Dimensions","parameterName":"Minimum internal diameter of coil, Min","unit":"mm",
  "limitType":"min","acceptanceOrType":"acceptance","variesBy":["size"],
  "note":"Applicable to coiled pipes only; >= 18 x dn.","valueTable":coil},
 # ---- General / Visual ----
 {"clauseRef":"Cl 7.1","section":"General","parameterName":"Visual appearance",
  "limitType":"qualitative","acceptanceOrType":"acceptance","variesBy":[],
  "expected":"Internal and external surface smooth, clean and free from grooving and other defects; ends cleanly cut square."},
 {"clauseRef":"Cl 7.2","section":"General","parameterName":"Length of straight pipe",
  "limitType":"text","acceptanceOrType":"acceptance","variesBy":[],
  "specText":"Straight pipe length 5 m to 20 m as agreed; short lengths of 3 m (min) up to 10 percent of supply permitted."},
 {"clauseRef":"Cl 6.2","section":"General","parameterName":"Colour and identification stripes",
  "limitType":"text","acceptanceOrType":"acceptance","variesBy":[],
  "specText":"Black with minimum three blue longitudinal identification stripes of minimum width 3 mm."},
 # ---- Performance (Cl 8) ----
 {"clauseRef":"Cl 8.1.1","section":"Hydraulic","parameterName":"Internal pressure creep rupture test of pipe — 27°C, 100 h",
  "limitType":"qualitative","acceptanceOrType":"type","variesBy":["grade"],"sourceTable":"Table 5","testMethod":"Annex E",
  "valueTable":creep_vt("27|100")},
 {"clauseRef":"Cl 8.1.1","section":"Hydraulic","parameterName":"Internal pressure creep rupture test of pipe — 80°C, 48 h",
  "limitType":"qualitative","acceptanceOrType":"acceptance","variesBy":["grade"],"sourceTable":"Table 5","testMethod":"Annex E",
  "valueTable":creep_vt("80|48")},
 {"clauseRef":"Cl 8.1.1","section":"Hydraulic","parameterName":"Internal pressure creep rupture test of pipe — 80°C, 165 h",
  "limitType":"qualitative","acceptanceOrType":"type","variesBy":["grade"],"sourceTable":"Table 5","testMethod":"Annex E",
  "valueTable":creep_vt("80|165")},
 {"clauseRef":"Cl 8.1.1","section":"Hydraulic","parameterName":"Internal pressure creep rupture test of pipe — 80°C, 1000 h",
  "limitType":"qualitative","acceptanceOrType":"type","variesBy":["grade"],"sourceTable":"Table 5","testMethod":"Annex E",
  "valueTable":creep_vt("80|1000")},
 {"clauseRef":"Cl 8.1.2","section":"Hydraulic","parameterName":"Internal pressure creep rupture test of pipe joints — 80°C, 48 h",
  "limitType":"qualitative","acceptanceOrType":"acceptance","variesBy":["grade"],"sourceTable":"Table 5","testMethod":"Annex E",
  "valueTable":creep_vt("80|48")},
 {"clauseRef":"Cl 8.2","section":"Physical","parameterName":"Longitudinal reversion, Max","unit":"%",
  "limitType":"max","acceptanceOrType":"acceptance","variesBy":[],"testMethod":"Annex F","max":3},
 {"clauseRef":"Cl 8.3","section":"Chemical","parameterName":"Carbon black content","unit":"%",
  "limitType":"range","acceptanceOrType":"acceptance","variesBy":[],"testMethod":"IS 2530","min":2.0,"max":3.0,
  "note":"2.5 ± 0.5 percent."},
 {"clauseRef":"Cl 8.3","section":"Chemical","parameterName":"Carbon black dispersion",
  "limitType":"qualitative","acceptanceOrType":"acceptance","variesBy":[],"testMethod":"IS 2530","expected":"Satisfactory dispersion."},
 {"clauseRef":"Cl 8.4","section":"Physical","parameterName":"Melt flow rate (pipe) deviation from resin MFR, Max","unit":"%",
  "limitType":"max","acceptanceOrType":"acceptance","variesBy":[],"testMethod":"IS 2530","max":30,
  "note":"MFR of pipe shall not deviate from MFR of resin by more than 30 percent (190°C, 5 kgf)."},
 {"clauseRef":"Cl 8.5","section":"Physical","parameterName":"Oxidation induction time (pipe), Min","unit":"min",
  "limitType":"min","acceptanceOrType":"acceptance","variesBy":[],"testMethod":"Annex B","min":20},
 {"clauseRef":"Cl 8.6","section":"Chemical","parameterName":"Overall migration",
  "limitType":"text","acceptanceOrType":"type","variesBy":[],"testMethod":"IS 9845",
  "specText":"Within the limits stipulated in IS 10146."},
 {"clauseRef":"Cl 8.7","section":"Physical","parameterName":"Density of pipe","unit":"kg/m³",
  "limitType":"range","acceptanceOrType":"acceptance","variesBy":[],"testMethod":"IS 7328","min":930,"max":960},
 {"clauseRef":"Cl 8.8","section":"Mechanical","parameterName":"Tensile strength for butt-fusion",
  "limitType":"qualitative","acceptanceOrType":"type","variesBy":[],"testMethod":"Annex G",
  "expected":"Ductile failure (brittle failure = fail). Test specimen preferably 110 mm Dia / SDR 11."},
 {"clauseRef":"Cl 8.9","section":"Mechanical","parameterName":"Elongation at break, Min","unit":"%",
  "limitType":"min","acceptanceOrType":"acceptance","variesBy":[],"testMethod":"Annex H","sourceTable":"Table 6","min":350,
  "note":">= 350 percent for all wall thicknesses; test piece type/speed varies with wall thickness (Table 6)."},
 {"clauseRef":"Cl 8.10","section":"Mechanical","parameterName":"Slow crack growth rate (notched) — 80°C, 500 h",
  "limitType":"qualitative","acceptanceOrType":"type","variesBy":["grade"],"testMethod":"Annex E, Annex J","valueTable":scg_vt},
 # ---- Resin (Table 2) ----
 {"clauseRef":"Cl 5.2","section":"Resin","parameterName":"Base density (resin)","unit":"kg/m³",
  "limitType":"range","acceptanceOrType":"acceptance","variesBy":[],"sourceTable":"Table 2","testMethod":"IS 7328","min":930,"max":960},
 {"clauseRef":"Cl 5.2","section":"Resin","parameterName":"Melt flow rate (resin)","unit":"g/10min",
  "limitType":"range","acceptanceOrType":"acceptance","variesBy":[],"sourceTable":"Table 2","testMethod":"IS 2530","min":0.2,"max":1.1},
 {"clauseRef":"Cl 5.2","section":"Resin","parameterName":"Thermal stability / oxidation induction time (resin), Min","unit":"min",
  "limitType":"min","acceptanceOrType":"acceptance","variesBy":[],"sourceTable":"Table 2","testMethod":"Annex B","min":20},
 {"clauseRef":"Cl 5.2","section":"Resin","parameterName":"Volatile matter (resin), Max","unit":"mg/kg",
  "limitType":"max","acceptanceOrType":"acceptance","variesBy":[],"sourceTable":"Table 2","testMethod":"Annex C","max":350},
 {"clauseRef":"Cl 5.2","section":"Resin","parameterName":"Water content (resin), Max","unit":"mg/kg",
  "limitType":"max","acceptanceOrType":"acceptance","variesBy":[],"sourceTable":"Table 2","testMethod":"Annex D","max":300},
]

tpl = {
 "isNumber":"IS 4984:2016",
 "title":"Polyethylene Pipes for Water Supply — Specification",
 "revision":"Fifth Revision",
 "parameterizationDims":["size","SDR","grade"],
 "dimensionOptions":{"size":sizes,"SDR":sdrs,"grade":grades},
 "defaults":{"size":110,"SDR":11,"grade":"PE 80"},
 "parameters":params
}
with open("../public/is_templates/IS_4984_2016.json","w") as f:
    json.dump(tpl,f,indent=2,ensure_ascii=False)
print("params:",len(params),"wall combos:",len(wall))

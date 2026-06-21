const IS_4985_SPECS = {
    sizes_db: {
        // min_od_any / max_od_any sourced directly from IS 4985:2021 Table 1 columns 5 & 6
        20:  {"min_od": 20.0,  "max_od": 20.3,  "ovality": 1.0, "socket": 16,  "min_od_any": 19.5, "max_od_any": 20.5, "thickness": {5: [1.5, 1.1, 1.5], 6: [1.8, 1.4, 1.8]}},
        25:  {"min_od": 25.0,  "max_od": 25.3,  "ovality": 1.0, "socket": 19,  "min_od_any": 24.5, "max_od_any": 25.5, "thickness": {4: [1.6, 1.2, 1.6], 5: [1.8, 1.4, 1.8], 6: [2.1, 1.7, 2.1]}},
        32:  {"min_od": 32.0,  "max_od": 32.3,  "ovality": 1.0, "socket": 22,  "min_od_any": 31.5, "max_od_any": 32.5, "thickness": {4: [1.9, 1.5, 1.9], 5: [2.2, 1.8, 2.2], 6: [2.7, 2.2, 2.7]}},
        40:  {"min_od": 40.0,  "max_od": 40.3,  "ovality": 1.0, "socket": 26,  "min_od_any": 39.5, "max_od_any": 40.5, "thickness": {3: [1.8, 1.4, 1.8], 4: [2.2, 1.8, 2.2], 5: [2.7, 2.2, 2.7], 6: [3.3, 2.8, 3.3]}},
        50:  {"min_od": 50.0,  "max_od": 50.3,  "ovality": 1.0, "socket": 31,  "min_od_any": 49.4, "max_od_any": 50.6, "thickness": {3: [2.1, 1.7, 2.1], 4: [2.8, 2.3, 2.8], 5: [3.3, 2.8, 3.3], 6: [4.0, 3.4, 4.0]}},
        63:  {"min_od": 63.0,  "max_od": 63.3,  "ovality": 1.0, "socket": 38,  "min_od_any": 62.2, "max_od_any": 63.8, "thickness": {2: [1.9, 1.5, 1.9], 3: [2.7, 2.2, 2.7], 4: [3.3, 2.8, 3.3], 5: [4.1, 3.5, 4.1], 6: [5.0, 4.3, 5.0]}},
        75:  {"min_od": 75.0,  "max_od": 75.3,  "ovality": 1.0, "socket": 44,  "min_od_any": 74.1, "max_od_any": 75.9, "thickness": {2: [2.2, 1.8, 2.2], 3: [3.1, 2.6, 3.1], 4: [4.0, 3.4, 4.0], 5: [4.9, 4.2, 4.9], 6: [5.9, 5.1, 5.9]}},
        90:  {"min_od": 90.0,  "max_od": 90.3,  "ovality": 1.2, "socket": 51,  "min_od_any": 88.9, "max_od_any": 91.1, "thickness": {1: [1.7, 1.3, 1.7], 2: [2.6, 2.1, 2.6], 3: [3.7, 3.1, 3.7], 4: [4.6, 4.0, 4.6], 5: [5.7, 5.0, 5.7], 6: [7.0, 6.1, 7.1]}},
        110: {"min_od": 110.0, "max_od": 110.4, "ovality": 1.4, "socket": 61,  "min_od_any": 108.6, "max_od_any": 111.4, "thickness": {1: [2.0, 1.6, 2.0], 2: [3.0, 2.5, 3.0], 3: [4.3, 3.7, 4.3], 4: [5.6, 4.9, 5.6], 5: [7.0, 6.1, 7.1], 6: [8.5, 7.5, 8.7]}},
        125: {"min_od": 125.0, "max_od": 125.4, "ovality": 1.5, "socket": 69,  "min_od_any": 123.5, "max_od_any": 126.5, "thickness": {1: [2.2, 1.8, 2.2], 2: [3.4, 2.9, 3.4], 3: [5.0, 4.3, 5.0], 4: [6.4, 5.6, 6.4], 5: [7.8, 6.9, 8.0], 6: [9.6, 8.5, 9.8]}},
        140: {"min_od": 140.0, "max_od": 140.5, "ovality": 1.7, "socket": 76,  "min_od_any": 138.3, "max_od_any": 141.7, "thickness": {1: [2.4, 2.0, 2.4], 2: [3.8, 3.2, 3.8], 3: [5.5, 4.8, 5.5], 4: [7.2, 6.3, 7.3], 5: [8.7, 7.7, 8.9], 6: [10.7, 9.5, 11.0]}},
        160: {"min_od": 160.0, "max_od": 160.5, "ovality": 2.0, "socket": 86,  "min_od_any": 158.0, "max_od_any": 162.0, "thickness": {1: [2.8, 2.3, 2.8], 2: [4.3, 3.7, 4.3], 3: [6.2, 5.4, 6.2], 4: [8.2, 7.2, 8.3], 5: [9.9, 8.8, 10.2], 6: [12.2, 10.9, 12.6]}},
        180: {"min_od": 180.0, "max_od": 180.6, "ovality": 2.2, "socket": 96,  "min_od_any": 177.8, "max_od_any": 182.2, "thickness": {1: [3.1, 2.6, 3.1], 2: [4.9, 4.2, 4.9], 3: [7.0, 6.1, 7.1], 4: [9.0, 8.0, 9.2], 5: [11.1, 9.9, 11.4], 6: [13.7, 12.2, 14.1]}},
        200: {"min_od": 200.0, "max_od": 200.6, "ovality": 2.4, "socket": 106, "min_od_any": 197.6, "max_od_any": 202.4, "thickness": {1: [3.4, 2.9, 3.4], 2: [5.3, 4.6, 5.3], 3: [7.7, 6.8, 7.9], 4: [10.0, 8.9, 10.3], 5: [12.3, 11.0, 12.7], 6: [15.2, 13.6, 15.7]}},
        225: {"min_od": 225.0, "max_od": 225.7, "ovality": 2.7, "socket": 119, "min_od_any": 222.3, "max_od_any": 227.7, "thickness": {1: [3.9, 3.3, 3.9], 2: [6.0, 5.2, 6.0], 3: [8.6, 7.6, 8.8], 4: [11.2, 10.0, 11.5], 5: [13.9, 12.4, 14.3], 6: [17.1, 15.3, 17.6]}},
        250: {"min_od": 250.0, "max_od": 250.8, "ovality": 3.0, "socket": 131, "min_od_any": 247.0, "max_od_any": 253.0, "thickness": {1: [4.2, 3.6, 4.2], 2: [6.5, 5.7, 6.5], 3: [9.6, 8.5, 9.8], 4: [12.6, 11.2, 12.9], 5: [15.4, 13.8, 15.9], 6: [18.9, 17.0, 19.6]}},
        280: {"min_od": 280.0, "max_od": 280.9, "ovality": 3.4, "socket": 146, "min_od_any": 276.6, "max_od_any": 283.4, "thickness": {1: [4.8, 4.1, 4.8], 2: [7.3, 6.4, 7.4], 3: [10.7, 9.5, 11.0], 4: [14.0, 12.5, 14.4], 5: [17.2, 15.4, 17.8], 6: [21.1, 19.0, 21.9]}},
        315: {"min_od": 315.0, "max_od": 316.0, "ovality": 3.8, "socket": 164, "min_od_any": 311.2, "max_od_any": 318.8, "thickness": {1: [5.3, 4.6, 5.3], 2: [8.2, 7.2, 8.3], 3: [12.0, 10.7, 12.4], 4: [15.6, 14.0, 16.1], 5: [19.3, 17.3, 19.9], 6: [23.8, 21.4, 24.7]}},
        355: {"min_od": 355.0, "max_od": 356.1, "ovality": 4.3, "socket": 184, "min_od_any": 350.7, "max_od_any": 359.3, "thickness": {1: [5.9, 5.1, 5.9], 2: [9.2, 8.1, 9.4], 3: [13.4, 12.0, 13.8], 4: [17.6, 15.8, 18.2], 5: [21.8, 19.6, 22.6], 6: [26.8, 24.1, 27.8]}},
        400: {"min_od": 400.0, "max_od": 401.2, "ovality": 4.8, "socket": 206, "min_od_any": 395.2, "max_od_any": 404.8, "thickness": {1: [6.6, 5.8, 6.7], 2: [10.3, 9.1, 10.5], 3: [15.1, 13.5, 15.6], 4: [19.8, 17.8, 20.5], 5: [24.4, 22.0, 25.3]}},
        450: {"min_od": 450.0, "max_od": 451.4, "ovality": 5.4, "socket": 231, "min_od_any": 444.6, "max_od_any": 455.4, "thickness": {1: [7.4, 6.5, 7.5], 2: [11.6, 10.3, 11.9], 3: [17.0, 15.2, 17.5], 4: [22.2, 20.0, 23.0], 5: [27.5, 24.8, 28.6]}},
        500: {"min_od": 500.0, "max_od": 501.5, "ovality": 6.0, "socket": 256, "min_od_any": 494.0, "max_od_any": 506.0, "thickness": {1: [8.2, 7.2, 8.3], 2: [12.8, 11.4, 13.2], 3: [18.8, 16.9, 19.5], 4: [24.8, 22.3, 25.7], 5: [30.5, 27.5, 31.7]}},
        560: {"min_od": 560.0, "max_od": 561.7, "ovality": 6.8, "socket": 286, "min_od_any": 553.2, "max_od_any": 566.8, "thickness": {1: [9.2, 8.1, 9.4], 2: [14.3, 12.8, 14.8], 3: [21.0, 18.9, 21.8], 4: [27.6, 24.9, 28.7], 5: [34.1, 30.8, 35.5]}},
        630: {"min_od": 630.0, "max_od": 631.9, "ovality": 7.6, "socket": 321, "min_od_any": 622.4, "max_od_any": 637.6, "thickness": {1: [10.3, 9.1, 10.5], 2: [16.1, 14.4, 16.6], 3: [23.7, 21.3, 24.5], 4: [31.0, 28.0, 32.2], 5: [38.4, 34.7, 40.0]}}
    },

    // A helper to generate the 32 rows dynamically based on the current Size and Class
    generateTestParameters: function(size, pipeClass, pipeType, isPlumbing) {
        size = parseFloat(size);
        pipeClass = parseInt(pipeClass);
        
        let data = this.sizes_db[size] || null;
        let t_min = "", t_max = "", t_avg = "", min_od = "", max_od = "", ovality = "", socket = "";
        
        if (data) {
            min_od = data.min_od.toFixed(1);
            max_od = data.max_od.toFixed(1);
            ovality = data.ovality.toFixed(1);
            socket = data.socket;
            if (data.thickness && data.thickness[pipeClass]) {
                let thick = data.thickness[pipeClass]; // [Avg, Min, Max]
                t_avg = thick[0];
                t_min = thick[1];
                t_max = thick[2];
            }
        }

        const max_od_variation = (data && data.max_od - data.min_od) ? (data.max_od - data.min_od).toFixed(2) : "";
        // Use actual Table 1 values — the ±1.3% formula was wrong for small sizes (e.g. 20mm: 19.7/20.3 vs actual 19.5/20.5)
        const min_od_any = (data && data.min_od_any != null) ? data.min_od_any.toFixed(1) : "";
        const max_od_any = (data && data.max_od_any != null) ? data.max_od_any.toFixed(1) : "";
        
        const any_od_type = (pipeClass > 3) ? "Quantitative" : "Qualitative";
        const any_od_expected = (pipeClass > 3) ? "" : "This requirement has not been checked according to foot note 1 of table 1";

        return [
            // Row 6
            { clause: "10.1", param: "Colour", spec_val: "As in Cl 10.1", type: "Qualitative", expected: "Satisfactory", min: "", max: "" },
            // Row 7
            { clause: "10.1", param: "Surface Finish", spec_val: "As in Cl 10.1", type: "Qualitative", expected: "Satisfactory", min: "", max: "" },
            // Row 8
            { clause: "7.2.1.1 Table 3", param: "Angle of taper (Note-1)", spec_val: "Specified : Shall not exceed 0 degree 30minute", type: "Qualitative", expected: "Socket Inside diameter shall be measured by manufactureres only as per Note 2 of Cl 7.2.1.1", min: "", max: "" },
            // Row 9
            { clause: "5", param: "CLASSIFICATION OF PIPES", spec_val: "Class 1/2/3/4/5/6", type: "Qualitative", expected: `Class ${pipeClass || ''} (As declared )`, min: "", max: "" },
            // Row 10
            { clause: "5.2", param: "The pipes shall be classified based on their application", spec_val: "a) Type A — Pipes for water supply; and b) Type B — Pipes for agricultural use.", type: "Qualitative", expected: `${pipeType || 'A'} (As declared)`, min: "", max: "" },
            // Row 11
            { clause: "7", param: "DIMENSIONS-PIPE-Nominal Diameter", spec_val: "Nominal Outside Diameter (Nominal Size)", type: "Qualitative", expected: `${size || ''} (As declared )`, min: "", max: "" },
            // Row 12
            { clause: "7.1.1.1", param: "DIMENSIONS-PIPE-Mean O.D. (Minimum)", spec_val: `${min_od} mm,Min`, type: "Quantitative", expected: "", min: min_od, max: "" },
            // Row 13
            { clause: "7.1.1.1", param: "DIMENSIONS-PIPE-Mean O.D. (Maximum)", spec_val: `${max_od} mm, Max`, type: "Quantitative", expected: "", min: "", max: max_od },
            // Row 14
            { clause: "7.1.1.1", param: "DIMENSIONS-PIPE-Mean O.D. Variation", spec_val: `${max_od_variation} mm, max`, type: "Quantitative", expected: "", min: "", max: max_od_variation },
            // Row 15
            { clause: "7.1.1.2", param: "DIMENSIONS-PIPE-O.D. at any Point (Minimum)", spec_val: `${min_od_any} mm, Min`, type: any_od_type, expected: any_od_expected, min: min_od_any, max: "" },
            // Row 16
            { clause: "7.1.1.2", param: "DIMENSIONS-PIPE-O.D. at any Point (Maximum)", spec_val: `${max_od_any} mm, Max`, type: any_od_type, expected: any_od_expected, min: "", max: max_od_any },
            // Row 17
            { clause: "7.1.1.2", param: "DIMENSIONS-PIPE-Ovality (Maximum)", spec_val: ovality, type: "Quantitative", expected: "", min: "", max: ovality },
            // Row 18
            { clause: "7.1.2.1", param: "DIMENSIONS-PIPE-Thickness (Minimum)", spec_val: `${t_min}mm`, type: "Quantitative", expected: "", min: t_min, max: "" },
            // Row 19
            { clause: "7.1.2.1", param: "DIMENSIONS-PIPE-Thickness (Maximum)", spec_val: `${t_max}mm`, type: "Quantitative", expected: "", min: "", max: t_max },
            // Row 20
            { clause: "7.1.2.1", param: "DIMENSIONS-PIPE-Average Thickness", spec_val: `${t_avg}mm, Min`, type: "Quantitative", expected: "", min: t_avg, max: "" },
            // Row 21
            { clause: "7.2.1", param: "DIMENSIONS-Socket", spec_val: "", type: "Qualitative", expected: "Satisfactory", min: "", max: "" },
            // Row 22
            { clause: "7.2.1.1 Table 3", param: "DIMENSIONS-Socket-Sockets for solvent cement jointing-Minimum Length", spec_val: `Socket Length (min): ${socket} mm`, type: "Text", expected: "", options: ["Socket end not provided"], min: socket, max: "" },
            // Row 23
            { clause: "7.2.1.2 Table 4", param: "DIMENSIONS-Sockets for elastomeric sealing ring joints-Socket inner Diameter", spec_val: "mm", type: "Qualitative", expected: "NA", min: "", max: "" },
            // Row 24
            { clause: "8", param: "SEALING RINGS", spec_val: "Conforms With IS 5382", type: "Qualitative", expected: "NA", min: "", max: "" },
            // Row 25
            { clause: "9.1", param: "PIPE ENDS", spec_val: "The ends of the pipes meant for solvent cementing (both plain and bell ended) shall be cleanly cut and shall be reasonably square to the axis of the pipe or may be chamfered at the plain end", type: "Qualitative", expected: "Full length not provided", min: "", max: "" },
            // Row 26
            { clause: "10.1", param: "PHYSICAL AND CHEMICAL CHARACTERISTICS-Visual Appearance", spec_val: "The colour of the pipes shall be light grey. Slight variations in the appearance of the colour are permitted.", type: "Qualitative", expected: "Satisfactory", min: "", max: "" },
            // Row 27
            { clause: "10.1.1", param: "PHYSICAL AND CHEMICAL CHARACTERISTICS-Visual Appearance", spec_val: "The colour of the pipes shall be light grey. \nThe internal and external surfaces of the pipe shall be smooth, clean and free from grooving and other defects. ", type: "Qualitative", expected: "Satisfactory", min: "", max: "" },
            // Row 28
            { clause: "10.2", param: "PHYSICAL AND CHEMICAL CHARACTERISTICS-Opacity", spec_val: "The wall of the plain pipe shall not transmit more than 0.2 percent of the visible light falling on it when tested in accordance with IS 12235 (Part 3).", type: "Quantitative", expected: "", min: "", max: "0.2" },
            // Row 30
            { clause: "11.1", param: "MECHANICAL PROPERTIES-Reversion", spec_val: "Maximum: 5 %", type: "Quantitative", expected: "", min: "", max: "5" },
            // Row 31
            { clause: "11.2", param: "MECHANICAL PROPERTIES-Vicat Softening Temperature", spec_val: "Min: 80 °C", type: "Qualitative", expected: "more than 80 °C", options: ["less than 80 °C"], min: "", max: "" },
            // Row 31a
            { clause: "11.2", param: "MECHANICAL PROPERTIES-Resistance to External Blows at 0°C", spec_val: "Shall have a True Impact Rate of not more than 10.", type: "Qualitative", expected: "Less than 10% TIR", min: "", max: "" },
            // Row 32
            { clause: "11.3", param: "MECHANICAL PROPERTIES-Density", spec_val: "1.40 and 1.46", type: "Quantitative", expected: "", min: "1.40", max: "1.46" },
            // Row 35
            { clause: "11.1 Table 6", param: "MECHANICAL PROPERTIES-Hydrostatic Pressure Test (Acceptance Test)", spec_val: "At Test pressure 4.19 × 0.6 MPa (min.) for 1 h the pipe shall not fail.", type: "Qualitative", expected: isPlumbing === "Yes" ? "Not applicable" : "Pass", options: isPlumbing === "Yes" ? [] : ["leakage observed", "bulged observed"], min: "", max: "" },
            // Row 36
            { clause: "11.1 Table 7", param: "MECHANICAL PROPERTIES-Hydrostatic Pressure Test (Acceptance Test)-for Integral Sealing Ring Sockets", spec_val: "The pipe shall not fail during the prescribed test duration", type: "Qualitative", expected: "NA", min: "", max: "" },
            // Row 37
            { clause: "11.1.1", param: "MECHANICAL PROPERTIES-Hydrostatic Pressure Test (Acceptance Test)-for Plumbing pipes", spec_val: "The pipe shall not fail during the prescribed test duration", type: "Qualitative", expected: isPlumbing === "Yes" ? "Pass" : "NA", options: isPlumbing === "Yes" ? ["leakage observed", "bulged observed"] : [], min: "", max: "" },
            // Row 38
            { clause: "13.1.2", param: "MARKING", spec_val: "Type A shall additionally bear continuous longitudinal blue colour strip printing. These longitudinal blue colour strip shall be so placed so as to not merge/disturb the information marked on the pipes", type: "Qualitative", expected: "Satisfactory", min: "", max: "" }
        ];
    }
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = IS_4985_SPECS;
}

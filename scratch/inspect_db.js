const supabase = require('../database-supabase');

async function inspect() {
    try {
        console.log("Checking samples and their IS Numbers...");
        const { data: samples, error } = await supabase.from('samples').select('encodedCode, isNumber, assignedTo, appStatus');
        if (error) {
            console.error("Error fetching samples:", error);
            return;
        }
        console.log(`Total samples: ${samples.length}`);
        const counts = {};
        samples.forEach(s => {
            counts[s.isNumber] = (counts[s.isNumber] || 0) + 1;
        });
        console.log("Samples count by IS Number:", counts);

        // Print a few unassigned samples
        const unassigned = samples.filter(s => !s.assignedTo || s.assignedTo === '');
        console.log(`Unassigned samples: ${unassigned.length}`);
        console.log("First 10 unassigned samples:", unassigned.slice(0, 10));
    } catch(e) {
        console.error(e);
    }
}
inspect();

const supabase = require('./database-supabase');

async function testAssign() {
    const { data: unassignedSamples } = await supabase.from('samples').select('*').or('assignedTo.is.null,assignedTo.eq.\'\'');
    console.log("Unassigned samples count:", unassignedSamples ? unassignedSamples.length : 0);
    if(unassignedSamples && unassignedSamples.length > 0) {
        console.log("Sample 0:", unassignedSamples[0]);
    }
    
    const { data: competencies } = await supabase.from('employee_competencies').select('*');
    const compMap = {};
    (competencies || []).forEach(c => {
        if (!compMap[c.isNumber]) compMap[c.isNumber] = [];
        compMap[c.isNumber].push(c);
    });
    
    console.log("Comp map keys:", Object.keys(compMap));
}
testAssign();

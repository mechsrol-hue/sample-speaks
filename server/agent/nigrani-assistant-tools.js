// Disha Agent — Phase 3 tools
// Function definitions for Gemini to call mid-conversation.
// Each function is a tool Disha can invoke to answer questions more accurately.

const supabase = require('../../database-supabase');

const TOOLS = [
    {
        name: 'get_workload_snapshot',
        description: 'Get current workload for all TAs and lab-wide stats',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_sample',
        description: 'Look up a single sample by ID or encoded code. Returns full row.',
        inputSchema: {
            type: 'object',
            properties: {
                sampleId: { type: 'string', description: 'Sample ID (numeric) or encoded code' },
            },
            required: ['sampleId'],
        },
    },
    {
        name: 'find_competent_tas',
        description: 'Find TAs competent to handle a specific IS standard',
        inputSchema: {
            type: 'object',
            properties: {
                isNumber: { type: 'string', description: 'IS standard (e.g., "IS 4985")' },
            },
            required: ['isNumber'],
        },
    },
    {
        name: 'get_aging_breakdown',
        description: 'Get samples grouped by age buckets (0-15d, 16-30d, 31-45d, 46-90d, 90+d)',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'list_pending_recommendations',
        description: 'Get all pending auto-assign recommendations (not yet approved)',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_open_notifications',
        description: 'Get all open Disha alerts (shell-life, workload, aging, unassigned)',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_template',
        description: 'Get the testing template for an IS standard (hours, equipment, clauses, TAT)',
        inputSchema: {
            type: 'object',
            properties: {
                isNumber: { type: 'string', description: 'IS standard' },
            },
            required: ['isNumber'],
        },
    },
    {
        name: 'count_distinct_is',
        description: 'Count total unique IS standards in pending samples',
        inputSchema: {
            type: 'object',
            properties: {},
            required: [],
        },
    },
    {
        name: 'get_audit_log',
        description: 'Get recent audit actions (reassignments, approvals, executions)',
        inputSchema: {
            type: 'object',
            properties: {
                limit: { type: 'number', description: 'Max rows to return (default 20)' },
                actionType: { type: 'string', description: 'Filter to specific action type (optional)' },
            },
            required: [],
        },
    },
];

// --- Tool implementations ---

async function getWorkloadSnapshot() {
    const { data: pending } = await supabase
        .from('samples')
        .select('assignedTo, isNumber')
        .in('appStatus', ['Pending']);

    const { data: employees } = await supabase
        .from('employee_profiles')
        .select('fullName, designation, isActive');

    const loadMap = {};
    (pending || []).forEach(s => {
        const ta = s.assignedTo || 'UNASSIGNED';
        loadMap[ta] = (loadMap[ta] || 0) + 1;
    });

    const activeTAs = (employees || [])
        .filter(e => e.isActive !== false)
        .map(e => e.fullName);

    const counts = Object.values(loadMap).filter(c => c > 0).sort((a, b) => a - b);
    const median = counts.length
        ? counts.length % 2 === 0
            ? (counts[counts.length / 2 - 1] + counts[counts.length / 2]) / 2
            : counts[Math.floor(counts.length / 2)]
        : 0;

    return {
        totalPending: pending ? pending.length : 0,
        loadMap,
        activeTAs,
        median,
    };
}

async function getSample(sampleId) {
    const id = isNaN(sampleId) ? 'encodedCode' : 'id';
    const { data: sample, error } = await supabase
        .from('samples')
        .select('*')
        .eq(id, sampleId)
        .maybeSingle();

    if (error) throw error;
    if (!sample) return { error: `Sample ${sampleId} not found` };
    return sample;
}

async function findCompetenTAs(isNumber) {
    const { data: comps } = await supabase
        .from('employee_competencies')
        .select('*, employee_profiles!inner(fullName, designation)')
        .eq('isNumber', isNumber);

    if (!comps || !comps.length) return { competent: [], count: 0 };

    return {
        count: comps.length,
        competent: comps.map(c => ({
            ta: c.employee_profiles?.fullName,
            proficiency: c.proficiencyLevel,
        })),
    };
}

async function getAgingBreakdown() {
    const { data: pending } = await supabase
        .from('samples')
        .select('encodedCode, receivedOn, assignedTo')
        .in('appStatus', ['Pending']);

    const now = Date.now();
    const buckets = { '0-15d': [], '16-30d': [], '31-45d': [], '46-90d': [], '90+d': [] };

    (pending || []).forEach(s => {
        if (!s.receivedOn) return;
        const d = new Date(s.receivedOn).getTime();
        const ageDays = Math.floor((now - d) / 86400000);

        let bucket = ageDays <= 15 ? '0-15d'
            : ageDays <= 30 ? '16-30d'
            : ageDays <= 45 ? '31-45d'
            : ageDays <= 90 ? '46-90d'
            : '90+d';

        buckets[bucket].push({
            code: s.encodedCode,
            age: ageDays,
            assignedTo: s.assignedTo || 'UNASSIGNED',
        });
    });

    return Object.entries(buckets).map(([k, v]) => ({ range: k, count: v.length, samples: v.slice(0, 5) }));
}

async function listPendingRecommendations() {
    const { data, error } = await supabase
        .from('assignment_recommendations')
        .select('*')
        .eq('status', 'pending')
        .order('score', { ascending: false })
        .limit(50);

    if (error) throw error;
    return { count: (data || []).length, recommendations: data || [] };
}

async function getOpenNotifications() {
    const { data } = await supabase
        .from('lab_notifications')
        .select('id, type, severity, title, created_at')
        .eq('status', 'open')
        .order('severity desc, created_at desc');

    return { count: (data || []).length, notifications: data || [] };
}

async function getTemplate(isNumber) {
    const { data: prefs } = await supabase
        .from('system_preferences')
        .select('value')
        .eq('key', `template_${isNumber}`)
        .maybeSingle();

    if (!prefs) return { error: `No template found for ${isNumber}` };
    try {
        return JSON.parse(prefs.value);
    } catch (_) {
        return { error: 'Malformed template JSON' };
    }
}

async function countDistinctIS() {
    const { data, error } = await supabase
        .from('samples')
        .select('isNumber')
        .in('appStatus', ['Pending']);

    if (error) throw error;
    const distinct = new Set((data || []).map(s => s.isNumber).filter(Boolean));
    return { count: distinct.size, standards: [...distinct].sort() };
}

async function getAuditLog(limit = 20, actionType = null) {
    let q = supabase
        .from('audit_log')
        .select('*')
        .order('executed_at', { ascending: false })
        .limit(limit);

    if (actionType) q = q.eq('action_type', actionType);

    const { data, error } = await q;
    if (error) throw error;
    return { count: (data || []).length, logs: data || [] };
}

// --- Tool dispatcher ---
async function callTool(name, args) {
    switch (name) {
        case 'get_workload_snapshot':
            return await getWorkloadSnapshot();
        case 'get_sample':
            return await getSample(args.sampleId);
        case 'find_competent_tas':
            return await findCompetenTAs(args.isNumber);
        case 'get_aging_breakdown':
            return await getAgingBreakdown();
        case 'list_pending_recommendations':
            return await listPendingRecommendations();
        case 'get_open_notifications':
            return await getOpenNotifications();
        case 'get_template':
            return await getTemplate(args.isNumber);
        case 'count_distinct_is':
            return await countDistinctIS();
        case 'get_audit_log':
            return await getAuditLog(args.limit || 20, args.actionType || null);
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}

// --- Gemini function declarations (for function-calling mode) ---
const functionDeclarations = TOOLS.map(t => ({
    name: t.name,
    description: t.description,
    parameters: {
        type: 'OBJECT',
        properties: Object.entries(t.inputSchema.properties).reduce((acc, [key, schema]) => {
            acc[key] = {
                type: schema.type.toUpperCase(),
                description: schema.description,
            };
            return acc;
        }, {}),
        required: t.inputSchema.required,
    },
}));

module.exports = {
    TOOLS,
    callTool,
    functionDeclarations,
};

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL || 'https://qahmjmonqjqzwxsieiew.supabase.co';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || 'sb_publishable_Jpm4rwLHZQ-uwHXlT0OhGw_RJ0YGQTa';

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;

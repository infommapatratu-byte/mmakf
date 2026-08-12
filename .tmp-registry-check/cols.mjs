import postgres from 'postgres';
const sql = postgres('postgresql://postgres:postgres@127.0.0.1:5439/postgres', { max: 1, prepare: false });
const tables = ['state_units','district_units','dojos','persons','rank_records','certificates',
  'competition_events','event_categories','competition_results','official_quals',
  'ranking_rulesets','ranking_periods','ranking_entries'];
for (const t of tables) {
  const rows = await sql`select column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_name = ${t} order by ordinal_position`;
  console.log('\n== ' + t);
  console.log(rows.filter(r => r.is_nullable === 'NO' && !r.column_default)
    .map(r => `${r.column_name}:${r.data_type}`).join(', '));
}
await sql.end();

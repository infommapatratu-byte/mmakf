import postgres from 'postgres';
const sql = postgres('postgresql://postgres:postgres@127.0.0.1:5439/postgres', { max: 1, prepare: false });
for (const t of ['official_quals','event_entries','competition_results','competition_events','event_categories','certificates']) {
  const rows = await sql`select column_name, data_type, is_nullable, column_default
    from information_schema.columns where table_name = ${t} order by ordinal_position`;
  console.log('\n== ' + t);
  console.log(rows.map(r => `${r.column_name}${r.is_nullable==='NO'?'!':''}${r.column_default?'=def':''}`).join(', '));
}
for (const e of ['event_kind','discipline_kind','result_status','certificate_kind','rank_kind']) {
  const v = await sql`select e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname=${e} order by e.enumsortorder`;
  console.log(`\nenum ${e}: ` + v.map(r=>r.enumlabel).join('|'));
}
await sql.end();

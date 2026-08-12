import postgres from 'postgres';
const sql = postgres('postgresql://postgres:postgres@127.0.0.1:5443/postgres', { max: 1, prepare: false });
for (const e of ['event_status','entry_status','unit_status','person_status','certificate_status']) {
  const v = await sql`select e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname=${e} order by e.enumsortorder`;
  console.log(`${e}: ` + v.map(r=>r.enumlabel).join('|'));
}
await sql.end();

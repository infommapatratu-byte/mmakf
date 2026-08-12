import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {
  const r = await sql`select count(*)::int as n from state_units`;
  console.log('count', r);
  const [st] = await sql`insert into state_units (code, state, name, status) values ('TEST-ST2','Testland2','Test State Unit 2','active') returning id`;
  console.log('inserted', st);
} catch (e) { console.log('ERR', e.message, e.position, e.query || ''); }
await sql.end();

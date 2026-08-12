import postgres from 'postgres';
const sql = postgres('postgresql://postgres:postgres@127.0.0.1:5443/postgres', { max: 1, prepare: false });
try {
  await sql.unsafe(`insert into competition_results (event_id,category_id,entry_id,person_id,placing,medal,status,matches_won,matches_lost) values (1,1,1,1,1,'gold','final',3,0)`);
  console.log('unsafe ok');
} catch (e) { console.log('unsafe err:', e.message); }
try {
  const r = await sql`select column_name from information_schema.columns where table_name='competition_results' and column_name in ('placing','medal')`;
  console.log('cols', r.map(x=>x.column_name));
} catch (e) { console.log('cols err', e.message); }
await sql.end();

import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
for (const t of ['competition_results','match_events','matches','draws','event_officials','event_entries','event_categories','competition_events','persons','dojos','state_units']) {
  await sql.unsafe(`delete from ${t}`);
}
console.log('cleaned');
await sql.end();

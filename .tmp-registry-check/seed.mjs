// TEMPORARY render-check fixture. Writes to the ISOLATED scratch database on
// port 5443 only. Never runs against .pgdata, never committed, deleted after use.
import postgres from 'postgres';
const sql = postgres('postgresql://postgres:postgres@127.0.0.1:5443/postgres', { max: 1, prepare: false });

for (const t of ['ranking_entries','ranking_periods','ranking_rulesets','competition_results','event_entries','event_categories','competition_events','official_quals','examiner_quals','instructor_quals','certificates','rank_records','persons','dojos','district_units','state_units']) {
  await sql.unsafe(`delete from ${t}`);
}

const [st] = await sql`insert into state_units (code,state,name,status,chartered_on,charter_expires_on)
  values ('TEST-ST-JH','Jharkhand','Test State Unit','active','2024-01-01','2027-01-01') returning id`;
const [di] = await sql`insert into district_units (code,state_unit_id,district,name,status,chartered_on,charter_expires_on)
  values ('TEST-DIST-RMG',${st.id},'Ramgarh','Test District Unit','active','2024-02-01','2027-02-01') returning id`;
const [d1] = await sql`insert into dojos (code,name,state_unit_id,district_unit_id,city,status,affiliated_on,affiliation_expires_on)
  values ('TEST-DOJO-1','Test Current Dojo',${st.id},${di.id},'Patratu','active','2024-03-01','2027-03-01') returning id`;
await sql`insert into dojos (code,name,state_unit_id,district_unit_id,city,status,affiliated_on,affiliation_expires_on)
  values ('TEST-DOJO-2','Test Lapsed Dojo',${st.id},${di.id},'Ramgarh','expired','2020-03-01','2023-03-01')`;
await sql`insert into dojos (code,name,state_unit_id,city,status,affiliated_on)
  values ('TEST-DOJO-3','Test Undated Dojo',${st.id},'Ranchi','provisional','2025-06-01')`;
await sql`insert into dojos (code,name,state_unit_id,city,status)
  values ('TEST-DOJO-4','Test Draft Applicant',${st.id},'Bokaro','draft')`;

const [p1] = await sql`insert into persons (federation_id,full_name,dob,city,state_unit_id,district_unit_id,dojo_id,status,email,phone)
  values ('TEST-MEM-0001','Test Athlete One','2008-05-04','Patratu',${st.id},${di.id},${d1.id},'active','x@example.invalid','+910000000000') returning id`;
const [p2] = await sql`insert into persons (federation_id,full_name,dob,city,state_unit_id,dojo_id,status)
  values ('TEST-MEM-0002','Test Official Two','1990-01-01','Ranchi',${st.id},${d1.id},'active') returning id`;

await sql`insert into rank_records (person_id,kind,grade_label,grade_ordinal,awarded_on,status)
  values (${p1.id},'kyu','1st Kyu',1,'2025-04-01','active')`;
await sql`insert into rank_records (person_id,kind,grade_label,grade_ordinal,awarded_on,status)
  values (${p2.id},'dan','2nd Dan',2,'2019-04-01','active')`;

await sql`insert into certificates (certificate_no,kind,person_id,title,issued_on,issuing_authority,verify_token,snapshot,status)
  values ('TEST-CERT-0001','kyu_grade',${p1.id},'1st Kyu Certificate','2025-04-10','Test Authority','tok-test-1',${sql.json({ note: 'fixture' })},'issued')`;

await sql`insert into official_quals (person_id,kind,level,granted_on,expires_on,status)
  values (${p2.id},'referee','National','2024-01-01','2027-01-01','active')`;
await sql`insert into official_quals (person_id,kind,level,granted_on,status)
  values (${p1.id},'judge',null,'2025-01-01','active')`;

const [ev] = await sql`insert into competition_events (code,title,kind,status,starts_on,city,state_unit_id)
  values ('TEST-EV-1','Test National Championship','national_championship','results_final','2026-02-14','Ranchi',${st.id}) returning id`;
const [cat] = await sql`insert into event_categories (event_id,code,label,discipline,gender,age_group,max_weight_grams)
  values (${ev.id},'K-CAD-M-61','Cadet Male Kumite -61kg','kumite','male','cadet',61000) returning id`;
const [en] = await sql`insert into event_entries (entry_no,event_id,category_id,person_id,status)
  values ('TEST-ENT-1',${ev.id},${cat.id},${p1.id},'confirmed') returning id`;
await sql`insert into competition_results (event_id,category_id,entry_id,person_id,placing,medal,status,matches_won,matches_lost)
  values (${ev.id},${cat.id},${en.id},${p1.id},1,'gold','final',3,0)`;

const [rs] = await sql`insert into ranking_rulesets (code,title,rules,window_months,best_n_results,effective_from,status)
  values ('TEST-RS-1','Test Ranking Ruleset 2026',${sql.json({ points: { national_championship: { 1: 1000, 2: 700 } } })},24,4,'2026-01-01','approved') returning id`;
const [per] = await sql`insert into ranking_periods (ruleset_id,label,category_key,published_at,athlete_count,event_count)
  values (${rs.id},'2026 Q1','kumite|male|cadet|max61000', now(), 1, 1) returning id`;
const working = {
  rulesetId: rs.id, rulesetCode: 'TEST-RS-1', rulesetTitle: 'Test Ranking Ruleset 2026',
  categoryKey: 'kumite|male|cadet|max61000', asOf: '2026-03-31', computedBy: 'fixture',
  pointsTable: { 'points.national_championship': { 1: 1000, 2: 700 } },
  options: {
    window: { applied: true, value: 24, source: 'ruleset column', detail: 'Results within 24 months of the as-at date.' },
    bestN: { applied: true, value: 4, source: 'ruleset column', detail: 'Best 4 counted.' },
    tieBreak: { applied: false, value: null, source: 'not set by the ruleset', detail: 'The ruleset sets no tie-break, so none was applied.' },
  },
  totalPoints: 1000,
  contributions: [
    { resultId: 1, eventId: ev.id, eventCode: 'TEST-EV-1', eventTitle: 'Test National Championship',
      eventKind: 'national_championship', eventStatus: 'completed', eventDate: '2026-02-14',
      eventDateSource: 'starts_on', categoryId: cat.id, categoryCode: 'K-CAD-M-61',
      categoryKey: 'kumite|male|cadet|max61000', placing: 1, medal: 'gold', resultStatus: 'final',
      points: 1000, rule: 'points.national_championship.1', priced: true, counted: true,
      reason: 'counted', detail: 'Priced by the approved ruleset.' },
    { resultId: 2, eventId: ev.id, eventCode: 'TEST-EV-2', eventTitle: 'Test Open (not final)',
      eventKind: 'open_national', eventStatus: 'completed', eventDate: '2026-03-01',
      eventDateSource: 'starts_on', categoryId: cat.id, categoryCode: 'K-CAD-M-61',
      categoryKey: 'kumite|male|cadet|max61000', placing: 2, medal: 'silver', resultStatus: 'provisional',
      points: 0, rule: null, priced: false, counted: false,
      reason: 'result not final', detail: 'The result has not been finalised by the federation.' },
  ],
  tieBreakValues: {}, tieBreakNote: 'The ruleset sets no tie-break, so none was applied.',
  sharedRankWithPersonIds: [],
};
await sql`insert into ranking_entries (period_id,person_id,rank,points,previous_rank,contributions,state_unit_id,dojo_id)
  values (${per.id},${p1.id},1,1000,3,${sql.json(working)},${st.id},${d1.id})`;

console.log(JSON.stringify({ state: st.id, dojo: d1.id, p1: p1.id, p2: p2.id, period: per.id }));
await sql.end();

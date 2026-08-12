// TEMPORARY render-check fixture — isolated scratch DB on 5447 only. Not committed.
import postgres from 'postgres';
const sql = postgres('postgresql://postgres:postgres@127.0.0.1:5447/postgres', { max: 1, prepare: false });
const j = (o) => "'" + JSON.stringify(o).replace(/'/g, "''") + "'::jsonb";

const working = {
  rulesetId: 1, rulesetCode: 'TEST-RS-1', rulesetTitle: 'Test Ranking Ruleset 2026',
  categoryKey: 'kumite|male|cadet|max61000', asOf: '2026-03-31', computedBy: 'fixture',
  pointsTable: { 'points.national_championship': { '1': 1000, '2': 700 } },
  options: {
    window: { applied: true, value: 24, source: 'ruleset column', detail: 'Results within 24 months of the as-at date.' },
    bestN: { applied: true, value: 4, source: 'ruleset column', detail: 'Best 4 results counted.' },
    tieBreak: { applied: false, value: null, source: 'not set by the ruleset', detail: 'The ruleset sets no tie-break, so none was applied.' },
  },
  totalPoints: 1000,
  contributions: [
    { resultId: 1, eventId: 1, eventCode: 'TEST-EV-1', eventTitle: 'Test National Championship',
      eventKind: 'national_championship', eventStatus: 'results_final', eventDate: '2026-02-14',
      eventDateSource: 'starts_on', categoryId: 1, categoryCode: 'K-CAD-M-61',
      categoryKey: 'kumite|male|cadet|max61000', placing: 1, medal: 'gold', resultStatus: 'final',
      points: 1000, rule: 'points.national_championship.1', priced: true, counted: true,
      reason: 'counted', detail: 'Priced by the approved ruleset.' },
    { resultId: 2, eventId: 2, eventCode: 'TEST-EV-2', eventTitle: 'Test Open (not yet final)',
      eventKind: 'open_national', eventStatus: 'results_pending', eventDate: '2026-03-01',
      eventDateSource: 'starts_on', categoryId: 1, categoryCode: 'K-CAD-M-61',
      categoryKey: 'kumite|male|cadet|max61000', placing: 2, medal: 'silver', resultStatus: 'provisional',
      points: 0, rule: null, priced: false, counted: false,
      reason: 'result not final', detail: 'The result has not been finalised by the federation.' },
    { resultId: 3, eventId: 3, eventCode: 'TEST-EV-3', eventTitle: 'Test Seminar',
      eventKind: 'seminar', eventStatus: 'archived', eventDate: '2025-11-02',
      eventDateSource: 'starts_on', categoryId: 1, categoryCode: 'K-CAD-M-61',
      categoryKey: 'kumite|male|cadet|max61000', placing: 1, medal: null, resultStatus: 'final',
      points: 0, rule: null, priced: false, counted: false,
      reason: 'not covered by ruleset', detail: 'The ruleset sets no points for event kind "seminar".' },
  ],
  tieBreakValues: {}, tieBreakNote: 'The ruleset sets no tie-break, so none was applied.',
  sharedRankWithPersonIds: [],
};

const S = [
  "delete from ranking_entries; delete from ranking_periods; delete from ranking_rulesets;",
  "delete from competition_results; delete from event_entries; delete from event_categories;",
  "delete from competition_events; delete from official_quals; delete from certificates;",
  "delete from rank_records; delete from persons; delete from dojos; delete from district_units;",
  "delete from state_units;",

  "insert into state_units (code,state,name,status,chartered_on,charter_expires_on)",
  " values ('TEST-ST-JH','Jharkhand','Test State Unit','active','2024-01-01','2027-01-01');",

  "insert into district_units (code,state_unit_id,district,name,status,chartered_on,charter_expires_on)",
  " values ('TEST-DIST-RMG',(select id from state_units where code='TEST-ST-JH'),'Ramgarh','Test District Unit','active','2024-02-01','2027-02-01');",

  "insert into dojos (code,name,state_unit_id,district_unit_id,city,status,affiliated_on,affiliation_expires_on) values",
  " ('TEST-DOJO-1','Test Current Dojo',(select id from state_units where code='TEST-ST-JH'),(select id from district_units where code='TEST-DIST-RMG'),'Patratu','active','2024-03-01','2027-03-01'),",
  " ('TEST-DOJO-2','Test Lapsed Dojo',(select id from state_units where code='TEST-ST-JH'),(select id from district_units where code='TEST-DIST-RMG'),'Ramgarh','expired','2020-03-01','2023-03-01'),",
  " ('TEST-DOJO-3','Test Suspended Dojo',(select id from state_units where code='TEST-ST-JH'),null,'Bokaro','suspended','2021-03-01','2026-12-01');",
  "insert into dojos (code,name,state_unit_id,city,status,affiliated_on) values",
  " ('TEST-DOJO-4','Test Undated Provisional',(select id from state_units where code='TEST-ST-JH'),'Ranchi','provisional','2025-06-01');",
  "insert into dojos (code,name,state_unit_id,city,status) values",
  " ('TEST-DOJO-5','Test Draft Applicant',(select id from state_units where code='TEST-ST-JH'),'Dhanbad','draft');",

  "insert into persons (federation_id,full_name,dob,city,state_unit_id,district_unit_id,dojo_id,status,email,phone) values",
  " ('TEST-MEM-0001','Test Athlete One','2008-05-04','Patratu',(select id from state_units where code='TEST-ST-JH'),(select id from district_units where code='TEST-DIST-RMG'),(select id from dojos where code='TEST-DOJO-1'),'active','never@example.invalid','+910000000000');",
  "insert into persons (federation_id,full_name,dob,city,state_unit_id,dojo_id,status) values",
  " ('TEST-MEM-0002','Test Official Two','1990-01-01','Ranchi',(select id from state_units where code='TEST-ST-JH'),(select id from dojos where code='TEST-DOJO-1'),'active');",

  "insert into rank_records (person_id,kind,grade_label,grade_ordinal,awarded_on,status) values",
  " ((select id from persons where federation_id='TEST-MEM-0001'),'kyu','1st Kyu',1,'2025-04-01','active'),",
  " ((select id from persons where federation_id='TEST-MEM-0002'),'dan','2nd Dan',2,'2019-04-01','active');",

  "insert into certificates (certificate_no,kind,person_id,title,issued_on,issuing_authority,verify_token,snapshot,status) values",
  " ('TEST-CERT-0001','kyu_grade',(select id from persons where federation_id='TEST-MEM-0001'),'1st Kyu Certificate','2025-04-10','Test Issuing Authority','tok-test-1'," + j({ fixture: true }) + ",'issued');",

  "insert into official_quals (person_id,kind,level,granted_on,expires_on,status) values",
  " ((select id from persons where federation_id='TEST-MEM-0002'),'referee','National','2024-01-01','2027-01-01','active');",
  "insert into official_quals (person_id,kind,level,granted_on,status) values",
  " ((select id from persons where federation_id='TEST-MEM-0001'),'judge',null,'2025-01-01','active');",

  "insert into competition_events (code,title,kind,status,starts_on,city,state_unit_id)",
  " values ('TEST-EV-1','Test National Championship','national_championship','results_final','2026-02-14','Ranchi',(select id from state_units where code='TEST-ST-JH'));",
  "insert into event_categories (event_id,code,label,discipline,gender,age_group,max_weight_grams)",
  " values ((select id from competition_events where code='TEST-EV-1'),'K-CAD-M-61','Cadet Male Kumite -61kg','kumite','male','cadet',61000);",
  "insert into event_entries (entry_no,event_id,category_id,person_id,status)",
  " values ('TEST-ENT-1',(select id from competition_events where code='TEST-EV-1'),(select id from event_categories where code='K-CAD-M-61'),(select id from persons where federation_id='TEST-MEM-0001'),'confirmed');",
  'insert into competition_results (event_id,category_id,entry_id,person_id,"placing",medal,status,matches_won,matches_lost)',
  " values ((select id from competition_events where code='TEST-EV-1'),(select id from event_categories where code='K-CAD-M-61'),(select id from event_entries where entry_no='TEST-ENT-1'),(select id from persons where federation_id='TEST-MEM-0001'),1,'gold','final',3,0);",

  "insert into ranking_rulesets (code,title,rules,window_months,best_n_results,effective_from,status)",
  " values ('TEST-RS-1','Test Ranking Ruleset 2026'," + j({ points: { national_championship: { '1': 1000, '2': 700 } } }) + ",24,4,'2026-01-01','approved');",
  "insert into ranking_periods (ruleset_id,label,category_key,published_at,athlete_count,event_count)",
  " values ((select id from ranking_rulesets where code='TEST-RS-1'),'2026 Q1','kumite|male|cadet|max61000', now(), 1, 1);",
  "insert into ranking_entries (period_id,person_id,rank,points,previous_rank,contributions,state_unit_id,dojo_id)",
  " values ((select id from ranking_periods where label='2026 Q1'),(select id from persons where federation_id='TEST-MEM-0001'),1,1000,3," + j(working) + ",(select id from state_units where code='TEST-ST-JH'),(select id from dojos where code='TEST-DOJO-1'));",
].join('\n');

await sql.unsafe(S);
const rows = await sql.unsafe("select (select count(*)::int from ranking_entries) as entries, (select id from ranking_periods limit 1) as period, (select id from persons where federation_id='TEST-MEM-0001') as person");
console.log(JSON.stringify(rows[0]));
await sql.end();

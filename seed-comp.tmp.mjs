// Local-only fixture for render-checking the competition surface.
// Writes to the scratchpad dev database ONLY. Names are obviously synthetic.
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
try {

const [st] = await sql`insert into state_units (code, state, name, status)
  values ('TEST-ST', 'Testland', 'Test State Unit', 'active') returning id`;
const [dj] = await sql`insert into dojos (code, name, state_unit_id, status)
  values ('TEST-DOJO-1', 'Test Dojo Alpha', ${st.id}, 'active') returning id`;

const people = [];
for (const n of ['Test Competitor One', 'Test Competitor Two', 'Test Competitor Three', 'Test Competitor Four', 'Test Official Five']) {
  const [p] = await sql`insert into persons (federation_id, full_name, state_unit_id, dojo_id, status)
    values (${'TEST-MEM-' + n.replace(/\W/g, '')}, ${n}, ${st.id}, ${dj.id}, 'active') returning id`;
  people.push(p.id);
}

const [ev] = await sql`insert into competition_events
  (code, title, kind, status, starts_on, venue, city, sanctioned_by_person_id, sanctioned_at, sanction_reference, ruleset_version)
  values ('TEST-EVT-0001', 'Test National Championship (fixture)', 'national_championship', 'live',
          '2026-09-12', 'Test Hall', 'Testville', ${people[4]}, now(), 'TEST/SANCTION/1', 'test-rules-1') returning id`;

const [cat] = await sql`insert into event_categories (event_id, code, label, discipline, gender, draw_format, display_order)
  values (${ev.id}, 'TST-KUM', 'Test Senior Male Kumite', 'kumite', 'male', 'single_elimination', 1) returning id`;

const entries = [];
for (let i = 0; i < 4; i++) {
  const [e] = await sql`insert into event_entries (entry_no, event_id, category_id, person_id, dojo_id, state_unit_id, status, seed)
    values (${'TEST-ENT-' + (i + 1)}, ${ev.id}, ${cat.id}, ${people[i]}, ${dj.id}, ${st.id}, 'checked_in', ${i + 1}) returning id`;
  entries.push(e.id);
}

const [dr] = await sql`insert into draws (category_id, format, rounds_count, entry_count, random_seed, algorithm_version, published_at)
  values (${cat.id}, 'single_elimination', 2, 4, 'test-seed', 'mmakf-draw-1', now()) returning id`;

const [final] = await sql`insert into matches (draw_id, category_id, event_id, match_no, round, round_order, mat, status)
  values (${dr.id}, ${cat.id}, ${ev.id}, 'TST-KUM-D1-003', 'F', 2, '1', 'scheduled') returning id`;
await sql`insert into matches (draw_id, category_id, event_id, match_no, round, round_order, mat, status,
  red_entry_id, blue_entry_id, red_score, blue_score, red_penalties, blue_penalties, advances_to_match_id, advances_to_slot, scheduled_at)
  values (${dr.id}, ${cat.id}, ${ev.id}, 'TST-KUM-D1-001', 'SF', 1, '1', 'in_progress',
          ${entries[0]}, ${entries[1]}, 3, 1, ${sql.json({ c1: 1 })}, ${sql.json({})}, ${final.id}, 'red', now())`;
await sql`insert into matches (draw_id, category_id, event_id, match_no, round, round_order, mat, status,
  red_entry_id, blue_entry_id, red_score, blue_score, advances_to_match_id, advances_to_slot, scheduled_at)
  values (${dr.id}, ${cat.id}, ${ev.id}, 'TST-KUM-D1-002', 'SF', 1, '2', 'scheduled',
          ${entries[2]}, ${entries[3]}, 0, 0, ${final.id}, 'blue', now())`;

await sql`insert into event_officials (event_id, person_id, role, mat) values (${ev.id}, ${people[4]}, 'referee', '1')`;

// A finalised category on a second event, to prove the public result filter.
const [ev2] = await sql`insert into competition_events (code, title, kind, status, starts_on, sanction_reference, results_finalised_at)
  values ('TEST-EVT-0002', 'Test Concluded Open (fixture)', 'open_national', 'results_final', '2026-05-02', 'TEST/SANCTION/2', now()) returning id`;
const [cat2] = await sql`insert into event_categories (event_id, code, label, discipline, display_order)
  values (${ev2.id}, 'TST-KATA', 'Test Senior Kata', 'kata', 1) returning id`;
const [e2a] = await sql`insert into event_entries (entry_no, event_id, category_id, person_id, dojo_id, state_unit_id, status)
  values ('TEST-ENT-11', ${ev2.id}, ${cat2.id}, ${people[0]}, ${dj.id}, ${st.id}, 'confirmed') returning id`;
const [e2b] = await sql`insert into event_entries (entry_no, event_id, category_id, person_id, dojo_id, state_unit_id, status)
  values ('TEST-ENT-12', ${ev2.id}, ${cat2.id}, ${people[1]}, ${dj.id}, ${st.id}, 'confirmed') returning id`;
await sql`insert into competition_results (event_id, category_id, entry_id, person_id, "placing", medal, status, finalised_at)
  values (${ev2.id}, ${cat2.id}, ${e2a.id}, ${people[0]}, 1, 'gold', 'final', now())`;
await sql`insert into competition_results (event_id, category_id, entry_id, person_id, "placing", medal, status, finalised_at)
  values (${ev2.id}, ${cat2.id}, ${e2b.id}, ${people[1]}, 2, 'silver', 'provisional', now())`;

// A draft event, which must NEVER appear on a public surface.
await sql`insert into competition_events (code, title, kind, status) values ('TEST-EVT-0003', 'Test Draft (must stay private)', 'seminar', 'draft')`;

console.log(JSON.stringify({ event: ev.id, category: cat.id, event2: ev2.id, draw: dr.id, entries }));
} catch (e) { console.log('SEED ERROR:', e.message, '| position', e.position, '|', String(e.query||'').slice(0,200)); }
await sql.end();

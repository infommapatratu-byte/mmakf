// Scratch seed for the member-surfaces review. Not part of the repo.
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL, { max: 1 });

const one = async (q) => (await q)[0];

// person linked to the ATHLETE account
const person = await one(sql`
  insert into persons (federation_id, full_name, dob, gender, email, phone, city, status)
  values ('MMAKF-MEM-2026-000001', 'Test Member', '1998-04-12', 'female', 'member@mmakf.in', '+91 90000 00000', 'Ranchi', 'active')
  returning *`);

await sql`update users set person_id = ${person.id} where email = 'member@mmakf.in'`;

// a second person, so a foreign passport/enrolment exists to try to reach
const other = await one(sql`
  insert into persons (federation_id, full_name, dob, gender, email, phone, city, status)
  values ('MMAKF-MEM-2026-000002', 'Other Member', '1990-01-01', 'male', 'other@mmakf.in', '+91 90000 00001', 'Patna', 'active')
  returning *`);

await sql`insert into memberships (person_id, category, valid_from, valid_to, status)
          values (${person.id}, 'athlete', '2026-04-01', '2027-03-31', 'active')`;

await sql`insert into rank_records (person_id, kind, grade_label, grade_ordinal, awarded_on, status, syllabus_version)
          values (${person.id}, 'kyu', '5th Kyu', 5, '2026-01-18', 'active', 'MMAKF-SYL-1')`;
await sql`insert into rank_records (person_id, kind, grade_label, grade_ordinal, awarded_on, status)
          values (${person.id}, 'kyu', '6th Kyu', 6, '2025-06-02', 'superseded')`;
await sql`insert into rank_records (person_id, kind, grade_label, grade_ordinal, awarded_on, status, revoked_reason)
          values (${person.id}, 'dan', 'Shodan', 1, '2025-09-09', 'revoked', 'Awarded in error — wrong candidate record.')`;

// ── Academy ────────────────────────────────────────────────────────────────
const channel = await one(sql`
  insert into media_channels (platform, external_id, title, url, authorised)
  values ('youtube', 'UC-mmakf-test', 'MMAKF official', 'https://youtube.com/@mmakf', true) returning *`);

const asset = await one(sql`
  insert into media_assets (channel_id, platform, external_id, url, title, classification, rights, published)
  values (${channel.id}, 'youtube', 'vid-kihon-01', 'https://www.youtube.com/watch?v=vid-kihon-01',
          'Kihon — stance and hikite', 'federation_official', 'cleared', true) returning *`);

const course = await one(sql`
  insert into courses (slug, title, summary, status, has_free_preview, certificate_on_completion, published_at, category, level)
  values ('kihon-foundations', 'Kihon Foundations', 'The foundations of stance, posture and basic technique.',
          'published', true, true, now(), 'shotokan', 'beginner') returning *`);

const mod = await one(sql`
  insert into course_modules (course_id, title, display_order) values (${course.id}, 'Module 1 — Stance', 1) returning *`);

const readingLesson = await one(sql`
  insert into lessons (module_id, course_id, title, kind, body, display_order, is_preview)
  values (${mod.id}, ${course.id}, 'Zenkutsu-dachi', 'reading', 'Front stance. Weight 60/40. Rear leg straight.', 1, true) returning *`);

const videoOk = await one(sql`
  insert into lessons (module_id, course_id, title, kind, media_asset_id, display_order)
  values (${mod.id}, ${course.id}, 'Hikite on video', 'video', ${asset.id}, 2) returning *`);

// a video lesson pointing at NOTHING — must render as unavailable
const videoBroken = await one(sql`
  insert into lessons (module_id, course_id, title, kind, display_order)
  values (${mod.id}, ${course.id}, 'Kicking basics (broken)', 'video', 3) returning *`);

const quizLesson = await one(sql`
  insert into lessons (module_id, course_id, title, kind, display_order)
  values (${mod.id}, ${course.id}, 'Stance theory check', 'quiz', 4) returning *`);

// A quiz WITH an attempt limit of 1, so "attempts exhausted" is reachable.
const quiz = await one(sql`
  insert into quizzes (lesson_id, course_id, title, pass_mark_percent, attempts_allowed)
  values (${quizLesson.id}, ${course.id}, 'Stance theory', 60, 1) returning *`);

await sql`insert into quiz_questions (quiz_id, prompt, kind, options, correct_answer, explanation, marks, display_order)
          values (${quiz.id}, 'Which stance is zenkutsu-dachi?', 'single',
                  ${sql.json([{ id: 'a', text: 'Front stance' }, { id: 'b', text: 'Back stance' }])},
                  ${sql.json('a')}, 'Zenkutsu-dachi is the front stance.', 1, 1)`;
await sql`insert into quiz_questions (quiz_id, prompt, kind, options, correct_answer, explanation, marks, display_order)
          values (${quiz.id}, 'Hikite is the pulling hand.', 'true_false', null,
                  ${sql.json('true')}, 'Yes — the withdrawing hand.', 1, 2)`;

const enrolment = await one(sql`
  insert into enrolments (course_id, person_id, status) values (${course.id}, ${person.id}, 'active') returning *`);

// A fee-bearing published course the member is NOT on — the catalogue path.
await sql`insert into courses (slug, title, summary, status, fee_code, published_at)
          values ('kata-intermediate', 'Kata — intermediate', 'Heian sandan through godan.', 'published', 'ACAD-KATA', now())`;

// ── Live classes ───────────────────────────────────────────────────────────
const bLive = await one(sql`
  insert into broadcasts (channel_id, external_id, status, title, actual_start_at, concurrent_viewers)
  values (${channel.id}, 'live-abc123', 'live', 'Tuesday evening kihon', now(), 34) returning *`);
const bUp = await one(sql`
  insert into broadcasts (channel_id, external_id, status, title, scheduled_start_at)
  values (${channel.id}, 'up-def456', 'upcoming', 'Sunday kata clinic', now() + interval '3 days') returning *`);
const bPriv = await one(sql`
  insert into broadcasts (channel_id, external_id, status, title, actual_start_at)
  values (${channel.id}, 'live-priv99', 'live', 'Selection committee walkthrough', now()) returning *`);

const clsMembers = await one(sql`
  insert into live_classes (code, broadcast_id, title, status, started_at, visibility, published)
  values ('MMAKF-LIVE-2026-000001', ${bLive.id}, 'Tuesday evening kihon', 'live', now(), 'members', true) returning *`);
await sql`insert into live_classes (code, broadcast_id, title, status, scheduled_start_at, visibility, published)
          values ('MMAKF-LIVE-2026-000002', ${bUp.id}, 'Sunday kata clinic', 'upcoming', now() + interval '3 days', 'public', true)`;
await sql`insert into live_classes (code, broadcast_id, title, status, started_at, visibility, published)
          values ('MMAKF-LIVE-2026-000003', ${bPriv.id}, 'Selection committee walkthrough', 'live', now(), 'private', true)`;

// a question asked by the OTHER member — its personId must not reach the wire
await sql`insert into live_class_questions (live_class_id, person_id, question, upvotes, status)
          values (${clsMembers.id}, ${other.id}, 'How deep should the front stance be?', 3, 'open')`;

console.log(JSON.stringify({
  personId: person.id, otherPersonId: other.id, courseId: course.id, enrolmentId: enrolment.id,
  quizId: quiz.id, readingLesson: readingLesson.id, videoOk: videoOk.id, videoBroken: videoBroken.id,
  liveMembersClassId: clsMembers.id,
}, null, 2));

await sql.end();

import postgres from 'postgres';
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
for (const t of ['live_class_questions','live_class_attendance','live_classes','broadcasts','quiz_attempts','quiz_questions','quizzes','lesson_progress','enrolments','lessons','course_modules','courses','media_assets','media_channels','rank_records','memberships']) {
  await sql.unsafe(`delete from ${t}`);
}
await sql`update users set person_id = null`;
await sql`delete from persons`;
console.log('cleaned');
await sql.end();

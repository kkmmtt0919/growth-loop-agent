import { getPool } from "./pool";
import type { DbQuizSession } from "./types";

export async function createQuizSession(input: {
  userId: string;
  recordId?: string | null;
  topic: string;
  sourceSummary: string;
  questions: unknown;
  mode: string;
}): Promise<DbQuizSession> {
  const { rows } = await getPool().query<DbQuizSession>(
    `insert into public.quiz_sessions (user_id, record_id, topic, source_summary, questions, mode)
     values ($1, $2, $3, $4, $5, $6)
     returning *`,
    [
      input.userId,
      input.recordId ?? null,
      input.topic,
      input.sourceSummary,
      JSON.stringify(input.questions),
      input.mode,
    ],
  );
  return rows[0];
}

export async function gradeQuizSession(
  userId: string,
  quizId: string,
  input: {
    answers: unknown;
    score: number;
    level: string;
    gradedBy: "llm" | "rules";
  },
): Promise<DbQuizSession | null> {
  const { rows } = await getPool().query<DbQuizSession>(
    `update public.quiz_sessions set
       answers = $3,
       score = $4,
       level = $5,
       graded_by = $6,
       graded_at = now()
     where id = $1 and user_id = $2
     returning *`,
    [quizId, userId, JSON.stringify(input.answers), input.score, input.level, input.gradedBy],
  );
  return rows[0] ?? null;
}

export async function getQuizSession(userId: string, quizId: string): Promise<DbQuizSession | null> {
  const { rows } = await getPool().query<DbQuizSession>(
    `select * from public.quiz_sessions where id = $1 and user_id = $2 limit 1`,
    [quizId, userId],
  );
  return rows[0] ?? null;
}

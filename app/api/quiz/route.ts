import { NextResponse } from "next/server";
import { generateLearningQuiz, gradeLearningQuiz, type GeneratedQuiz, type QuizQuestion } from "@/lib/agent/quiz";
import { authenticate, AuthError } from "@/lib/auth/middleware";
import { createQuizSession, gradeQuizSession } from "@/lib/repo/quiz";
import { rewardQuiz } from "@/lib/service/workspace";
import { ServiceError } from "@/lib/service/errors";
import { isDatabaseConfigured } from "@/lib/repo/pool";

export const runtime = "nodejs";

function errorResponse(error: string, status = 400) {
  return NextResponse.json({ error }, { status, headers: { "Cache-Control": "no-store" } });
}

function stringField(input: Record<string, unknown>, key: string, required = false) {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  if (required && !trimmed) throw new Error(`${key} is required`);
  return trimmed;
}

function parseQuestions(value: unknown): QuizQuestion[] {
  if (!Array.isArray(value) || value.length < 2) throw new Error("questions must contain at least 2 items");
  return value.slice(0, 3).map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid question");
    const question = item as Record<string, unknown>;
    if (typeof question.id !== "string" || typeof question.prompt !== "string") throw new Error("invalid question");
    return {
      id: question.id.trim(),
      prompt: question.prompt.trim(),
      hint: typeof question.hint === "string" ? question.hint.trim() : "直接回答，并尽量给一个例子。",
      rubric: typeof question.rubric === "string" ? question.rubric.trim() : "准确理解；能够迁移应用",
    } satisfies QuizQuestion;
  });
}

function reconstructQuiz(input: Record<string, unknown>, questions: QuizQuestion[]): GeneratedQuiz {
  const topic = typeof input.topic === "string" && input.topic.trim() ? input.topic.trim() : "这次学习内容";
  const sourceSummary = typeof input.source === "string" ? input.source.trim() : "";
  const quizId = typeof input.quizId === "string" && input.quizId.trim() ? input.quizId.trim() : `quiz-${Date.now()}`;
  return {
    quizId,
    topic,
    sourceSummary,
    questions,
    internalQuestions: questions.map((question) => ({
      ...question,
      keywords: [topic, ...sourceSummary.split(/\s+/).filter((word) => word.length >= 2).slice(0, 5)],
    })),
    mode: "demo",
    provider: "rules",
  };
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("invalid JSON body");
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) return errorResponse("request body must be an object");
  const input = body as Record<string, unknown>;
  const action = input.action;
  if (action !== "generate" && action !== "grade") return errorResponse("action must be generate or grade");

  try {
    if (action === "generate") {
      const content = stringField(input, "content", true)!;
      const topic = stringField(input, "topic");
      const output = stringField(input, "output");
      const quiz = await generateLearningQuiz(content, topic, output);

      // 数据库模式：测验会话入库（关联来源记录），返回数据库 quizId
      if (isDatabaseConfigured) {
        const { userId } = await authenticate(request);
        const recordId = typeof input.recordId === "string" && input.recordId.trim()
          ? input.recordId.trim()
          : null;
        const session = await createQuizSession({
          userId,
          recordId,
          topic: quiz.topic,
          sourceSummary: quiz.sourceSummary,
          questions: quiz.questions,
          mode: quiz.mode,
        });
        return NextResponse.json({
          quizId: session.id,
          topic: session.topic,
          sourceSummary: session.source_summary,
          questions: quiz.questions,
          mode: quiz.mode,
          provider: quiz.provider,
        }, { headers: { "Cache-Control": "no-store" } });
      }

      return NextResponse.json({
        quizId: quiz.quizId,
        topic: quiz.topic,
        sourceSummary: quiz.sourceSummary,
        questions: quiz.questions,
        mode: quiz.mode,
        provider: quiz.provider,
      }, { headers: { "Cache-Control": "no-store" } });
    }

    const topic = stringField(input, "topic", true)!;
    const source = stringField(input, "source", true)!;
    const questions = parseQuestions(input.questions);
    if (!input.answers || typeof input.answers !== "object" || Array.isArray(input.answers)) throw new Error("answers must be an object");
    const answers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.answers as Record<string, unknown>)) {
      if (typeof value !== "string") throw new Error("answers must contain strings");
      answers[key] = value.trim().slice(0, 1_000);
    }
    const quiz = reconstructQuiz({ quizId: input.quizId, topic, source }, questions);
    const result = await gradeLearningQuiz(quiz, answers);

    // 数据库模式：回写评分 + 发放测验 bonus（幂等，key 关联 quizId）
    if (isDatabaseConfigured) {
      const { userId } = await authenticate(request);
      const quizId = typeof input.quizId === "string" ? input.quizId.trim() : null;
      if (quizId) {
        const updated = await gradeQuizSession(userId, quizId, {
          answers,
          score: result.score,
          level: result.level,
          gradedBy: result.gradedBy === "llm" ? "llm" : "rules",
        });
        if (updated) {
          await rewardQuiz(userId, updated.id, updated.topic, result.score);
        }
      }
    }

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof AuthError) return errorResponse(error.message, error.status);
    if (error instanceof ServiceError) return errorResponse(error.message, error.status);
    return errorResponse(error instanceof Error ? error.message : "invalid quiz request");
  }
}

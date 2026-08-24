import { getPool } from "./pool";
import type { DbProfile } from "./types";

/** 邮箱已注册（PG unique violation code） */
export const PG_UNIQUE_VIOLATION = "23505";

export type NewUserInput = {
  email: string;
  passwordHash: string;
  displayName?: string;
};

export async function createUser(input: NewUserInput): Promise<DbProfile> {
  const { rows } = await getPool().query<DbProfile>(
    `insert into public.profiles (email, password_hash, display_name)
     values ($1, $2, $3)
     returning *`,
    [input.email.toLowerCase().trim(), input.passwordHash, input.displayName?.trim() || ""],
  );
  return rows[0];
}

export async function findByEmail(email: string): Promise<DbProfile | null> {
  const { rows } = await getPool().query<DbProfile>(
    `select * from public.profiles where lower(email) = lower($1) limit 1`,
    [email.trim()],
  );
  return rows[0] ?? null;
}

export async function findById(id: string): Promise<DbProfile | null> {
  const { rows } = await getPool().query<DbProfile>(
    `select * from public.profiles where id = $1 limit 1`,
    [id],
  );
  return rows[0] ?? null;
}

/** 全部用户 id（Phase 3 晚报调度：遍历生成，幂等跳过已生成的） */
export async function listUserIds(): Promise<string[]> {
  const { rows } = await getPool().query<{ id: string }>(`select id from public.profiles order by created_at asc`);
  return rows.map((r) => r.id);
}

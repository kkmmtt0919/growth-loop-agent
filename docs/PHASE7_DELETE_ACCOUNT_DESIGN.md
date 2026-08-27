# Phase 7「数据删除」实施设计

> 范围：0.3.0 MVP 收尾阶段 · 配套 `docs/ROADMAP_0.3.0.md`
> 定稿日期：2026-08-27
> 路线定义：`DELETE /user（级联删业务数据）；导出推迟`

---

## 1. 范围边界（最终收敛）

| 维度 | 本期（Phase 7） |
|---|---|
| 后端 | **完整实现**：`DELETE /api/auth/delete` + `profiles` 硬删除 |
| 桌面端 | **完整实现**：profile-chip 内删除入口 + 确认弹层 |
| 移动端 | **不做删除入口**；账号区保持现状（demo 数据） |
| 导出 | **不做**（路线明确推迟） |
| 软删除/回收站 | **不做**（MVP 硬删除最小版） |
| JWT 黑名单 | **不做**（沿用现有机制，见 §6） |
| 移动端账号体系真实化 | **不属于 Phase 7**，后续单独阶段 |

---

## 2. 现状盘点（基于真实代码）

| 事实 | 结论 |
|---|---|
| 用户表是 `public.profiles`（自建邮箱/密码，**不依赖 `auth.users`**） | 删账号 = `DELETE profiles` 一行，无需碰 Supabase Auth |
| 7 张业务表 `user_id → profiles(id) ON DELETE CASCADE` | **级联删除已在 schema 就绪，零 migration** |
| 无通用 sheet/overlay 组件 | 现有 `quiz-overlay`、`app-mobile-v3-sheet` 均为专用硬编码；本设计**采用其视觉规范，新建轻量确认弹层结构** |
| 桌面 `logout()` 已存在 | `page.tsx:467` → `removeItem(AUTH_TOKEN_KEY)` + `location.reload()`，删除成功后直接复用 |
| 前端 `demoSeed.user` **无 email 字段** | `mapProfileToSeedUser`（`lib/service/seed.ts:50`）只映射 displayName/level/role/streak/xp/coin；确认弹层需要邮箱来源（见 §5 D1） |
| `authMode` 有 `loading/demo/login/ready` 四态 | 删除入口**仅在 `ready` 态渲染** |

---

## 3. 后端设计

### 3.1 Repo 层（`lib/repo/users.ts` 追加）

```ts
/** 删除账号（级联删业务数据）。返回 true=删除成功，false=用户不存在 */
export async function deleteUser(id: string): Promise<boolean> {
  const { rowCount } = await getPool().query(
    `delete from public.profiles where id = $1`,
    [id],
  );
  return rowCount === 1;
}
```

依赖既有 `ON DELETE CASCADE`，一条 DELETE 即清空 goals / tasks / records / ledger_entries / quiz_sessions / evening_reports / weekly_reports。

### 3.2 Service 层（`lib/service/auth.ts` 追加）

```ts
export async function deleteAccount(userId: string): Promise<void> {
  const deleted = await deleteUser(userId);
  if (!deleted) throw new ServiceError("用户不存在", 404);
}
```

### 3.3 API 层（新增 `app/api/auth/delete/route.ts`）

- `DELETE /api/auth/delete`
- 入口调用 `authenticate(request)` → `{ userId }`
- 调 `deleteAccount(userId)` → 返回 `{ deleted: true }`
- 错误处理对齐 `/api/auth/me`：`AuthError` → 其 status，`ServiceError` → 其 status，其它 → 500

```ts
export const runtime = "nodejs";

export async function DELETE(request: Request) {
  try {
    const { userId } = await authenticate(request);
    await deleteAccount(userId);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof AuthError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof ServiceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("[api/auth/delete]", error);
    return NextResponse.json({ error: "服务不可用" }, { status: 500 });
  }
}
```

---

## 4. 前端设计（桌面端）

### 4.1 入口

`page.tsx` 桌面 `profile-chip`（969-972 行）内，`LogOut` 按钮旁新增「删除账号」按钮：

```tsx
{authMode === "ready" && (
  <>
    <button className="profile-logout" onClick={logout} aria-label="退出登录" title="退出登录">
      <LogOut size={15} />
    </button>
    <button className="profile-delete" onClick={() => setDeleteAccountOpen(true)} aria-label="删除账号" title="删除账号">
      <Trash2 size={15} />
    </button>
  </>
)}
```

### 4.2 状态变量（新增）

```ts
const [deleteAccountOpen, setDeleteAccountOpen] = useState(false);
const [deleteConfirmEmail, setDeleteConfirmEmail] = useState("");
const [deleteBusy, setDeleteBusy] = useState(false);
const [deleteError, setDeleteError] = useState("");
```

### 4.3 确认弹层（新建轻量结构，复用 overlay 视觉规范）

结构对齐现有 `quiz-overlay` 模式（`role="dialog"` + `aria-modal="true"` + backdrop 点击关闭）：

```
<div className="delete-account-overlay" role="dialog" aria-modal="true">
  <button className="delete-account-backdrop" onClick={close} aria-label="取消删除" />
  <div className="delete-account-dialog">
    标题：删除账号
    文案：此操作会永久删除你的账号和所有成长数据（目标/任务/记录/账本/报告），不可恢复。
    输入框：placeholder="输入你的邮箱确认"  value={deleteConfirmEmail}
    错误提示：{deleteError}
    按钮区：
      [取消]  → setDeleteAccountOpen(false)
      [永久删除账号] → disabled={deleteBusy || deleteConfirmEmail !== currentEmail} → onConfirmDelete
  </div>
</div>
```

### 4.4 删除确认逻辑

```ts
async function confirmDeleteAccount() {
  setDeleteBusy(true);
  setDeleteError("");
  try {
    const res = await fetch("/api/auth/delete", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${authToken}` },
    });
    const payload = (await res.json()) as { deleted?: boolean; error?: string };
    if (!res.ok || !payload.deleted) {
      setDeleteError(payload.error || "删除失败，请重试");
      return;
    }
    logout(); // removeItem(AUTH_TOKEN_KEY) + location.reload()
  } catch {
    setDeleteError("网络异常，请稍后重试");
  } finally {
    setDeleteBusy(false);
  }
}
```

按钮状态机：默认 disabled → 输入邮箱 === 当前用户邮箱后 enabled → 请求期间 loading → 成功后 `logout()` 清 token + reload。

---

## 5. 关键决策（已定稿）

| # | 决策 | 结论 |
|---|---|---|
| D1 | 确认方式 | 输入邮箱确认（防误触、合规）；**前端邮箱来源**见下方数据契约 |
| D2 | 前端入口 | 桌面 profile-chip 加「删除账号」；移动端本期不做 |
| D3 | 导出 | 不做 |
| D4 | 邮箱复用 | 删行后 `idx_profiles_email_lower` 唯一约束随行消失，邮箱可重新注册（真删除，合理） |
| D5 | 硬删除 | 确认硬删除 |

### D1 数据契约（已定稿：方案乙）

前端当前拿不到「当前用户邮箱」（`demoSeed.user` 无 email）。**定稿采用方案乙**：删除弹层打开时调 `GET /api/auth/me` 拿 `profile.email`（`toPublicProfile` 已返回 email），用返回值比对。

- **数据源权威**：`profiles.email` 是数据库真实数据，不依赖浏览器缓存，避免「修改邮箱后 localStorage 残留旧值」。
- **零后端新增**：`/api/auth/me` 已存在，`toPublicProfile` 已含 email。
- **安全边界**：email 仅作 UX 防误触比对，不参与权限判断；真正身份校验仍在后端 `authenticate`（以 JWT userId 为准）。
- **`/api/auth/me` 失败**：不允许继续删除，提示重新登录。

---

## 6. 安全与边界

- **多用户隔离**：`DELETE FROM profiles WHERE id = $1`，id 来自 `authenticate` 验证后的 JWT，只能删自己。
- **幂等**：重复 DELETE → `rowCount === 0` → 404（用户已不存在）；前端删完即清 token，不会重复调。
- **JWT 无黑名单**：删号后旧 JWT 未过期理论上仍能通过 `authenticate`（它只验签名/有效期、不查库），但下游 `findById` 查无此人 → 业务 **404**（`ServiceError("用户不存在", 404)`）。MVP 可接受，不建 session 黑名单表。**注意**：删号后 `GET /api/auth/me` 返回的是 **404**（非 401）——JWT 签名仍有效，但用户行已删。
- **不碰红线**：纯标准 PG DELETE，无 Supabase 专属能力。
- **越权防护**：无 `user_id` 输入，不存在「删别人」路径。

---

## 7. 改动文件清单

| 文件 | 改动 |
|---|---|
| `lib/repo/users.ts` | 追加 `deleteUser(id)` |
| `lib/service/auth.ts` | 追加 `deleteAccount(userId)` |
| `app/api/auth/delete/route.ts` | **新增** `DELETE` 路由 |
| `app/page.tsx` | 桌面 profile-chip 加删除按钮 + 弹层 + 3 个 state + `confirmDeleteAccount` + （若方案乙）打开弹层时取 email |
| `app/globals.css` 或对应样式 | 新增 `delete-account-overlay/dialog/backdrop` 样式（复用现有 overlay 视觉规范） |
| `scripts/smoke-delete.mjs` | **新增** 回归脚本 |

**无 migration**（依赖现有 FK cascade）。

---

## 8. 验证方案

### 8.1 自动化（`scripts/smoke-delete.mjs`）

1. 注册用户 A / B → 各拿 token
2. A / B 各造一条目标（`POST /api/goals`，走真实 API）
3. `GET /api/auth/me` 断言返回权威邮箱 `profile.email === 注册邮箱`
4. B `DELETE /api/auth/delete` → 断言 `{ deleted: true }`
5. B 删后：`me` → **404**（JWT 仍有效但用户已删）；`login` → 401；同邮箱重新 `register` → 200（邮箱复用，验证 profiles 行已真删、唯一约束随行释放）
6. 隔离：B 删自己不影响 A（A 的 `me` 仍 200、A 的目标仍在）
7. A `DELETE` → `{ deleted: true }` → `me` 404
8. 未鉴权 `DELETE` → 401

> 级联清理本身由 schema 层 `ON DELETE CASCADE` 保证（无需脚本直连 PG 断言）；脚本通过「邮箱复用注册成功」间接验证 profiles 行已真删。

### 8.2 回归

- `e2e-closed-loop` 确认删号不影响其它用户
- typecheck / lint / build 全绿

---

## 9. 定稿确认（已全部收敛）

- [x] **D1 数据契约**：方案乙（弹层打开时 `GET /api/auth/me` 取 email 比对）
- [x] 删除按钮图标 `Trash2` + 文案「删除账号」
- [x] 移动端本期不做删除入口，账号区保持 demo 现状

## 10. 实现状态（2026-08-27）

- 后端：`lib/repo/users.ts`（`deleteUser`）、`lib/service/auth.ts`（`deleteAccount`）、`app/api/auth/delete/route.ts`（`DELETE`）—— 已实现
- 前端：`app/page.tsx`（Trash2 导入 + 5 个 state + `openDeleteAccount`/`confirmDeleteAccount` + profile-chip 删除按钮 + 确认弹层）、`app/globals.css`（`.profile-actions` + 删除面板样式）—— 已实现
- 验证：`scripts/smoke-delete.mjs` 全通过（8 组断言 0 失败）；typecheck / lint / build 全绿，路由表含 `/api/auth/delete`

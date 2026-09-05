# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

# 依赖先拷（层缓存）：package.json + lockfile
COPY package.json package-lock.json ./
RUN npm ci

# 全量源码
COPY . .

# next.config 保持默认（非 standalone）；构建产物含 .next + node_modules 即够
# NODE_OPTIONS= 规避本机已知的 build 兼容问题（NODE_OPTIONS 空避免传参）
ENV NODE_OPTIONS=
RUN npm run build

# ---- runner stage ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NODE_OPTIONS=

# 仅拷贝运行所需：产物 + 依赖 + 公共资源 + 迁移目录
COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.mjs ./next.config.mjs
COPY --from=builder /app/instrumentation.ts ./instrumentation.ts
COPY --from=builder /app/supabase ./supabase
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/.env.example ./.env.example

# 数据库迁移（宿主/CI 显式执行，见 README 部署节）：容器内也保留以便 npm run db:setup
EXPOSE 3000
CMD ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"]

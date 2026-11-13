# MediBook HMS

MVP hospital management system. Read [CLAUDE.md](CLAUDE.md) and [docs/mvp-structure.md](docs/mvp-structure.md) first.

```bash
cp .env.example .env        # then edit secrets
docker compose up -d        # PostgreSQL 16 + Redis 7
npm install
npm run db:migrate
npm run db:seed
npm run dev                 # API http://localhost:4000/api/health · web http://localhost:5173
```

Components demo: http://localhost:5173/demo/components · Tests: `npm test`

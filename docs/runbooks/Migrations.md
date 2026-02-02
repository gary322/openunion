# Migrations runbook

### Goals
- **Exactly-once** application of SQL migrations in `db/migrations/`.
- Avoid concurrent migration runners across multiple ECS tasks.

### How migrations work
- The app runs migrations on startup in `src/server.ts` (onReady).
- Workers also run migrations on startup.
- `src/db/migrate.ts` uses a `schema_migrations` table to track applied filenames and applies migrations in sorted filename order.

### Recommended production procedure
- **Preferred**: run the dedicated ECS migration task once per deploy.
  - Use the Terraform output `migrate_task_definition_arn`.
  - Run it as a one-off task before updating API/worker services.
- **Fallback**: allow API boot to run migrations if your deploy pipeline cannot run the migrate task, but ensure:
  - only one API task starts initially (desired count = 1)
  - other services are held until migrations complete.

### Failure handling
- If a migration fails, the transaction rolls back and the filename is **not** recorded.
- Fix the migration and re-run the migrate task.


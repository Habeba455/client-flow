// Values must match the todo_status / todo_priority enums in the database.
export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'archived'] as const;
export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const PROJECT_STATUSES = ['active', 'archived'] as const;

import { z } from "zod";
import { stateSchema, type AppState } from "../core/model";

const fields = stateSchema.shape;
const id = z.string().min(1).max(128);
function changes<T extends z.ZodType>(row: T) {
  return z.strictObject({
    put: z.array(row).max(10000),
    remove: z.array(id).max(10000),
  });
}

export const deltaSchema = z.strictObject({
  removeGoalsWithTasks: z.array(id).max(100).optional(),
  tasks: changes(fields.tasks.element).optional(),
  goals: changes(fields.goals.element).optional(),
  blocks: changes(fields.blocks.element).optional(),
  reviews: changes(fields.reviews.element).optional(),
  events: z.array(fields.events.element).max(10000).optional(),
  executionLog: z
    .array(fields.executionLog.unwrap().element)
    .max(10000)
    .optional(),
  settings: fields.settings.optional(),
  session: fields.session.optional(),
  availability: fields.availability,
  fixedTimes: fields.fixedTimes,
});
export type WorkspaceDelta = z.infer<typeof deltaSchema>;
export const deltaEnvelope = z.strictObject({
  revision: z.number().int().nonnegative(),
  mutationId: z.uuid(),
  changes: deltaSchema,
});
export type DeltaRequest = z.infer<typeof deltaEnvelope>;

function different(a: unknown, b: unknown) {
  return JSON.stringify(a) !== JSON.stringify(b);
}
function keyed<T>(before: T[], after: T[], key: (row: T) => string) {
  const previous = new Map(before.map((row) => [key(row), row]));
  const next = new Set(after.map(key));
  const put = after.filter((row) => different(previous.get(key(row)), row));
  const remove = before.filter((row) => !next.has(key(row))).map(key);
  return put.length || remove.length ? { put, remove } : undefined;
}
function appended<T extends { id: string }>(before: T[], after: T[]) {
  if (
    after.length < before.length ||
    before.some((row, index) => different(row, after[index]))
  )
    throw new Error("执行历史已发生变化，请重新同步。");
  return after.length > before.length ? after.slice(before.length) : undefined;
}

export function workspaceDelta(
  before: AppState,
  after: AppState,
): WorkspaceDelta {
  return {
    tasks: keyed(before.tasks, after.tasks, (row) => row.id),
    goals: keyed(before.goals, after.goals, (row) => row.id),
    blocks: keyed(before.blocks, after.blocks, (row) => row.taskId),
    reviews: keyed(before.reviews, after.reviews, (row) => row.date),
    events: appended(before.events, after.events),
    executionLog: appended(before.executionLog ?? [], after.executionLog ?? []),
    settings: different(before.settings, after.settings)
      ? after.settings
      : undefined,
    session: different(before.session, after.session)
      ? after.session
      : undefined,
    availability: different(before.availability, after.availability)
      ? (after.availability ?? [])
      : undefined,
    fixedTimes: different(before.fixedTimes, after.fixedTimes)
      ? (after.fixedTimes ?? [])
      : undefined,
  };
}

export function mergeWorkspaceDelta(
  state: AppState,
  delta: WorkspaceDelta,
): AppState {
  function merge<T>(
    before: T[],
    edits: { put: T[]; remove: string[] } | undefined,
    key: (row: T) => string,
  ) {
    if (!edits) return before;
    const result = new Map(before.map((row) => [key(row), row]));
    edits.remove.forEach((id) => result.delete(id));
    edits.put.forEach((row) => result.set(key(row), row));
    return [...result.values()];
  }
  return {
    ...state,
    tasks: merge(state.tasks, delta.tasks, (row) => row.id),
    goals: merge(state.goals, delta.goals, (row) => row.id),
    blocks: merge(state.blocks, delta.blocks, (row) => row.taskId),
    reviews: merge(state.reviews, delta.reviews, (row) => row.date),
    events: [...state.events, ...(delta.events ?? [])],
    executionLog: [
      ...(state.executionLog ?? []),
      ...(delta.executionLog ?? []),
    ],
    settings: delta.settings ?? state.settings,
    session: delta.session === undefined ? state.session : delta.session,
    availability: delta.availability ?? state.availability,
    fixedTimes: delta.fixedTimes ?? state.fixedTimes,
  };
}

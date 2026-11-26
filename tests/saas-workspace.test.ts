import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { seedState, type AppState } from "../src/modules/core/model";
import {
  workspaceDelta,
  mergeWorkspaceDelta,
} from "../src/modules/cloud/delta";
import { validateWorkspace } from "../src/modules/cloud/validation";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const day = "2026-11-19";
const path = "supabase/migrations";
let database: PGlite;
async function actor(id: string) {
  await database.exec("reset role; set role authenticated;");
  await database.query("select set_config('request.jwt.claim.sub',$1,false)", [
    id,
  ]);
}
async function call<T = any>(sql: string, args: unknown[] = []) {
  return (await database.query<{ value: T }>(`select ${sql} as value`, args))
    .rows[0].value;
}
function patch(revision: number, changes: unknown, id = crypto.randomUUID()) {
  return call("public.flowday_apply_delta($1,$2,$3::jsonb)", [
    revision,
    id,
    JSON.stringify(changes),
  ]);
}
beforeAll(async () => {
  database = new PGlite();
  await database.exec(`create role anon nologin; create role authenticated nologin; create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,public to anon, authenticated;
    insert into auth.users values('${a}'),('${b}');`);
  const files = readdirSync(path).sort();
  for (const pathName of files.slice(0, 3))
    await database.exec(readFileSync(`${path}/${pathName}`, "utf8"));
  await actor(a);
  await call("public.flowday_load()");
  const seed = seedState();
  seed.settings.growth = {
    personalize: true,
    shareWithAi: false,
    preferred: "any",
  };
  seed.tasks[0].execution = { kind: "project" };
  seed.tasks[1].status = "done";
  seed.tasks[1].completedAt = "2024-01-01T09:00:00Z";
  seed.executionLog = [
    {
      id: "legacy-1",
      taskId: "t1",
      title: "旧任务",
      at: "2024-01-01T09:00:00Z",
      type: "start",
    },
  ];
  seed.reviews = [{ date: "2024-01-01", text: "旧复盘", mood: 2 }];
  await call("public.flowday_save($1::jsonb,0,$2,false)", [
    JSON.stringify(seed),
    crypto.randomUUID(),
  ]);
  await database.exec("reset role");
  for (const pathName of files.slice(3))
    await database.exec(readFileSync(`${path}/${pathName}`, "utf8"));
  await actor(a);
}, 30000);
afterAll(async () => {
  await database?.close();
});

it("computes a minimal change set without rewriting history", () => {
  const before = seedState(),
    after = structuredClone(before);
  after.tasks[0].title = "修改后的任务";
  const changes = workspaceDelta(before, after);
  expect(changes.tasks?.put).toEqual([after.tasks[0]]);
  expect(changes.events).toBeUndefined();
  expect(mergeWorkspaceDelta(before, changes).tasks).toEqual(after.tasks);
});
describe("V1.5 migrations and SaaS isolation", () => {
  it("preserves existing V1.3 history while returning a bounded workspace", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const core = validateWorkspace(
      await call("public.flowday_bootstrap($1::date)", [today]),
    );
    expect(core.tasks.some((t) => t.id === "t2")).toBe(false);
    expect(core.reviews).toHaveLength(0);
    expect(core.executionLog).toHaveLength(0);
    expect(core.tasks[0].execution?.kind).toBe("project");
    const owned = await call("public.flowday_export()");
    expect(owned.executionLog).toHaveLength(1);
    expect(owned.tasks).toHaveLength(4);
    expect(owned.reviews).toHaveLength(1);
    expect(await call("public.flowday_totals()")).toEqual({
      completed: 1,
      focusMinutes: 0,
      reviews: 1,
    });
    const page = await call("public.flowday_history('execution',25)");
    expect(page[0].entry.id).toBe("legacy-1");
    expect(
      (await call("public.flowday_growth_report($1,7,'UTC')", [today])).current,
    ).toMatchObject({ samples: 0 });
  });
  it("writes touched rows atomically and makes a retry idempotent across newer writes", async () => {
    const before = await call<AppState>("public.flowday_export()");
    const target = { ...before.tasks[0], title: "新版任务" };
    const id = crypto.randomUUID();
    const diff = { tasks: { put: [target], remove: [] } };
    expect(await patch(before.revision, diff, id)).toMatchObject({
      revision: before.revision + 1,
    });
    const newer = await patch(before.revision + 1, {
      settings: { ...before.settings, aiEnabled: false, bufferPercent: 35 },
    });
    expect(await patch(before.revision, diff, id)).toEqual({
      savedRevision: before.revision + 1,
      revision: newer.revision,
    });
    await expect(
      patch(before.revision, {
        tasks: { put: [{ ...target, title: "覆盖" }], remove: [] },
      }),
    ).rejects.toThrow(/REVISION_CONFLICT/);
    await expect(
      patch(newer.revision, {
        tasks: {
          put: [{ ...target, execution: { dependencies: [target.id] } }],
          remove: [],
        },
      }),
    ).rejects.toThrow(/CYCLE/);
    const result = await call<AppState>("public.flowday_export()");
    expect(result.settings.bufferPercent).toBe(35);
    expect(result.tasks[0].title).toBe(target.title);
    expect(result.executionLog).toHaveLength(1);
    expect(result.reviews).toHaveLength(1);
    await expect(
      call("public.flowday_ai_reserve($1,'mock','model')", ["6".repeat(64)]),
    ).rejects.toThrow(/AI_DISABLED/);
  });
  it("round-trips cross-day segments, rejects overlap, and edits or removes only the selected segment", async () => {
    const before = await call<AppState>("public.flowday_export()");
    const taskId = before.tasks.find((task) => task.status === "todo")!.id;
    const first = {
      id: "seg-1",
      taskId,
      date: day,
      start: 540,
      end: 600,
      locked: false,
    };
    const second = {
      ...first,
      id: "seg-2",
      date: "2026-11-20",
      start: 840,
      end: 900,
    };
    const added = await patch(before.revision, {
      blocks: { put: [first, second], remove: [] },
    });
    const read = () => call<AppState>("public.flowday_export()");
    expect(validateWorkspace(await read()).blocks).toEqual(
      expect.arrayContaining([first, second]),
    );
    await expect(
      patch(added.revision, {
        blocks: { put: [{ ...second, date: day, start: 570 }], remove: [] },
      }),
    ).rejects.toThrow(/SCHEDULE_CONFLICT/);
    const edited = await patch(added.revision, {
      blocks: { put: [{ ...second, start: 900, end: 960 }], remove: [] },
    });
    expect((await read()).blocks).toContainEqual(first);
    await patch(edited.revision, { blocks: { put: [], remove: [first.id] } });
    expect((await read()).blocks).not.toContainEqual(first);
    expect((await read()).blocks).toContainEqual({
      ...second,
      start: 900,
      end: 960,
    });
    expect((await read()).tasks.some((task) => task.id === taskId)).toBe(true);
  });
  it("isolates paged data, enforces server entitlements and clears only the current workspace", async () => {
    await actor(b);
    const today = new Date().toISOString().slice(0, 10);
    await call("public.flowday_bootstrap($1)", [today]);
    expect(await call("public.flowday_history('reviews',25)")).toEqual([]);
    expect(await call("public.flowday_access()")).toMatchObject({
      plan: "free",
      aiPerDay: 60,
    });
    const source = seedState();
    source.executionLog = [
      {
        id: "import-entry",
        taskId: "t1",
        title: "本地记录",
        at: new Date().toISOString(),
        type: "start",
      },
    ];
    const imported = await call("public.flowday_import_v15($1::jsonb,0,$2)", [
      JSON.stringify(source),
      crypto.randomUUID(),
    ]);
    expect(imported.state.executionLog).toHaveLength(1);
    await database.exec(
      "reset role; update public.plan_policies set advanced_growth=false,personalization=false where id='free';",
    );
    await actor(b);
    await expect(
      call("public.flowday_growth_report($1,30,'UTC')", [today]),
    ).rejects.toThrow(/ADVANCED_GROWTH_REQUIRED/);
    await expect(
      patch(imported.state.revision, {
        settings: {
          ...imported.state.settings,
          growth: { personalize: true, shareWithAi: false, preferred: "any" },
        },
      }),
    ).rejects.toThrow(/PERSONALIZATION_REQUIRED/);
    await call("public.flowday_clear($1)", [imported.state.revision]);
    expect((await call("public.flowday_export()")).tasks).toEqual([]);
    expect(await call("public.flowday_totals()")).toEqual({
      completed: 0,
      focusMinutes: 0,
      reviews: 0,
    });
    await actor(a);
    expect((await call("public.flowday_export()")).tasks).toHaveLength(4);
  });

  it("paginates tied historical timestamps without dropping or duplicating rows", async () => {
    const base = await call<AppState>("public.flowday_export()");
    await patch(base.revision, {
      executionLog: Array.from({ length: 27 }, (_, i) => ({
        id: `page-${String(i).padStart(2, "0")}`,
        taskId: "t1",
        title: "页内记录",
        at: "2024-01-02T05:00:00Z",
        type: "pause",
      })),
    });
    const first = await call("public.flowday_history('execution',25)");
    expect(first).toHaveLength(26);
    const cursor = first[24];
    const second = await call("public.flowday_history('execution',25,$1,$2)", [
      cursor.at,
      cursor.id,
    ]);
    expect(second).toHaveLength(3);
    expect(
      new Set([...first.slice(0, 25), ...second].map((row) => row.id)).size,
    ).toBe(28);
  });

  it("cascades account deletion across history, memberships and aggregate rows", async () => {
    await database.exec(
      `reset role; insert into public.account_plans values('${a}','pro');`,
    );
    await actor(a);
    expect(await call("public.flowday_access()")).toMatchObject({
      plan: "pro",
      aiPerDay: 120,
    });
    await database.exec(`reset role; delete from auth.users where id='${a}';`);
    for (const table of [
      "profiles",
      "tasks",
      "execution_history",
      "workspace_mutations",
      "account_plans",
      "account_totals",
    ]) {
      const rows = await database.query(
        `select user_id from public.${table} where user_id=$1`,
        [a],
      );
      expect(rows.rows).toHaveLength(0);
    }
  });
});

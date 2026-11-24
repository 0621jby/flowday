import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { seedState, type AppState } from "../src/modules/core/model";
import {
  canonicalWorkspace,
  validateWorkspace,
} from "../src/modules/cloud/validation";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let db: PGlite;
async function actor(id: string, role = "authenticated") {
  await db.exec(`reset role; set role ${role};`);
  await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id]);
}
async function load() {
  return (
    await db.query<{ state: AppState }>("select public.flowday_load() as state")
  ).rows[0].state;
}
async function save(
  state: AppState,
  options: { expected?: number; mutation?: string; importing?: boolean } = {},
) {
  return (
    await db.query<{
      result: { state: AppState; alreadyImported: boolean; receipt?: unknown };
    }>(
      state.executionVersion === 1
        ? "select public.flowday_save_v13($1::jsonb,$2::bigint,$3::uuid,$4::boolean) as result"
        : "select public.flowday_save($1::jsonb,$2::bigint,$3::uuid,$4::boolean) as result",
      [
        JSON.stringify(state),
        options.expected ?? state.revision,
        options.mutation ?? crypto.randomUUID(),
        options.importing ?? false,
      ],
    )
  ).rows[0].result;
}
beforeAll(async () => {
  db = new PGlite();
  // Real PostgreSQL engine, with only Supabase's identity context emulated.
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth, public to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;`);
  await db.exec(
    readFileSync("supabase/migrations/202611190001_workspace.sql", "utf8"),
  );
  await db.exec(
    readFileSync("supabase/migrations/202611190002_ai_coach.sql", "utf8"),
  );
  await db.exec(
    readFileSync(
      "supabase/migrations/202611190003_adaptive_execution.sql",
      "utf8",
    ),
  );
}, 30000);
beforeEach(async () => {
  await db.exec(
    `reset role; truncate auth.users cascade; insert into auth.users values('${A}'),('${B}');`,
  );
  await actor(A);
});
afterAll(async () => {
  await db?.close();
});

describe("actual PostgreSQL migration / RLS / transactions (no hosted Auth)", () => {
  it("round-trips V1.3 metadata and execution history, rejects history truncation, and isolates accounts", async () => {
    await load();
    const state = seedState();
    const at = new Date().toISOString();
    state.executionVersion = 1;
    state.tasks[0].execution = {
      kind: "project",
      dueDate: state.tasks[0].date,
    };
    state.tasks[1].execution = { dependencies: ["t1"] };
    state.settings.growth = {
      personalize: true,
      shareWithAi: false,
      preferred: "morning",
    };
    state.executionLog = [
      {
        id: "start-1",
        taskId: "t1",
        title: state.tasks[0].title,
        at,
        type: "start",
        estimate: 45,
      },
    ];
    state.session = {
      taskId: "t1",
      startedAt: Date.parse(at),
      accumulated: 0,
      running: true,
      tracking: { firstAt: at, estimate: 45, pauses: 0, kind: "project" },
    };
    state.availability = [
      { date: state.tasks[0].date, start: 540, end: 1080, capacity: 30 },
    ];
    state.fixedTimes = [
      {
        id: "f1",
        title: "会议",
        date: state.tasks[0].date,
        start: 600,
        end: 660,
      },
    ];
    const mutation = crypto.randomUUID();
    const written = await save(state, { mutation });
    expect(canonicalWorkspace(written.state)).toBe(canonicalWorkspace(state));
    expect(canonicalWorkspace(await load())).toBe(canonicalWorkspace(state));
    expect((await save(state, { mutation })).state.revision).toBe(
      written.state.revision,
    );
    const broken = structuredClone(written.state);
    broken.executionLog = [];
    await expect(save(broken)).rejects.toThrow(/INVALID_EXECUTION_HISTORY/);
    delete broken.executionVersion;
    await expect(save(broken)).rejects.toThrow(/INVALID_EXECUTION_VERSION/);
    expect((await load()).executionLog).toHaveLength(1);
    await actor(B);
    expect(
      (await db.query("select * from public.workspace_execution")).rows,
    ).toHaveLength(0);
    expect((await load()).executionLog).toBeUndefined();
    await expect(
      db.query("update public.workspace_execution set extra='{}'"),
    ).rejects.toThrow(/permission denied/);
  });
  it("persists per-user AI quotas, caches duplicates and isolates usage records", async () => {
    await load();
    const reserve = async (hash: string) =>
      (
        await db.query<{ r: { id: string; cached: unknown } }>(
          "select public.flowday_ai_reserve($1,'mock','test') as r",
          [hash.padEnd(64, "0")],
        )
      ).rows[0].r;
    const first = await reserve("a");
    await expect(reserve("a")).rejects.toThrow(/AI_BUSY/);
    await db.query(
      "select public.flowday_ai_finish($1,true,100,50,0.001,'test',$2::jsonb)",
      [first.id, JSON.stringify({ token: "test-only" })],
    );
    expect((await reserve("a")).cached).toEqual({ token: "test-only" });
    for (let i = 0; i < 5; i++) await reserve(`different-${i}`);
    await expect(reserve("limit")).rejects.toThrow(/AI_RATE_LIMIT/);
    await actor(B);
    await load();
    expect(
      (await db.query("select * from public.ai_requests")).rows,
    ).toHaveLength(0);
    await expect(
      db.query(
        "select public.flowday_ai_finish($1,false,null,null,null,'forged',null)",
        [first.id],
      ),
    ).rejects.toThrow(/NOT_RESERVED/);
    await reserve("b");
    await expect(db.query("delete from public.ai_requests")).rejects.toThrow(
      /permission denied/,
    );
    await actor("", "anon");
    await expect(reserve("anon")).rejects.toThrow(/permission denied/);
  });
  it("enforces a daily AI quota across minute windows and server restarts", async () => {
    await load();
    await db.exec(
      `reset role; insert into public.ai_requests(user_id,request_hash,provider,model,created_at) select '${A}',repeat('a',64),'mock','test',date_trunc('day',now() at time zone 'UTC') at time zone 'UTC' from generate_series(1,60);`,
    );
    await actor(A);
    await expect(
      db.query("select public.flowday_ai_reserve($1,'mock','test')", [
        "b".repeat(64),
      ]),
    ).rejects.toThrow(/AI_RATE_LIMIT/);
  });
  it("creates an empty workspace and round trips all MVP fields including drawings and timers", async () => {
    expect((await load()).tasks).toEqual([]);
    const s = seedState();
    s.blocks = [
      {
        taskId: "t1",
        date: s.tasks[0].date,
        start: 540,
        end: 600,
        locked: true,
      },
    ];
    s.reviews = [
      {
        date: s.tasks[0].date,
        text: "今天的记录",
        mood: 3,
        drawing: [
          {
            color: "#467d5d",
            size: 5,
            points: [
              [1, 2],
              [1000, 600],
            ],
          },
        ],
      },
    ];
    s.events = [
      {
        id: "old-event",
        taskId: "deleted-task",
        type: "focus",
        at: new Date().toISOString(),
        seconds: 87,
      },
    ];
    s.session = {
      taskId: "t1",
      startedAt: Date.now(),
      accumulated: 12,
      running: false,
    };
    const result = await save(s);
    expect(result.state.revision).toBe(1);
    expect(canonicalWorkspace(validateWorkspace(await load()))).toBe(
      canonicalWorkspace(s),
    );
    expect(
      (await db.query("select * from public.daily_plans")).rows,
    ).toHaveLength(1);
    expect(
      (await db.query("select * from public.schedule_history")).rows,
    ).toHaveLength(1);
  });
  it("isolates every table and allows identical legacy IDs in different accounts", async () => {
    await save(seedState());
    await actor(B);
    for (const table of [
      "profiles",
      "workspaces",
      "user_preferences",
      "goals",
      "tasks",
      "daily_plans",
      "schedule_blocks",
      "execution_events",
      "focus_sessions",
      "daily_reviews",
      "schedule_history",
      "local_imports",
    ])
      expect(
        (await db.query(`select * from public.${table} where user_id='${A}'`))
          .rows,
      ).toHaveLength(0);
    expect((await load()).tasks).toHaveLength(0);
    const b = seedState();
    b.tasks[0].title = "B 的任务";
    await save(b);
    expect((await load()).tasks[0].title).toBe("B 的任务");
    await actor(A);
    expect((await load()).tasks[0].title).not.toBe("B 的任务");
  });
  it("forbids anonymous reads/writes and all direct authenticated writes", async () => {
    await load();
    await expect(
      db.query("update public.workspaces set revision=99"),
    ).rejects.toThrow(/permission denied/);
    await expect(db.query("delete from public.tasks")).rejects.toThrow(
      /permission denied/,
    );
    await expect(db.query("select public.flowday_snapshot()")).rejects.toThrow(
      /permission denied/,
    );
    await actor("", "anon");
    await expect(load()).rejects.toThrow(/permission denied/);
    await expect(save(seedState())).rejects.toThrow(/permission denied/);
    await expect(db.query("select * from public.tasks")).rejects.toThrow(
      /permission denied/,
    );
    await actor("");
    await expect(load()).rejects.toThrow(/UNAUTHENTICATED/);
  });
  it("rejects cross-user references even through direct RPC and rolls back the whole write", async () => {
    await save(seedState());
    await actor(B);
    await load();
    const b = seedState();
    b.goals = [];
    await expect(save(b)).rejects.toThrow(/foreign key/);
    expect((await load()).tasks).toHaveLength(0);
    expect((await load()).revision).toBe(0);
  });
  it("rejects stale versions, deduplicates lost-response retry, and rejects changed retry payload", async () => {
    const s = seedState();
    const mutation = crypto.randomUUID();
    await save(s, { mutation });
    expect((await save(s, { mutation })).state.revision).toBe(1);
    await expect(save(s)).rejects.toThrow(/REVISION_CONFLICT/);
    s.tasks[0].title = "changed";
    await expect(save(s, { mutation })).rejects.toThrow(/IDEMPOTENCY_MISMATCH/);
    expect((await load()).tasks[0].title).not.toBe("changed");
  });
  it("imports once, retains a receipt, and never replaces subsequent cloud edits on repeat import", async () => {
    const source = seedState();
    expect((await save(source, { importing: true })).receipt).toBeTruthy();
    const next = await load();
    next.tasks[0].title = "edited after import";
    await save(next);
    const repeated = await save(source, { importing: true });
    expect(repeated.alreadyImported).toBe(true);
    expect(repeated.state.tasks[0].title).toBe("edited after import");
    expect(
      (await db.query("select * from public.local_imports")).rows,
    ).toHaveLength(1);
    const other = seedState();
    other.revision = 2;
    await expect(save(other, { importing: true })).rejects.toThrow(
      /IMPORT_NOT_EMPTY/,
    );
  });
  it("does not leave partial import or receipt after a constraint failure", async () => {
    const s = seedState();
    s.tasks[0].minutes = 0;
    await expect(save(s, { importing: true })).rejects.toThrow(
      /check constraint/,
    );
    expect((await load()).revision).toBe(0);
    expect(
      (await db.query("select * from public.local_imports")).rows,
    ).toHaveLength(0);
    await save(seedState(), { importing: true });
    expect((await load()).tasks).toHaveLength(4);
  });
  it("rejects overlaps and completed-task schedules at the database boundary", async () => {
    const s = seedState();
    s.blocks = [
      { taskId: "t1", date: s.tasks[0].date, start: 540, end: 600 },
      { taskId: "t2", date: s.tasks[1].date, start: 570, end: 630 },
    ];
    await expect(save(s)).rejects.toThrow(/SCHEDULE_CONFLICT/);
    s.blocks.pop();
    s.tasks[0].status = "done";
    s.tasks[0].completedAt = new Date().toISOString();
    await expect(save(s)).rejects.toThrow(/INVALID_SCHEDULE/);
    expect((await load()).blocks).toHaveLength(0);
  });
  it("persists editing/deleting tasks without losing execution history, then cascades account deletion", async () => {
    let s = seedState();
    s.events = [
      {
        id: "e1",
        taskId: "t1",
        type: "focus",
        at: new Date().toISOString(),
        seconds: 120,
      },
    ];
    await save(s);
    s = await load();
    s.tasks[0].title = "edited";
    await save(s);
    s = await load();
    expect(s.tasks[0].title).toBe("edited");
    s.tasks = s.tasks.filter((t) => t.id !== "t1");
    await save(s);
    expect((await load()).events).toHaveLength(1);
    await db.exec(`reset role; delete from auth.users where id='${A}';`);
    expect(
      (await db.query("select * from public.execution_events")).rows,
    ).toHaveLength(0);
    expect((await db.query("select * from public.profiles")).rows).toHaveLength(
      0,
    );
  });
});

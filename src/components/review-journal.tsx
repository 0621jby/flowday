"use client";
import { useEffect, useRef, useState } from "react";
import {
  cloudData,
  type Account,
  type HistoryPage,
} from "@/modules/cloud/client";
import { HistoryList } from "./saas-controls";
import type { GrowthComparison } from "@/modules/core/growth";
import { BookOpen, Check, ChevronLeft, ChevronRight } from "lucide-react";
import {
  type AppState,
  type DoodleStroke,
  localDate,
} from "@/modules/core/model";
import { addDays, parseDay } from "@/modules/planning/calendar";
import { DoodlePad } from "./doodle-pad";
import "./review-journal.css";
type Review = AppState["reviews"][number];
export function ReviewJournal({
  state,
  cloud = false,
  account,
  historyVisible = true,
  hydrate,
  update,
  notify,
}: {
  state: AppState;
  cloud?: boolean;
  account?: Account;
  historyVisible?: boolean;
  hydrate?: (
    patch: Pick<Partial<AppState>, "reviews">,
    revision: number,
  ) => boolean;
  update: (fn: (s: AppState) => AppState) => Promise<boolean>;
  notify: (text: string) => void;
}) {
  const today = localDate();
  const [date, setDate] = useState(today);
  const initial = state.reviews.find((r) => r.date === today);
  const [text, setText] = useState(initial?.text ?? "");
  const [mood, setMood] = useState(initial?.mood ?? 2);
  const [drawing, setDrawing] = useState<DoodleStroke[]>(
    initial?.drawing ?? [],
  );
  const [baseline, setBaseline] = useState<Review | undefined>(initial);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [padVersion, setPadVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [dayStats, setDayStats] = useState<{
    date: string;
    completed: number;
    focused: number;
  }>();
  const inFlight = useRef(false);
  const [baselineRevision, setBaselineRevision] = useState(state.revision);
  useEffect(() => {
    if (!account || !historyVisible) return;
    let active = true;
    void cloudData<GrowthComparison>(account, {
      kind: "growth",
      end: date,
      days: "1",
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
      .then((report) => {
        if (active)
          setDayStats({
            date,
            completed: report.current.completed,
            focused: report.current.focusMinutes,
          });
      })
      .catch(() => {
        if (active) setDayStats(undefined);
      });
    return () => {
      active = false;
    };
  }, [account, date, state.revision, historyVisible]);
  const dirty =
    text !== (baseline?.text ?? "") ||
    mood !== (baseline?.mood ?? 2) ||
    JSON.stringify(drawing) !== JSON.stringify(baseline?.drawing ?? []);
  useEffect(() => {
    const incoming = state.reviews.find((r) => r.date === date);
    if (account && date !== today && !incoming) return;
    if (!dirty && JSON.stringify(incoming) !== JSON.stringify(baseline)) {
      setText(incoming?.text ?? "");
      setMood(incoming?.mood ?? 2);
      setDrawing(incoming?.drawing ?? []);
      setBaseline(incoming);
      setBaselineRevision(state.revision);
      setPadVersion((v) => v + 1);
    }
  }, [state.reviews, state.revision, date, dirty, baseline, account, today]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function load(next: string) {
    if (inFlight.current) return;
    let review = state.reviews.find((r) => r.date === next);
    if (account && !review) {
      inFlight.current = true;
      setLoading(true);
      try {
        const result = await cloudData<HistoryPage<Review>>(account, {
          kind: "review",
          day: next,
        });
        review = result.items[0];
        if (review && !hydrate?.({ reviews: [review] }, state.revision))
          throw new Error("读取时云端版本已变化，请再选一次日期。");
      } catch (e) {
        setError((e as Error).message);
        return;
      } finally {
        inFlight.current = false;
        setLoading(false);
      }
    }
    setDate(next);
    setText(review?.text ?? "");
    setMood(review?.mood ?? 2);
    setDrawing(review?.drawing ?? []);
    setBaseline(review);
    setBaselineRevision(state.revision);
    setPending(null);
    setError("");
    setPadVersion((v) => v + 1);
  }
  function select(next: string) {
    try {
      parseDay(next);
      if (next > today) throw new Error("未来日期暂不能写复盘");
      if (next === date) return;
      if (dirty) setPending(next);
      else void load(next);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function save() {
    const review = { date, text, mood, drawing };
    const ok = await update((s) => {
      const incoming = s.reviews.find((r) => r.date === date);
      if (
        account &&
        date !== today &&
        !incoming &&
        s.revision !== baselineRevision
      )
        throw new Error("请先重新读取这一天的云端复盘，再保存草稿。");
      if (
        JSON.stringify(
          !incoming &&
            account &&
            date !== today &&
            s.revision === baselineRevision
            ? baseline
            : incoming,
        ) !== JSON.stringify(baseline)
      )
        throw new Error(
          "这一天的复盘已在其他地方修改，请保留草稿并重新载入后合并。",
        );
      return {
        ...s,
        reviews: [...s.reviews.filter((r) => r.date !== date), review],
      };
    });
    if (ok) {
      setBaseline(review);
      setError("");
      notify("文字、心情和涂鸦已一起保存");
    } else
      setError(
        "保存未成功，草稿仍保留。请查看页面上方错误提示；存储空间不足时先导出数据。",
      );
    return ok;
  }
  const completed = state.tasks.filter(
    (t) =>
      t.status === "done" &&
      t.completedAt &&
      localDate(new Date(t.completedAt)) === date,
  ).length;
  const focused = state.events
    .filter((e) => e.type === "focus" && localDate(new Date(e.at)) === date)
    .reduce((sum, e) => sum + (e.seconds ?? 0), 0);
  return (
    <>
      <section className="page-heading">
        <div>
          <div className="eyebrow">停一停，也是一种前进</div>
          <h1>
            {date === today
              ? "今天，有哪些值得记住？"
              : "回到那一天，看看自己的足迹"}
          </h1>
          <p>文字、心情或一幅小画。选择适合你的表达方式。</p>
        </div>
      </section>
      <div className="journal-navigation">
        <button
          className="icon-btn"
          aria-label="前一天复盘"
          onClick={() => select(addDays(date, -1))}
        >
          <ChevronLeft size={18} />
        </button>
        <input
          aria-label="查看复盘日期"
          type="date"
          max={today}
          value={date}
          onChange={(e) => {
            if (e.target.value) select(e.target.value);
          }}
        />
        <button
          className="icon-btn"
          aria-label="后一天复盘"
          disabled={date >= today}
          onClick={() => select(addDays(date, 1))}
        >
          <ChevronRight size={18} />
        </button>
        <button className="button secondary" onClick={() => select(today)}>
          回到今天
        </button>
        <span role="status">
          {dirty
            ? "有未保存的修改"
            : baseline
              ? "已保存 · 可继续编辑"
              : "这一天还没有复盘"}
        </span>
      </div>
      {pending && (
        <div className="journal-warning" role="alert">
          <p>当前复盘尚未保存，要如何切换日期？</p>
          <button
            className="button primary"
            onClick={async () => {
              if (await save()) load(pending);
            }}
          >
            保存并切换
          </button>
          <button className="button secondary" onClick={() => load(pending)}>
            放弃草稿并切换
          </button>
          <button className="text-button" onClick={() => setPending(null)}>
            继续编辑
          </button>
        </div>
      )}
      {error && (
        <p className="journal-warning" role="alert">
          {error}
        </p>
      )}
      {account &&
        date !== today &&
        baselineRevision !== state.revision &&
        !state.reviews.some((r) => r.date === date) && (
          <p className="journal-warning">
            云端数据已同步。建议先复制未保存文字，再重新读取这一天，以免覆盖其他设备的复盘。
            <button
              type="button"
              className="button secondary"
              disabled={loading}
              onClick={() => {
                if (
                  !dirty ||
                  window.confirm("放弃当前草稿并读取这一天的最新复盘？")
                )
                  void load(date);
              }}
            >
              重新读取这一天
            </button>
          </p>
        )}
      <div className="review-layout">
        <section className="panel review-form">
          <h2>{date === today ? "给今天一个温柔的回顾" : `${date} 的回顾`}</h2>
          <p className="muted">这一天的感受如何？</p>
          <div className="mood-picker">
            {[
              { emoji: "☁", label: "有些吃力" },
              { emoji: "⛅", label: "平稳的一天" },
              { emoji: "☀", label: "状态不错" },
            ].map((item, i) => (
              <button
                key={item.label}
                className={mood === i + 1 ? "chosen" : ""}
                aria-pressed={mood === i + 1}
                onClick={() => setMood(i + 1)}
              >
                <span>{item.emoji}</span>
                {item.label}
              </button>
            ))}
          </div>
          <label className="field">
            有什么想留给这一天？
            <textarea
              rows={6}
              maxLength={2000}
              value={text}
              disabled={loading}
              onChange={(e) => setText(e.target.value)}
              placeholder="可以写进展、困难，也可以只画下此刻的感受…"
            />
          </label>
          <DoodlePad
            key={`${date}-${padVersion}`}
            value={drawing}
            onChange={setDrawing}
          />
          <div className="form-footer">
            <span className="muted">只写给自己，不必完美。</span>
            <button
              className="button primary"
              onClick={save}
              disabled={loading}
            >
              <Check size={16} />
              保存复盘
            </button>
          </div>
          <p className="journal-storage">
            {cloud
              ? "历史复盘会保存在当前账户，可按日期回看和编辑。建议定期在设置中导出备份。"
              : "历史复盘不会因日期变化自动删除。当前仅保存在此浏览器；清除浏览器数据会丢失，请定期在设置中导出。"}
          </p>
        </section>
        <aside>
          <section className="panel journal-summary">
            <BookOpen size={22} />
            <h2>这一天留下的足迹</h2>
            <p>
              <strong>
                {account
                  ? dayStats?.date === date
                    ? dayStats.completed
                    : "—"
                  : completed}
              </strong>{" "}
              个任务完成
            </p>
            <p>
              <strong>
                {account
                  ? dayStats?.date === date
                    ? dayStats.focused
                    : "—"
                  : Math.floor(focused / 60)}
              </strong>{" "}
              分钟已记录专注
            </p>
            <small>按完成/执行记录日期统计，不是当前计划日期。</small>
          </section>
          <section className="panel journal-history">
            <h2>
              历史复盘 {!account && <span>{state.reviews.length} 天</span>}
            </h2>
            <div>
              {account ? (
                <HistoryList<Review>
                  account={account}
                  revision={state.revision}
                  kind="reviews"
                  render={(review) => (
                    <button
                      type="button"
                      disabled={loading}
                      className={review.date === date ? "selected" : ""}
                      onClick={() => select(review.date)}
                    >
                      <strong>{review.date}</strong>
                      <p>{review.text || "留下了一次心情记录"}</p>
                    </button>
                  )}
                />
              ) : (
                [...state.reviews]
                  .sort((a, b) => b.date.localeCompare(a.date))
                  .map((review) => (
                    <button
                      key={review.date}
                      className={review.date === date ? "selected" : ""}
                      onClick={() => select(review.date)}
                    >
                      <strong>
                        {review.date}
                        <span>{["☁", "⛅", "☀"][review.mood - 1]}</span>
                      </strong>
                      <p>{review.text || "留下了一次心情记录"}</p>
                      {!!review.drawing?.length && <small>含心情涂鸦</small>}
                    </button>
                  ))
              )}
              {!account && !state.reviews.length && (
                <p className="muted">保存第一篇复盘后，就可以从这里回看。</p>
              )}
            </div>
          </section>
        </aside>
      </div>
    </>
  );
}

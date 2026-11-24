"use client";
import { useState } from "react";
import { type Task, localDate } from "@/modules/core/model";
import { completionTrend } from "@/modules/core/insights";
export function CompletionChart({ tasks }: { tasks: Task[] }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [detail, setDetail] = useState<string | null>(null);
  const series = completionTrend(tasks, localDate(), days);
  const max = Math.max(1, ...series.map((d) => d.count));
  return (
    <section className="panel insight-chart">
      <div className="section-heading">
        <h2>最近 {days} 天的完成记录</h2>
        <div className="view-switch" aria-label="趋势时间范围">
          {([7, 30] as const).map((n) => (
            <button
              key={n}
              aria-pressed={days === n}
              className={days === n ? "selected" : ""}
              onClick={() => {
                setDays(n);
                setDetail(null);
              }}
            >
              {n} 天
            </button>
          ))}
        </div>
      </div>
      <p className="chart-caption">
        基于当前已完成任务 · 点击柱状条查看当天数量 · 合计{" "}
        {series.reduce((sum, d) => sum + d.count, 0)} 项
      </p>
      <div className="trend-scroll">
        <div className={`bar-chart ${days === 30 ? "thirty-days" : ""}`}>
          {series.map((d, i) => (
            <button
              className="bar-column trend-bar"
              key={d.date}
              aria-label={`${d.date}，完成 ${d.count} 项`}
              onClick={() => setDetail(`${d.date} · 完成 ${d.count} 项任务`)}
            >
              <strong>{d.count}</strong>
              <div className="bar-track">
                <div
                  style={{
                    height: `${(d.count / max) * 100}%`,
                    minHeight: d.count ? 3 : 0,
                  }}
                />
              </div>
              <span>
                {i === days - 1
                  ? "今天"
                  : `${Number(d.date.slice(5, 7))}/${Number(d.date.slice(8))}`}
              </span>
            </button>
          ))}
        </div>
      </div>
      <p className="chart-caption" role="status">
        {detail ??
          (days === 30
            ? "30 天更适合观察节奏变化；窄屏可横向滑动图表。"
            : "先看一周，再慢慢积累更长期的记录。")}
      </p>
    </section>
  );
}

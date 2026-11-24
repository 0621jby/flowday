"use client";
import { useRef, useState, type PointerEvent } from "react";
import type { DoodleStroke } from "@/modules/core/model";
const colors = ["#467d5d", "#b78160", "#657da5", "#b89b40", "#454b45"] as const;
export function DoodlePad({
  value,
  onChange,
}: {
  value: DoodleStroke[];
  onChange: (strokes: DoodleStroke[]) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [color, setColor] = useState<DoodleStroke["color"]>(colors[0]);
  const [size, setSize] = useState<2 | 5 | 9>(5);
  const [active, setActive] = useState<DoodleStroke | null>(null);
  const current = useRef<DoodleStroke | null>(null);
  const [undo, setUndo] = useState<DoodleStroke[][]>([]);
  function change(next: DoodleStroke[]) {
    setUndo((stack) => [...stack.slice(-9), value]);
    onChange(next);
  }
  function point(e: PointerEvent<SVGSVGElement>): [number, number] {
    const box = e.currentTarget.getBoundingClientRect();
    return [
      Math.round(
        Math.max(
          0,
          Math.min(1000, ((e.clientX - box.left) / box.width) * 1000),
        ),
      ),
      Math.round(
        Math.max(0, Math.min(600, ((e.clientY - box.top) / box.height) * 600)),
      ),
    ];
  }
  function finish(e: PointerEvent<SVGSVGElement>) {
    if (!current.current) return;
    const stroke = current.current;
    current.current = null;
    setActive(null);
    if (e.currentTarget.hasPointerCapture(e.pointerId))
      e.currentTarget.releasePointerCapture(e.pointerId);
    change([...value, stroke]);
  }
  return (
    <section className="doodle-section">
      <div className="doodle-heading">
        <div>
          <h3>
            画下此刻的心情 <span>可选</span>
          </h3>
          <p>不用画得好，也可以只留下一条线。</p>
        </div>
        <button
          type="button"
          className={`button ${enabled ? "primary" : "secondary"}`}
          onClick={() => setEnabled(!enabled)}
          aria-pressed={enabled}
        >
          {enabled ? "结束涂鸦" : "开始涂鸦"}
        </button>
      </div>
      <div className="doodle-tools">
        {colors.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`画笔颜色 ${c}`}
            aria-pressed={c === color}
            onClick={() => setColor(c)}
            style={{ background: c }}
            className={c === color ? "selected" : ""}
          />
        ))}
        <label>
          粗细
          <select
            value={size}
            onChange={(e) => setSize(Number(e.target.value) as 2 | 5 | 9)}
            aria-label="画笔粗细"
          >
            <option value={2}>细</option>
            <option value={5}>中</option>
            <option value={9}>粗</option>
          </select>
        </label>
        <button
          type="button"
          className="text-button"
          disabled={!undo.length}
          onClick={() => {
            const previous = undo.at(-1);
            if (previous) {
              onChange(previous);
              setUndo(undo.slice(0, -1));
            }
          }}
        >
          撤销笔画
        </button>
        <button
          type="button"
          className="text-button"
          disabled={!value.length}
          onClick={() => change([])}
        >
          清空
        </button>
      </div>
      <svg
        viewBox="0 0 1000 600"
        role="img"
        aria-label="心情涂鸦画布；不方便绘画时可使用上方文字复盘"
        className={`doodle-pad ${enabled ? "drawing" : ""}`}
        onPointerDown={(e) => {
          if (
            !enabled ||
            value.length >= 40 ||
            e.button !== 0 ||
            current.current
          )
            return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const stroke = { color, size, points: [point(e)] };
          current.current = stroke;
          setActive(stroke);
        }}
        onPointerMove={(e) => {
          if (!current.current) return;
          let points = current.current.points;
          if (points.length >= 200)
            points = points.filter((_, i) => i % 2 === 0);
          const next = point(e);
          const last = points.at(-1)!;
          if (Math.abs(last[0] - next[0]) + Math.abs(last[1] - next[1]) < 3)
            return;
          const stroke = { ...current.current, points: [...points, next] };
          current.current = stroke;
          setActive(stroke);
        }}
        onPointerUp={finish}
        onPointerCancel={() => {
          current.current = null;
          setActive(null);
        }}
      >
        {[...value, ...(active ? [active] : [])].map((stroke, i) =>
          stroke.points.length === 1 ? (
            <circle
              key={i}
              cx={stroke.points[0][0]}
              cy={stroke.points[0][1]}
              r={stroke.size / 2}
              fill={stroke.color}
            />
          ) : (
            <polyline
              key={i}
              points={stroke.points.map((p) => p.join(",")).join(" ")}
              fill="none"
              stroke={stroke.color}
              strokeWidth={stroke.size}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ),
        )}
      </svg>
      <p className="muted">
        {value.length >= 40
          ? "已达到本页 40 笔上限，可撤销或清空后继续。"
          : enabled
            ? "绘画时画布内手势用于画线；结束涂鸦后可正常滑动页面。"
            : "点击“开始涂鸦”即可画线。"}{" "}
        涂鸦会随“保存复盘”一起保存。
      </p>
    </section>
  );
}

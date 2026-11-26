import type { ComponentProps } from "react";

export function HourSelect({
  min,
  max,
  ...props
}: ComponentProps<"select"> & { min: number; max: number }) {
  return (
    <select className="time-control" {...props}>
      {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((hour) => (
        <option key={hour} value={hour}>
          {String(hour).padStart(2, "0")}:00
        </option>
      ))}
    </select>
  );
}

export function TimeInput(props: Omit<ComponentProps<"input">, "type">) {
  return <input className="time-control" type="time" {...props} />;
}

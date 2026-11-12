import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export interface TrendPoint {
  time: string;
  temperature: number | null;
  humidity: number | null;
}

/** Biểu đồ đường nhiệt độ/độ ẩm (tách riêng để chỉ tải Recharts khi thật sự có số đo). */
export default function TrendChart({ points, temperatureLabel, humidityLabel }: { points: TrendPoint[]; temperatureLabel: string; humidityLabel: string }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={points} margin={{ top: 6, right: 6, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="var(--smc-line)" strokeDasharray="3 5" vertical={false} />
        <XAxis dataKey="time" tick={{ fontSize: 11, fill: "var(--smc-muted)" }} tickLine={false} axisLine={false} minTickGap={36} />
        <YAxis yAxisId="t" tick={{ fontSize: 11, fill: "var(--smc-muted)" }} tickLine={false} axisLine={false} domain={["auto", "auto"]} />
        <YAxis yAxisId="h" orientation="right" hide domain={[0, 100]} />
        <Tooltip contentStyle={{ borderRadius: 14, border: "1px solid var(--smc-line)", background: "var(--smc-surface)", fontSize: 12 }} labelStyle={{ color: "var(--smc-muted)" }} />
        <Line yAxisId="t" type="monotone" dataKey="temperature" name={temperatureLabel} stroke="var(--smc-primary)" strokeWidth={2} dot={false} isAnimationActive={false} />
        <Line yAxisId="h" type="monotone" dataKey="humidity" name={humidityLabel} stroke="var(--smc-success)" strokeWidth={2} dot={false} isAnimationActive={false} />
      </LineChart>
    </ResponsiveContainer>
  );
}

import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { PlatformOverview } from '../types';

type Props = {
  data: PlatformOverview['analytics']['trend'];
};

export const AnalyticsTrendChart = ({ data }: Props) => (
  <ResponsiveContainer width="100%" height="100%">
    <LineChart data={data}>
      <CartesianGrid strokeDasharray="3 3" stroke="rgba(148, 163, 184, 0.25)" />
      <XAxis dataKey="label" stroke="#6b7280" tickLine={false} axisLine={false} />
      <YAxis stroke="#6b7280" tickLine={false} axisLine={false} width={42} />
      <Tooltip />
      <Line type="monotone" dataKey="accuracy" stroke="#c25b2d" strokeWidth={3} dot={{ r: 4 }} name="Accuracy %" />
      <Line type="monotone" dataKey="score" stroke="#0f172a" strokeWidth={3} dot={{ r: 4 }} name="Score" />
    </LineChart>
  </ResponsiveContainer>
);

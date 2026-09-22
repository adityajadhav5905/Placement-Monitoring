import React, { useState, useEffect } from 'react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, PieChart, Pie, Cell, CartesianGrid, LabelList } from 'recharts';

const VALID_DEPARTMENTS = ['AIDS', 'CE', 'ECE', 'ENTC', 'IT'];

// Exact Color Scheme requested:
// ENTC: Purple, CE: Green, IT: Light Blue, AIDS: Yellow with slight hint of green, ECE: Dark Purple
const DEPARTMENT_COLORS = {
  'ENTC': '#a855f7', // Purple
  'CE': '#22c55e',   // Green
  'IT': '#38bdf8',   // Light Blue
  'AIDS': '#cbe635', // Yellow with slight hint of green (Lime / Chartreuse)
  'ECE': '#4c1d95',  // Dark Purple
};

function Analytics() {
  const [data, setData] = useState({
    deptCounts: [],
    deptAvgCtc: [],
    companyCounts: []
  });
  const [loading, setLoading] = useState(true);

  const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

  useEffect(() => {
    fetch(`${API_BASE}/stats/analytics`)
      .then(res => res.json())
      .then(data => {
        setData(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Error fetching analytics:', err);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh', fontSize: '1.2rem', color: 'var(--blue)' }}>
        Loading analytical charts...
      </div>
    );
  }

  // Sanitize & map data strictly for the 5 valid departments
  const deptCountMap = {};
  if (Array.isArray(data.deptCounts)) {
    data.deptCounts.forEach((item) => {
      if (item && item.department) {
        const dept = item.department.trim().toUpperCase();
        if (VALID_DEPARTMENTS.includes(dept)) {
          deptCountMap[dept] = (deptCountMap[dept] || 0) + (Number(item.count) || 0);
        }
      }
    });
  }

  const processedDeptCounts = VALID_DEPARTMENTS.map((dept) => ({
    department: dept,
    count: deptCountMap[dept] || 0
  }));

  const deptAvgMap = {};
  if (Array.isArray(data.deptAvgCtc)) {
    data.deptAvgCtc.forEach((item) => {
      if (item && item.department) {
        const dept = item.department.trim().toUpperCase();
        if (VALID_DEPARTMENTS.includes(dept)) {
          deptAvgMap[dept] = parseFloat(item.avg_ctc) || 0;
        }
      }
    });
  }

  const processedDeptAvgCtc = VALID_DEPARTMENTS.map((dept) => ({
    department: dept,
    avg_ctc: Number((deptAvgMap[dept] || 0).toFixed(2))
  }));

  // Professional Glassmorphic Tooltip
  const CustomTooltip = ({ active, payload, label }) => {
    if (active && payload && payload.length) {
      const item = payload[0];
      const deptName = label || item.payload?.department || item.name;
      const deptColor = DEPARTMENT_COLORS[deptName] || item.color || 'var(--purple)';
      const isCtc = item.dataKey === 'avg_ctc' || (item.name && item.name.includes('CTC'));

      return (
        <div style={{ 
          background: 'rgba(16, 20, 35, 0.95)', 
          backdropFilter: 'blur(10px)', 
          border: '1px solid rgba(255, 255, 255, 0.1)', 
          borderRadius: '12px',
          padding: '12px 18px',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)'
        }}>
          <p style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '4px' }}>
            {deptName} Branch
          </p>
          <p style={{ fontSize: '1rem', fontWeight: 700, color: deptColor, margin: '2px 0' }}>
            {isCtc ? `Avg CTC: ${item.value} LPA` : `Placed Students: ${item.value}`}
          </p>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="fade-in">
      <h1 style={{ fontSize: 'clamp(1.5rem, 5vw, 2rem)', fontWeight: 700, marginBottom: '5px' }}>Placement Analytics</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: '24px', fontSize: '0.92rem' }}>Visualizing hiring statistics and department stats</p>

      {/* Structured 1-Column Grid (vertical stack) for all charts */}
      <div className="nm-grid grid-1" style={{ gap: '24px' }}>
        {/* Chart 1: Department wise Placement Count */}
        <div className="glass-panel">
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '16px', color: 'var(--text-color)' }}>Department Placements Count</h3>
          <div style={{ width: '100%', height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={processedDeptCounts} margin={{ top: 28, right: 15, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.05)" vertical={false} />
                <XAxis dataKey="department" stroke="var(--text-muted)" fontSize={12} tickLine={false} />
                <YAxis 
                  stroke="var(--text-muted)" 
                  fontSize={12} 
                  tickLine={false} 
                  allowDecimals={false}
                  domain={[0, (dataMax) => Math.max(Math.ceil(dataMax * 1.25), dataMax + 2)]}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255, 255, 255, 0.02)' }} />
                <Bar dataKey="count" name="Placed Students" radius={[6, 6, 0, 0]} barSize={42}>
                  {processedDeptCounts.map((entry) => (
                    <Cell key={`bar-count-${entry.department}`} fill={DEPARTMENT_COLORS[entry.department]} />
                  ))}
                  <LabelList
                    dataKey="count"
                    position="top"
                    fill="var(--text-color)"
                    fontSize={12}
                    fontWeight={700}
                    offset={10}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 2: Department wise Average CTC */}
        <div className="glass-panel">
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '16px', color: 'var(--text-color)' }}>Department Average CTC (LPA)</h3>
          <div style={{ width: '100%', height: 320 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={processedDeptAvgCtc} margin={{ top: 28, right: 15, left: -15, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255, 255, 255, 0.05)" vertical={false} />
                <XAxis dataKey="department" stroke="var(--text-muted)" fontSize={12} tickLine={false} />
                <YAxis 
                  stroke="var(--text-muted)" 
                  fontSize={12} 
                  tickLine={false}
                  unit=" LPA"
                  domain={[0, (dataMax) => Math.max(Math.ceil(dataMax * 1.25), dataMax + 3)]}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255, 255, 255, 0.02)' }} />
                <Bar dataKey="avg_ctc" name="Average CTC" radius={[6, 6, 0, 0]} barSize={42}>
                  {processedDeptAvgCtc.map((entry) => (
                    <Cell key={`bar-avg-${entry.department}`} fill={DEPARTMENT_COLORS[entry.department]} />
                  ))}
                  <LabelList
                    dataKey="avg_ctc"
                    position="top"
                    formatter={(val) => `${val} LPA`}
                    fill="var(--text-color)"
                    fontSize={12}
                    fontWeight={700}
                    offset={10}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Chart 3: Department Placement Share (Pie Chart) */}
        <div className="glass-panel">
          <h3 style={{ fontSize: '1.05rem', fontWeight: 600, marginBottom: '16px', color: 'var(--text-color)' }}>Share of Placements by Department</h3>
          <div className="analytics-pie-wrapper">
            <div className="analytics-pie-chart">
              <ResponsiveContainer width="100%" height={240}>
                <PieChart>
                  <Pie
                    data={processedDeptCounts}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={95}
                    paddingAngle={4}
                    dataKey="count"
                    nameKey="department"
                  >
                    {processedDeptCounts.map((entry) => (
                      <Cell 
                        key={`cell-${entry.department}`} 
                        fill={DEPARTMENT_COLORS[entry.department]} 
                        style={{ outline: 'none' }} 
                      />
                    ))}
                  </Pie>
                  <Tooltip content={<CustomTooltip />} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            {/* Custom Legend */}
            <div className="analytics-pie-legend">
              {processedDeptCounts.map((entry) => (
                <div key={entry.department} className="analytics-legend-item">
                  <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: DEPARTMENT_COLORS[entry.department], flexShrink: 0 }}></div>
                  <span style={{ fontWeight: 500, color: 'var(--text-color)', fontSize: '0.88rem' }}>
                    {entry.department} <strong style={{ color: 'var(--text-muted)' }}>({entry.count})</strong>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default Analytics;

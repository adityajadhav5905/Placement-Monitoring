import React, { useState, useEffect } from 'react';
import { Award, TrendingUp, Users, Building2, Briefcase, Calculator, Percent, ShieldCheck } from 'lucide-react';

function Overview() {
  const [stats, setStats] = useState({
    totalPlaced: 0,
    highestCTC: 0,
    averageCTC: 0,
    medianCTC: 0,
    modeCTC: 0,
    totalCompanies: 0,
    totalDrives: 0,
    deptMaxCtc: []
  });
  const [loading, setLoading] = useState(true);

  const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

  useEffect(() => {
    fetch(`${API_BASE}/stats/overview`)
      .then(res => res.json())
      .then(data => {
        setStats(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Error fetching overview stats:', err);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh', fontSize: '1.2rem', color: 'var(--blue)' }}>
        Loading statistics...
      </div>
    );
  }

  const statCards = [
    {
      title: 'Total Students Placed',
      value: stats.totalPlaced,
      icon: <Users size={24} style={{ color: 'var(--blue)' }} />,
      colorClass: 'pill-info'
    },
    {
      title: 'Highest CTC Offered',
      value: `${stats.highestCTC} LPA`,
      icon: <Award size={24} style={{ color: 'var(--amber)' }} />,
      colorClass: 'pill-warning'
    },
    {
      title: 'Average CTC',
      value: `${stats.averageCTC} LPA`,
      icon: <TrendingUp size={24} style={{ color: 'var(--purple)' }} />,
      colorClass: 'pill-success'
    },
    {
      title: 'Median CTC',
      value: `${stats.medianCTC} LPA`,
      icon: <Calculator size={24} style={{ color: 'var(--cyan)' }} />,
      colorClass: 'pill-info'
    },
    {
      title: 'Mode CTC',
      value: `${stats.modeCTC} LPA`,
      icon: <Percent size={24} style={{ color: 'var(--rose)' }} />,
      colorClass: 'pill-warning'
    },
    {
      title: 'Companies Visited',
      value: stats.totalCompanies,
      icon: <Building2 size={24} style={{ color: 'var(--cyan)' }} />,
      colorClass: 'pill-info'
    },
    {
      title: 'Total Placement Drives',
      value: stats.totalDrives,
      icon: <Briefcase size={24} style={{ color: 'var(--emerald)' }} />,
      colorClass: 'pill-success'
    }
  ];

  return (
    <div className="fade-in">
      <h1 style={{ fontSize: 'clamp(1.5rem, 5vw, 2rem)', fontWeight: 700, marginBottom: '5px' }}>Placement Overview</h1>
      <p style={{ color: 'var(--text-muted)', marginBottom: '24px', fontSize: '0.95rem' }}>Comprehensive batch metrics and package analysis</p>

      {/* Responsive Grid for all primary stats cards */}
      <div className="nm-grid grid-4" style={{ marginBottom: '35px' }}>
        {statCards.map((card, idx) => (
          <div key={idx} className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-muted)' }}>{card.title}</span>
              <div style={{ padding: '8px 10px', borderRadius: '12px', background: 'rgba(255, 255, 255, 0.03)', border: '1px solid var(--glass-border)' }}>
                {card.icon}
              </div>
            </div>
            <div>
              <h2 style={{ fontSize: 'clamp(1.5rem, 4vw, 1.8rem)', fontWeight: 700, color: 'var(--text-color)', marginBottom: '4px' }}>{card.value}</h2>
            </div>
          </div>
        ))}
      </div>

      {/* Department Wise Max CTC */}
      <h2 style={{ fontSize: 'clamp(1.2rem, 4vw, 1.4rem)', fontWeight: 700, marginBottom: '6px', marginTop: '30px' }}>Department Highest Compensation</h2>
      <p style={{ color: 'var(--text-muted)', marginBottom: '18px', fontSize: '0.92rem' }}>Highest package (Max CTC) achieved in each branch</p>

      <div className="nm-grid grid-4" style={{ marginBottom: '35px' }}>
        {stats.deptMaxCtc && stats.deptMaxCtc.length > 0 ? (
          stats.deptMaxCtc.map((dept, idx) => (
            <div key={idx} className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '14px', borderLeft: '4px solid var(--purple)' }}>
              <div style={{ padding: '10px', borderRadius: '10px', background: 'rgba(192, 132, 252, 0.06)', flexShrink: 0 }}>
                <ShieldCheck size={20} style={{ color: 'var(--purple)' }} />
              </div>
              <div>
                <h3 style={{ fontSize: '0.85rem', fontWeight: 600, color: 'var(--text-muted)' }}>{dept.department} Branch</h3>
                <p style={{ fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-color)', marginTop: '2px' }}>{dept.max_ctc} LPA</p>
              </div>
            </div>
          ))
        ) : (
          <div className="glass-panel" style={{ gridColumn: '1 / -1', textAlign: 'center', color: 'var(--text-muted)' }}>
            No department placement data available yet.
          </div>
        )}
      </div>

      <div className="glass-panel" style={{ padding: '24px 20px', background: 'rgba(139, 92, 246, 0.03)', border: '1px solid rgba(139, 92, 246, 0.15)' }}>
        <h3 style={{ fontSize: '1.1rem', fontWeight: 600, marginBottom: '12px', color: 'var(--text-color)' }}>Quick Dashboard Insights</h3>
        <ul style={{ color: 'var(--text-muted)', lineHeight: '1.7', paddingLeft: '20px', fontSize: '0.92rem' }}>
          <li>The batch average CTC currently stands at <strong style={{ color: 'var(--purple)' }}>{stats.averageCTC} LPA</strong>, with the highest compensation package reaching <strong style={{ color: 'var(--amber)' }}>{stats.highestCTC} LPA</strong>.</li>
          <li>A total of <strong style={{ color: 'var(--blue)' }}>{stats.totalPlaced} students</strong> have successfully secured placement offers across various departments.</li>
          <li>We have hosted <strong style={{ color: 'var(--cyan)' }}>{stats.totalCompanies} companies</strong> for a total of <strong style={{ color: 'var(--emerald)' }}>{stats.totalDrives} placement drives</strong> on campus.</li>
        </ul>
      </div>
    </div>
  );
}

export default Overview;

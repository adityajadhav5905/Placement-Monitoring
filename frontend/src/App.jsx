import React, { useState, useEffect } from 'react';
import Overview from './pages/Overview.jsx';
import Companies from './pages/Companies.jsx';
import Students from './pages/Students.jsx';
import Analytics from './pages/Analytics.jsx';
import Contact from './pages/Contact.jsx';
import { LayoutDashboard, Building2, Users, BarChart3, ArrowRight, Award, TrendingUp, MessageSquareWarning, Menu, X } from 'lucide-react';

function App() {
  const [currentPage, setCurrentPage] = useState('home'); // 'home' or 'dashboard'
  const [activeTab, setActiveTab] = useState('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [stats, setStats] = useState({ totalPlaced: 0, highestCTC: 0, averageCTC: 0, totalCompanies: 0, totalVisitors: 0, dailyVisitors: 0 });
  const [statsLoading, setStatsLoading] = useState(true);

  const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

  // Fetch highlights for the landing page
  useEffect(() => {
    fetch(`${API_BASE}/stats/overview`)
      .then(res => res.json())
      .then(data => {
        setStats(data);
        setStatsLoading(false);
      })
      .catch(err => {
        console.error(err);
        setStatsLoading(false);
      });
  }, []);

  // Handle body scroll lock when mobile drawer is open
  useEffect(() => {
    if (mobileMenuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [mobileMenuOpen]);

  const handleNoticeClick = () => {
    setCurrentPage('dashboard');
    setActiveTab('contact');
    setMobileMenuOpen(false);
  };

  const handleNavClick = (tab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  const renderContent = () => {
    switch (activeTab) {
      case 'overview':
        return <Overview />;
      case 'companies':
        return <Companies />;
      case 'students':
        return <Students />;
      case 'analytics':
        return <Analytics />;
      case 'contact':
        return <Contact />;
      default:
        return <Overview />;
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Top Rolling Notice / Marquee Banner on all pages */}
      <div
        className="top-notice-banner"
        onClick={handleNoticeClick}
        title="Data can contain discrepancies. Click here to report and contact us"
      >
        <div className="top-notice-track">
          <div className="top-notice-item">
            <span style={{ color: 'var(--amber)', fontWeight: 700 }}>⚠️ Important Notice:</span>
            <span>Placement drive data is aggregated from Non-Official sources and can contain discrepancies.</span>
            <span style={{ color: 'var(--white)', textDecoration: 'none', fontWeight: 600 }}>Click here to report any inaccuracies.</span>
          </div>
          <div className="top-notice-item">
            <span style={{ color: 'var(--amber)', fontWeight: 700 }}>Important: </span>
            <span>Placement drive data is aggregated from Non-Official sources and can contain discrepancies.</span>
            <span style={{ color: 'var(--white)', textDecoration: 'none', fontWeight: 600 }}>Click here to report any inaccuracies.</span>
          </div>
        </div>
      </div>

      {currentPage === 'home' ? (
        <div className="hero-container fade-in">
          <img
            src="/favicon.svg"
            alt="PICT Placement Monitoring"
            className="hero-logo"
            style={{
              objectFit: 'contain',
              marginBottom: '20px',
              filter: 'drop-shadow(0 0 20px rgba(2, 204, 250, 0.45)) drop-shadow(0 0 40px rgba(168, 85, 247, 0.25))',
              transition: 'transform 0.3s ease'
            }}
          />
          <h1 className="hero-title">PICT Campus Placement Monitoring</h1>
          <p className="hero-subtitle">
            Real-time analytics, company visited logs, and placed students statistics for batch monitoring.
          </p>

          <div className="landing-card-grid">
            <div className="glass-panel landing-card" style={{ padding: '20px' }}>
              <TrendingUp size={28} style={{ color: 'var(--purple)', marginBottom: '10px' }} />
              <h3 style={{ fontSize: '1.5rem', fontWeight: 700 }}>{statsLoading ? '...' : `${stats.averageCTC} LPA`}</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '5px' }}>Average CTC Offered</p>
            </div>
            <div className="glass-panel landing-card" style={{ padding: '20px' }}>
              <Award size={28} style={{ color: 'var(--amber)', marginBottom: '10px' }} />
              <h3 style={{ fontSize: '1.5rem', fontWeight: 700 }}>{statsLoading ? '...' : `${stats.highestCTC} LPA`}</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '5px' }}>Highest Package</p>
            </div>
            <div className="glass-panel landing-card" style={{ padding: '20px' }}>
              <Users size={28} style={{ color: 'var(--blue)', marginBottom: '10px' }} />
              <h3 style={{ fontSize: '1.5rem', fontWeight: 700 }}>{statsLoading ? '...' : `${stats.totalPlaced} Placed`}</h3>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: '5px' }}>Placed Students Count</p>
            </div>
          </div>

          <button
            className="glass-btn-primary hero-cta-btn"
            onClick={() => setCurrentPage('dashboard')}
            style={{ padding: '16px 36px', fontSize: '1.1rem', borderRadius: '16px', marginBottom: '30px' }}
          >
            Enter Monitoring Portal
            <ArrowRight size={20} />
          </button>

          <div className="visitor-badge-container">
            <div className="glass-panel visitor-badge" style={{ padding: '10px 20px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: '#34d399', boxShadow: '0 0 8px #34d399', flexShrink: 0 }}></span>
              <span>Today's Visitors: <strong style={{ color: 'var(--text-color)' }}>{statsLoading ? '...' : stats.dailyVisitors}</strong></span>
            </div>
            <div className="glass-panel visitor-badge" style={{ padding: '10px 20px', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>Total Visitors: <strong style={{ color: 'var(--text-color)' }}>{statsLoading ? '...' : stats.totalVisitors}</strong></span>
            </div>
          </div>
        </div>
      ) : (
        <div className="app-container">
          {/* Mobile Top Navigation Bar */}
          <div className="mobile-header">
            <button
              className="mobile-menu-btn"
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              aria-label="Toggle navigation menu"
            >
              {mobileMenuOpen ? <X size={24} /> : <Menu size={24} />}
            </button>
            <div
              className="mobile-header-brand"
              onClick={() => {
                setCurrentPage('home');
                setMobileMenuOpen(false);
              }}
            >
              <img
                src="/logo.svg"
                alt="PICT Placement Monitoring"
                style={{ maxHeight: '36px', width: 'auto', objectFit: 'contain' }}
              />
            </div>
            <div style={{ width: '40px' }} /> {/* Spacer for symmetry */}
          </div>

          {/* Backdrop for Mobile Drawer */}
          {mobileMenuOpen && (
            <div
              className="mobile-backdrop"
              onClick={() => setMobileMenuOpen(false)}
            />
          )}

          <div className={`sidebar ${mobileMenuOpen ? 'open' : ''}`}>
            <div
              className="sidebar-header-row"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: '28px'
              }}
            >
              <div
                className="sidebar-title"
                onClick={() => {
                  setCurrentPage('home');
                  setMobileMenuOpen(false);
                }}
                style={{
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  marginBottom: '0',
                  padding: '6px 10px',
                  borderRadius: '14px',
                  background: 'transparent',
                  transition: 'all 0.2s ease'
                }}
                title="Back to Home"
              >
                <img
                  src="/logo.svg"
                  alt="PICT Placement Monitoring Logo"
                  style={{
                    maxHeight: '48px',
                    maxWidth: '100%',
                    width: 'auto',
                    objectFit: 'contain',
                    filter: 'drop-shadow(0 0 10px rgba(2, 204, 250, 0.3))'
                  }}
                />
              </div>
              <button
                className="sidebar-close-btn"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close menu"
              >
                <X size={20} />
              </button>
            </div>
            <div className="sidebar-menu">
              <button
                className={`sidebar-link ${activeTab === 'overview' ? 'active' : ''}`}
                onClick={() => handleNavClick('overview')}
              >
                <LayoutDashboard size={20} />
                Overview
              </button>
              <button
                className={`sidebar-link ${activeTab === 'companies' ? 'active' : ''}`}
                onClick={() => handleNavClick('companies')}
              >
                <Building2 size={20} />
                Companies Visited
              </button>
              <button
                className={`sidebar-link ${activeTab === 'students' ? 'active' : ''}`}
                onClick={() => handleNavClick('students')}
              >
                <Users size={20} />
                Students Placed
              </button>
              <button
                className={`sidebar-link ${activeTab === 'analytics' ? 'active' : ''}`}
                onClick={() => handleNavClick('analytics')}
              >
                <BarChart3 size={20} />
                Analytics Charts
              </button>
              <button
                className={`sidebar-link ${activeTab === 'contact' ? 'active' : ''}`}
                onClick={() => handleNavClick('contact')}
              >
                <MessageSquareWarning size={20} />
                Contact / Report
              </button>
            </div>
          </div>

          <main className="main-content">
            {renderContent()}
          </main>
        </div>
      )}
    </div>
  );
}

export default App;

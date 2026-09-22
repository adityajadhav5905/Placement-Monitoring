import React, { useState, useEffect } from 'react';
import { Download, Search, SlidersHorizontal, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

function Companies() {
  const [drives, setDrives] = useState([]);
  const [filteredDrives, setFilteredDrives] = useState([]);
  const [loading, setLoading] = useState(true);

  // Search & Filter States (Arranged in order of Columns: Date -> Company -> Role -> CTC -> Branches)
  const [searchCompany, setSearchCompany] = useState('');
  const [searchRole, setSearchRole] = useState('');
  const [minCTC, setMinCTC] = useState(0);
  const [maxCTC, setMaxCTC] = useState(60);
  const [selectedBranches, setSelectedBranches] = useState([]);

  // Sorting States
  const [sortField, setSortField] = useState('date'); // 'date' or 'ctc'
  const [sortDirection, setSortDirection] = useState('desc'); // 'asc' or 'desc'

  // Column Visibility States
  const [visibleCols, setVisibleCols] = useState({
    date: true,
    company: true,
    role: true,
    ctc: true,
    jd: true,
    el10: true,
    el12: true,
    elCgpa: true,
    elBack: true,
    placed: true
  });

  const [showColMenu, setShowColMenu] = useState(false);

  const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

  useEffect(() => {
    fetch(`${API_BASE}/companies`)
      .then(res => res.json())
      .then(data => {
        const list = Array.isArray(data) ? data : [];
        setDrives(list);
        setFilteredDrives(list);
        setLoading(false);
      })
      .catch(err => {
        console.error('Error fetching companies:', err);
        setDrives([]);
        setFilteredDrives([]);
        setLoading(false);
      });
  }, []);

  // Apply filters
  useEffect(() => {
    let result = drives;

    // Company search
    if (searchCompany.trim() !== '') {
      result = result.filter(d => d.company.toLowerCase().includes(searchCompany.toLowerCase()));
    }

    // Role search
    if (searchRole.trim() !== '') {
      result = result.filter(d => d.role.toLowerCase().includes(searchRole.toLowerCase()));
    }

    // CTC Range filters (CTC >= minCTC AND CTC <= maxCTC)
    result = result.filter(d => Number(d.ctc) >= minCTC && Number(d.ctc) <= maxCTC);

    // Multi-select Branches
    if (selectedBranches.length > 0) {
      result = result.filter(d => {
        const eligibleList = (d.eligible_branches || '').split(',').map(b => b.trim());
        return selectedBranches.some(b => eligibleList.includes(b));
      });
    }

    setFilteredDrives(result);
  }, [searchCompany, searchRole, minCTC, maxCTC, selectedBranches, drives]);

  // Sort logic
  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const getSortedDrives = () => {
    return [...filteredDrives].sort((a, b) => {
      let valA = a[sortField];
      let valB = b[sortField];

      if (sortField === 'date') {
        valA = valA ? new Date(valA).getTime() : 0;
        valB = valB ? new Date(valB).getTime() : 0;
      } else {
        valA = valA ? Number(valA) : 0;
        valB = valB ? Number(valB) : 0;
      }

      return sortDirection === 'asc' ? valA - valB : valB - valA;
    });
  };

  // CSV export
  const downloadCSV = () => {
    const headers = [];
    if (visibleCols.date) headers.push('Date');
    if (visibleCols.company) headers.push('Company');
    if (visibleCols.role) headers.push('Role');
    if (visibleCols.ctc) headers.push('CTC (LPA)');
    if (visibleCols.jd) headers.push('JD Link');
    if (visibleCols.el10) headers.push('Eligibility 10th');
    if (visibleCols.el12) headers.push('Eligibility 12th');
    if (visibleCols.elCgpa) headers.push('Eligibility CGPA');
    if (visibleCols.elBack) headers.push('Eligibility Backlog');
    if (visibleCols.placed) headers.push('Students Placed');

    const csvRows = [headers.join(',')];

    getSortedDrives().forEach(d => {
      const values = [];
      const formattedDate = d.date ? new Date(d.date).toISOString().split('T')[0] : '';

      if (visibleCols.date) values.push(`"${formattedDate}"`);
      if (visibleCols.company) values.push(`"${d.company || ''}"`);
      if (visibleCols.role) values.push(`"${d.role || ''}"`);
      if (visibleCols.ctc) values.push(d.ctc || 0);
      if (visibleCols.jd) values.push(`"${d.jd_link || ''}"`);
      if (visibleCols.el10) values.push(d.eligibility_10th || 50);
      if (visibleCols.el12) values.push(d.eligibility_12th || 50);
      if (visibleCols.elCgpa) values.push(d.eligibility_cgpa || 6.0);
      if (visibleCols.elBack) values.push(`"${d.eligibility_backlog || ''}"`);
      if (visibleCols.placed) values.push(d.students_placed || 0);

      csvRows.push(values.join(','));
    });

    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'companies_visited.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const toggleColumn = (col) => {
    setVisibleCols(prev => ({ ...prev, [col]: !prev[col] }));
  };

  const handleBranchToggle = (branch) => {
    setSelectedBranches(prev =>
      prev.includes(branch) ? prev.filter(b => b !== branch) : [...prev, branch]
    );
  };

  const handleResetFilters = () => {
    setSearchCompany('');
    setSearchRole('');
    setMinCTC(0);
    setMaxCTC(60);
    setSelectedBranches([]);
  };

  const renderSortIcon = (field) => {
    if (sortField !== field) return <ArrowUpDown size={14} style={{ marginLeft: '5px', opacity: 0.4 }} />;
    return sortDirection === 'asc'
      ? <ArrowUp size={14} style={{ marginLeft: '5px', color: 'var(--purple)' }} />
      : <ArrowDown size={14} style={{ marginLeft: '5px', color: 'var(--purple)' }} />;
  };

  const allBranches = ['AIDS', 'CE', 'ECE', 'ENTC', 'IT'];
  const sortedDrives = getSortedDrives();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh', fontSize: '1.2rem', color: 'var(--blue)' }}>
        Loading companies visited...
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(1.5rem, 5vw, 2rem)', fontWeight: 700, marginBottom: '5px' }}>Companies Visited</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.92rem' }}>Analyze campus hiring drives and eligibility criteria</p>
        </div>
        <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
          <button className="glass-btn" onClick={() => setShowColMenu(!showColMenu)} style={{ padding: '10px 18px', fontSize: '0.9rem' }}>
            <SlidersHorizontal size={16} />
            Columns
          </button>
          <button className="glass-btn-primary" onClick={downloadCSV} style={{ padding: '10px 20px', fontSize: '0.9rem' }}>
            <Download size={16} />
            Export CSV
          </button>
        </div>
      </div>

      {/* Column visibility menu */}
      {showColMenu && (
        <div className="glass-panel" style={{ marginBottom: '20px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(135px, 1fr))', gap: '10px', padding: '16px' }}>
          {Object.entries({
            date: 'Date',
            company: 'Company',
            role: 'Role',
            ctc: 'CTC',
            jd: 'JD Link',
            el10: '10th Eligibility',
            el12: '12th Eligibility',
            elCgpa: 'CGPA Eligibility',
            elBack: 'Backlogs',
            placed: 'Students Placed'
          }).map(([key, label]) => (
            <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '0.82rem', userSelect: 'none' }}>
              <input
                type="checkbox"
                className="nm-checkbox"
                checked={visibleCols[key]}
                onChange={() => toggleColumn(key)}
              />
              {label}
            </label>
          ))}
        </div>
      )}

      {/* Filters (Arranged in order of Columns: Date -> Company -> Role -> CTC -> Branches) */}
      <div className="glass-panel" style={{ marginBottom: '25px', padding: '20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '20px' }}>
          {/* Company Search */}
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>Company</label>
            <div style={{ position: 'relative' }}>
              <Search size={16} style={{ position: 'absolute', left: '15px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                className="glass-input"
                placeholder="Search company..."
                value={searchCompany}
                onChange={(e) => setSearchCompany(e.target.value)}
                style={{ paddingLeft: '40px' }}
              />
            </div>
          </div>

          {/* Role Search */}
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>Role</label>
            <div style={{ position: 'relative' }}>
              <Search size={16} style={{ position: 'absolute', left: '15px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                className="glass-input"
                placeholder="Search role..."
                value={searchRole}
                onChange={(e) => setSearchRole(e.target.value)}
                style={{ paddingLeft: '40px' }}
              />
            </div>
          </div>

          {/* Min CTC Range Slider */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px' }}>
              <span>Minimum CTC</span>
              <span style={{ color: 'var(--purple)' }}>{minCTC} LPA</span>
            </div>
            <input
              type="range"
              min="0"
              max="60"
              className="glass-slider"
              value={minCTC}
              onChange={(e) => setMinCTC(Number(e.target.value))}
            />
          </div>

          {/* Max CTC Range Slider */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '8px' }}>
              <span>Maximum CTC</span>
              <span style={{ color: 'var(--blue)' }}>{maxCTC} LPA</span>
            </div>
            <input
              type="range"
              min="0"
              max="60"
              className="glass-slider"
              value={maxCTC}
              onChange={(e) => setMaxCTC(Number(e.target.value))}
            />
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '18px' }}>
          {/* Eligibility Branches checklist */}
          <div style={{ flex: '1 1 240px' }}>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>Eligible Departments</label>
            <div className="multi-select-container">
              {allBranches.map(branch => (
                <div
                  key={branch}
                  className={`check-tag ${selectedBranches.includes(branch) ? 'active' : ''}`}
                  onClick={() => handleBranchToggle(branch)}
                >
                  {branch}
                </div>
              ))}
            </div>
          </div>

          {/* Permanent Reset button */}
          <div style={{ display: 'flex', alignItems: 'flex-end', paddingTop: '4px' }}>
            <button className="glass-btn" onClick={handleResetFilters} style={{ padding: '8px 18px', fontSize: '0.85rem' }}>
              Reset Filters
            </button>
          </div>
        </div>
      </div>

      {/* Main Table */}
      <div className="table-container">
        <table className="nm-table">
          <thead>
            <tr>
              {visibleCols.date && (
                <th className="sortable" onClick={() => handleSort('date')} style={{ whiteSpace: 'nowrap' }}>
                  Date {renderSortIcon('date')}
                </th>
              )}
              {visibleCols.company && <th>Company</th>}
              {visibleCols.role && <th>Role</th>}
              {visibleCols.ctc && (
                <th className="sortable" onClick={() => handleSort('ctc')} style={{ whiteSpace: 'nowrap' }}>
                  CTC {renderSortIcon('ctc')}
                </th>
              )}
              {visibleCols.jd && <th>JD Link</th>}
              {(visibleCols.el10 || visibleCols.el12 || visibleCols.elCgpa || visibleCols.elBack) && (
                <th style={{ textAlign: 'center' }}>
                  Eligibility
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', fontSize: '0.7rem', marginTop: '4px', color: 'var(--purple)' }}>
                    {visibleCols.el10 && <span>10th</span>}
                    {visibleCols.el12 && <span>12th</span>}
                    {visibleCols.elCgpa && <span>CGPA</span>}
                    {visibleCols.elBack && <span>Backlog</span>}
                  </div>
                </th>
              )}
              {visibleCols.placed && <th>Students Placed</th>}
            </tr>
          </thead>
          <tbody>
            {sortedDrives.length === 0 ? (
              <tr>
                <td colSpan={10} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '30px' }}>
                  No companies matching active filters found.
                </td>
              </tr>
            ) : (
              sortedDrives.map((d) => (
                <tr key={d.drive_id}>
                  {visibleCols.date && <td style={{ whiteSpace: 'nowrap' }}>{d.date ? new Date(d.date).toISOString().split('T')[0] : 'N/A'}</td>}
                  {visibleCols.company && <td style={{ fontWeight: 600, color: 'var(--purple)' }}>{d.company}</td>}
                  {visibleCols.role && <td>{d.role}</td>}
                  {visibleCols.ctc && <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{d.ctc} LPA</td>}
                  {visibleCols.jd && (
                    <td>
                      {d.jd_link ? (
                        <a href={d.jd_link} target="_blank" rel="noreferrer" className="pill pill-info" style={{ textDecoration: 'none' }}>
                          View JD
                        </a>
                      ) : (
                        'N/A'
                      )}
                    </td>
                  )}
                  {(visibleCols.el10 || visibleCols.el12 || visibleCols.elCgpa || visibleCols.elBack) && (
                    <td>
                      <div style={{ display: 'flex', justifyContent: 'center', gap: '10px', fontSize: '0.85rem' }}>
                        {visibleCols.el10 && <span>{d.eligibility_10th}%</span>}
                        {visibleCols.el12 && <span>{d.eligibility_12th}%</span>}
                        {visibleCols.elCgpa && <span style={{ color: 'var(--amber)', fontWeight: 600 }}>{d.eligibility_cgpa}</span>}
                        {visibleCols.elBack && <span style={{ fontSize: '0.75rem', maxWidth: '100px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={d.eligibility_backlog}>{d.eligibility_backlog || 'None'}</span>}
                      </div>
                    </td>
                  )}
                  {visibleCols.placed && (
                    <td>
                      <span className="pill pill-success" style={{ fontWeight: 600 }}>
                        {d.students_placed || 0}
                      </span>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default Companies;

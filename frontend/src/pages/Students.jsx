import React, { useState, useEffect } from 'react';
import { Download, Search, SlidersHorizontal, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

function Students() {
  const [students, setStudents] = useState([]);
  const [filteredStudents, setFilteredStudents] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filters and search states (Arranged in order of Columns: Student Name -> Department -> Company -> CTC)
  const [studentSearch, setStudentSearch] = useState('');
  const [selectedDepts, setSelectedDepts] = useState([]);
  const [companySearch, setCompanySearch] = useState('');
  const [minCTC, setMinCTC] = useState(0);
  const [maxCTC, setMaxCTC] = useState(60);

  // Sorting States
  const [sortField, setSortField] = useState('ctc'); // 'ctc'
  const [sortDirection, setSortDirection] = useState('desc'); // 'asc' or 'desc'

  // Column Visibility States
  const [visibleCols, setVisibleCols] = useState({
    name: true,
    department: true,
    company: true,
    role: true,
    ctc: true
  });

  const [showColMenu, setShowColMenu] = useState(false);

  const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000/api';

  useEffect(() => {
    fetch(`${API_BASE}/students`)
      .then(res => res.json())
      .then(data => {
        const list = Array.isArray(data) ? data : [];
        setStudents(list);
        setFilteredStudents(list);
        setLoading(false);
      })
      .catch(err => {
        console.error('Error fetching students:', err);
        setStudents([]);
        setFilteredStudents([]);
        setLoading(false);
      });
  }, []);

  // Apply filters
  useEffect(() => {
    let result = students;

    // Student Search (first name + last name)
    if (studentSearch.trim() !== '') {
      result = result.filter(s => {
        const fullName = s.student_name || `${s.student_first_name || ''} ${s.student_last_name || ''}`.trim();
        return fullName.toLowerCase().includes(studentSearch.toLowerCase());
      });
    }

    // Department Filter (Multi-select)
    if (selectedDepts.length > 0) {
      result = result.filter(s => selectedDepts.includes(s.department));
    }

    // Company Search
    if (companySearch.trim() !== '') {
      result = result.filter(s => s.company_placed.toLowerCase().includes(companySearch.toLowerCase()));
    }

    // CTC Range sliders: CTC >= minCTC AND CTC <= maxCTC
    result = result.filter(s => Number(s.ctc) >= minCTC && Number(s.ctc) <= maxCTC);

    setFilteredStudents(result);
  }, [studentSearch, selectedDepts, companySearch, minCTC, maxCTC, students]);

  // Sort logic
  const handleSort = (field) => {
    if (sortField === field) {
      setSortDirection(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  const getSortedStudents = () => {
    return [...filteredStudents].sort((a, b) => {
      let valA = Number(a[sortField]) || 0;
      let valB = Number(b[sortField]) || 0;

      return sortDirection === 'asc' ? valA - valB : valB - valA;
    });
  };

  // CSV download function
  const downloadCSV = () => {
    const headers = [];
    if (visibleCols.name) headers.push('Student Name');
    if (visibleCols.department) headers.push('Department');
    if (visibleCols.company) headers.push('Company Placed');
    if (visibleCols.role) headers.push('Role');
    if (visibleCols.ctc) headers.push('CTC (LPA)');

    const csvRows = [headers.join(',')];

    getSortedStudents().forEach(s => {
      const values = [];
      const fullName = s.student_name || `${s.student_first_name || ''} ${s.student_last_name || ''}`.trim();

      if (visibleCols.name) values.push(`"${fullName}"`);
      if (visibleCols.department) values.push(`"${s.department || ''}"`);
      if (visibleCols.company) values.push(`"${s.company_placed || ''}"`);
      if (visibleCols.role) values.push(`"${s.role || ''}"`);
      if (visibleCols.ctc) values.push(s.ctc || 0);

      csvRows.push(values.join(','));
    });

    const csvString = csvRows.join('\n');
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', 'students_placed.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const toggleColumn = (col) => {
    setVisibleCols(prev => ({ ...prev, [col]: !prev[col] }));
  };

  const handleDeptToggle = (dept) => {
    setSelectedDepts(prev =>
      prev.includes(dept) ? prev.filter(d => d !== dept) : [...prev, dept]
    );
  };

  const handleResetFilters = () => {
    setStudentSearch('');
    setSelectedDepts([]);
    setCompanySearch('');
    setMinCTC(0);
    setMaxCTC(60);
  };

  const renderSortIcon = (field) => {
    if (sortField !== field) return <ArrowUpDown size={14} style={{ marginLeft: '5px', opacity: 0.4 }} />;
    return sortDirection === 'asc'
      ? <ArrowUp size={14} style={{ marginLeft: '5px', color: 'var(--purple)' }} />
      : <ArrowDown size={14} style={{ marginLeft: '5px', color: 'var(--purple)' }} />;
  };

  const departments = ['AIDS', 'CE', 'ECE', 'ENTC', 'IT'];
  const sortedStudents = getSortedStudents();

  if (loading) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '80vh', fontSize: '1.2rem', color: 'var(--blue)' }}>
        Loading placed students...
      </div>
    );
  }

  return (
    <div className="fade-in">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px', marginBottom: '24px' }}>
        <div>
          <h1 style={{ fontSize: 'clamp(1.5rem, 5vw, 2rem)', fontWeight: 700, marginBottom: '5px' }}>Students Placed</h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.92rem' }}>Monitor successful student offers and placement details</p>
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
            name: 'Student Name',
            department: 'Department',
            company: 'Company Placed',
            role: 'Role',
            ctc: 'CTC'
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

      {/* Aligned Filters (Student Name -> Department -> Company -> CTC) */}
      <div className="glass-panel" style={{ marginBottom: '25px', padding: '20px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '16px', marginBottom: '20px' }}>
          {/* Student Search */}
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>Student Name</label>
            <div style={{ position: 'relative' }}>
              <Search size={16} style={{ position: 'absolute', left: '15px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                className="glass-input"
                placeholder="Search students..."
                value={studentSearch}
                onChange={(e) => setStudentSearch(e.target.value)}
                style={{ paddingLeft: '40px' }}
              />
            </div>
          </div>

          {/* Company Search */}
          <div>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>Company Placed</label>
            <div style={{ position: 'relative' }}>
              <Search size={16} style={{ position: 'absolute', left: '15px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                type="text"
                className="glass-input"
                placeholder="Search companies..."
                value={companySearch}
                onChange={(e) => setCompanySearch(e.target.value)}
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

        <div style={{ display: 'flex', borderTop: '1px solid rgba(255, 255, 255, 0.05)', paddingTop: '18px', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '16px' }}>
          {/* Department checkboxes tag list */}
          <div style={{ flex: '1 1 240px' }}>
            <label style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>Departments</label>
            <div className="multi-select-container">
              {departments.map(dept => (
                <div
                  key={dept}
                  className={`check-tag ${selectedDepts.includes(dept) ? 'active' : ''}`}
                  onClick={() => handleDeptToggle(dept)}
                >
                  {dept}
                </div>
              ))}
            </div>
          </div>

          {/* Permanent Reset filters button */}
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
              {visibleCols.name && <th>Student Name</th>}
              {visibleCols.department && <th>Department</th>}
              {visibleCols.company && <th>Company Placed</th>}
              {visibleCols.role && <th>Role Placed</th>}
              {visibleCols.ctc && (
                <th className="sortable" onClick={() => handleSort('ctc')}>
                  CTC {renderSortIcon('ctc')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {sortedStudents.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '30px' }}>
                  No students matched your search criteria.
                </td>
              </tr>
            ) : (
              sortedStudents.map((s) => (
                <tr key={s.student_id}>
                  {visibleCols.name && <td style={{ fontWeight: 600 }}>{s.student_name || `${s.student_first_name || ''} ${s.student_last_name || ''}`.trim() || 'N/A'}</td>}
                  {visibleCols.department && (
                    <td>
                      <span className="pill pill-info">{s.department}</span>
                    </td>
                  )}
                  {visibleCols.company && <td style={{ color: 'var(--purple)', fontWeight: 600 }}>{s.company_placed}</td>}
                  {visibleCols.role && <td>{s.role}</td>}
                  {visibleCols.ctc && <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{s.ctc} LPA</td>}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default Students;

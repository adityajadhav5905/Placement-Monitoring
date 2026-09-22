import React, { useState } from 'react';
import { Mail, AlertCircle, Send, CheckCircle2, MessageSquareWarning } from 'lucide-react';

function Contact() {
  const [email, setEmail] = useState('');
  const [inaccuracy, setInaccuracy] = useState('');
  const [status, setStatus] = useState('idle'); // 'idle' | 'submitting' | 'success' | 'error'
  const [errorMessage, setErrorMessage] = useState('');

  const FORMSPREE_ENDPOINT = 
    import.meta.env.VITE_FORMSPREE_ENDPOINT || 
    (import.meta.env.VITE_FORMSPREE_FORM_ID 
      ? `https://formspree.io/f/${import.meta.env.VITE_FORMSPREE_FORM_ID}`
      : 'https://formspree.io/f/xljrzdry');

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !inaccuracy.trim()) {
      setErrorMessage('Please fill in both your email address and the description of the inaccuracy.');
      setStatus('error');
      return;
    }

    setStatus('submitting');
    setErrorMessage('');

    try {
      const response = await fetch(FORMSPREE_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          email: email.trim(),
          inaccuracy: inaccuracy.trim(),
          submittedAt: new Date().toISOString()
        })
      });

      if (response.ok) {
        setStatus('success');
        setEmail('');
        setInaccuracy('');
      } else {
        const data = await response.json().catch(() => ({}));
        setStatus('error');
        setErrorMessage(
          data.error || 
          data.errors?.map(err => err.message).join(', ') || 
          'Unable to submit report. Please check your Formspree configuration in .env.'
        );
      }
    } catch (err) {
      console.error('Formspree submission error:', err);
      setStatus('error');
      setErrorMessage('Network error while sending report. Please check your internet connection.');
    }
  };

  return (
    <div className="fade-in" style={{ maxWidth: '800px', margin: '0 auto' }}>
      <div style={{ marginBottom: '24px' }}>
        <h1 style={{ fontSize: 'clamp(1.5rem, 5vw, 2rem)', fontWeight: 700, marginBottom: '6px' }}>Report Discrepancy / Contact Us</h1>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.92rem' }}>
          Help us maintain 100% data integrity across all placement drives, packages, and student offer records.
        </p>
      </div>

      <div className="glass-panel contact-panel">
        {status === 'success' ? (
          <div style={{ textAlign: 'center', padding: '20px 10px' }}>
            <div style={{ display: 'inline-flex', padding: '16px', borderRadius: '50%', background: 'rgba(52, 211, 153, 0.12)', border: '1px solid rgba(52, 211, 153, 0.3)', marginBottom: '16px' }}>
              <CheckCircle2 size={36} style={{ color: 'var(--emerald)' }} />
            </div>
            <h2 style={{ fontSize: 'clamp(1.2rem, 4vw, 1.6rem)', fontWeight: 700, marginBottom: '10px' }}>Report Submitted Successfully!</h2>
            <p style={{ color: 'var(--text-muted)', fontSize: '0.92rem', maxWidth: '480px', margin: '0 auto 20px auto', lineHeight: '1.6' }}>
              Thank you for reporting. Our placement cell moderators have received your message via Formspree and will review the discrepancy promptly.
            </p>
            <button
              className="glass-btn-primary"
              onClick={() => setStatus('idle')}
              style={{ padding: '12px 28px', fontSize: '0.95rem' }}
            >
              Submit Another Report
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            {/* Notice header */}
            <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-start', padding: '14px 16px', borderRadius: '14px', background: 'rgba(251, 191, 36, 0.08)', border: '1px solid rgba(251, 191, 36, 0.2)' }}>
              <MessageSquareWarning size={20} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: '2px' }} />
              <div style={{ fontSize: '0.85rem', color: 'var(--text-color)', lineHeight: '1.5' }}>
                <strong style={{ color: 'var(--amber)' }}>Notice:</strong> If you spot an incorrect package, missing student name, outdated criteria, or duplicate drive, please let us know below.
              </div>
            </div>

            {status === 'error' && (
              <div style={{ display: 'flex', gap: '10px', alignItems: 'center', padding: '12px 16px', borderRadius: '12px', background: 'rgba(244, 63, 94, 0.1)', border: '1px solid rgba(244, 63, 94, 0.25)', color: 'var(--rose)', fontSize: '0.88rem' }}>
                <AlertCircle size={18} style={{ flexShrink: 0 }} />
                <span>{errorMessage || 'Failed to submit report. Please try again.'}</span>
              </div>
            )}

            {/* Email field */}
            <div>
              <label style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>
                Your Email Address <span style={{ color: 'var(--rose)' }}>*</span>
              </label>
              <div style={{ position: 'relative' }}>
                <Mail size={18} style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  type="email"
                  required
                  className="glass-input"
                  placeholder="e.g. yourname@pict.edu or personal email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  style={{ paddingLeft: '44px' }}
                />
              </div>
            </div>

            {/* Inaccuracy Textarea */}
            <div>
              <label style={{ fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-muted)', display: 'block', marginBottom: '8px' }}>
                Inaccuracy Details <span style={{ color: 'var(--rose)' }}>*</span>
              </label>
              <textarea
                required
                rows={5}
                className="glass-input"
                placeholder="Describe the discrepancy in detail (e.g. 'Company X visited on 2026-03-01 has CTC 12 LPA instead of 10 LPA' or 'Student John Doe in IT branch offer details need correction')..."
                value={inaccuracy}
                onChange={(e) => setInaccuracy(e.target.value)}
                style={{ resize: 'vertical', minHeight: '110px', lineHeight: '1.6' }}
              />
            </div>

            {/* Submit Button */}
            <div>
              <button
                type="submit"
                disabled={status === 'submitting'}
                className="glass-btn-primary"
                style={{
                  width: '100%',
                  justifyContent: 'center',
                  padding: '14px 28px',
                  fontSize: '0.98rem',
                  borderRadius: '12px',
                  opacity: status === 'submitting' ? 0.7 : 1,
                  cursor: status === 'submitting' ? 'not-allowed' : 'pointer'
                }}
              >
                {status === 'submitting' ? (
                  'Submitting Report...'
                ) : (
                  <>
                    <Send size={18} />
                    Submit Discrepancy Report
                  </>
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

export default Contact;

/**
 * PaymentGate — x402 payment modal (Flow A)
 *
 * Click "Pay with HashPack" → HashPack extension popup opens → user approves → done.
 * Uses window.ethereum (HashPack EVM provider) via ethers.js.
 * No polling, no copy-paste, no memos.
 */
import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useHashPack, RECEIVER_ID, HBAR_AMOUNT } from '../hooks/useHashPack';

export function PaymentGate({ url, onPaid, onClose }) {
  const { hasWallet, paying, error: walletError, payAndFetch } = useHashPack();

  const [step,       setStep]       = useState('idle');   // idle | paying | success | error
  const [errMsg,     setErrMsg]     = useState('');
  const [detecting, setDetecting] = useState(true);

  // Give EIP-6963 detection 700ms before showing "not detected"
  useEffect(() => {
    const t = setTimeout(() => setDetecting(false), 700);
    return () => clearTimeout(t);
  }, []);

  async function handlePay() {
    setStep('paying');
    setErrMsg('');
    try {
      const res = await payAndFetch(url);
      if (!res.ok) throw new Error(`Oracle returned ${res.status} after payment`);
      setStep('success');
      onPaid(res);
    } catch (err) {
      // User rejected the transaction in HashPack
      if (err.code === 4001 || err.message?.includes('rejected') || err.message?.includes('denied')) {
        setStep('idle');
        setErrMsg('Transaction rejected in HashPack.');
      } else {
        setStep('error');
        setErrMsg(err.message || 'Payment failed');
      }
    }
  }

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
        onClick={e => e.target === e.currentTarget && step !== 'paying' && onClose()}
      >
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 8 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0 }}
          transition={{ type: 'spring', duration: 0.28 }}
          className="w-[380px] rounded-2xl shadow-2xl overflow-hidden"
          style={{ background: '#0d1420', border: '1px solid rgba(255,255,255,0.08)' }}
        >
          {/* Header */}
          <div className="px-6 pt-5 pb-4" style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center text-lg"
                  style={{ background: 'rgba(0,186,173,0.12)', border: '1px solid rgba(0,186,173,0.25)' }}>
                  ℏ
                </div>
                <div>
                  <div className="text-white font-semibold text-sm">Download Report</div>
                  <div className="text-gray-500 text-xs">x402 · Hedera Testnet</div>
                </div>
              </div>
              {step !== 'paying' && (
                <button onClick={onClose} className="text-gray-600 hover:text-gray-400 transition-colors p-1">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                </button>
              )}
            </div>
          </div>

          <div className="px-6 py-5 space-y-4">
            {/* Amount */}
            <div className="rounded-xl py-5 text-center"
              style={{ background: 'rgba(0,186,173,0.06)', border: '1px solid rgba(0,186,173,0.14)' }}>
              <div className="text-4xl font-black text-white tracking-tight">
                {HBAR_AMOUNT} <span style={{ color: '#00BAAD' }}>ℏ</span>
              </div>
              <div className="text-xs text-gray-600 mt-1.5">≈ $0.001 USD · one-time access</div>
              <div className="text-xs text-gray-700 font-mono mt-1">→ {RECEIVER_ID}</div>
            </div>

            {/* Idle — show pay button */}
            {step === 'idle' && (
              <div className="space-y-3">
                {detecting ? (
                  <div className="flex items-center justify-center gap-2 py-3 text-gray-500 text-sm">
                    <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/>
                      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                    Detecting wallet…
                  </div>
                ) : !hasWallet ? (
                  <div className="rounded-xl p-4"
                    style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.15)' }}>
                    <p className="text-red-400 text-sm font-medium mb-1">HashPack not detected</p>
                    <p className="text-gray-500 text-xs leading-relaxed mb-2">
                      MetaMask and Phantom cannot pay HBAR. Install the HashPack extension to continue.
                    </p>
                    <a href="https://www.hashpack.app/download" target="_blank" rel="noreferrer"
                      className="text-xs text-[#00BAAD] hover:text-white underline transition-colors">
                      Install HashPack ↗
                    </a>
                  </div>
                ) : (
                  <>
                    <button onClick={handlePay}
                      className="w-full py-3.5 rounded-xl font-bold text-sm transition-all hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2.5"
                      style={{ background: 'linear-gradient(135deg, #00BAAD 0%, #0284c7 100%)', color: '#fff' }}>
                      {/* HashPack-style icon */}
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
                      </svg>
                      Pay with HashPack
                    </button>
                    <p className="text-[11px] text-gray-600 text-center">
                      HashPack will open to confirm the transaction
                    </p>
                  </>
                )}

                {errMsg && (
                  <p className="text-xs text-amber-400 text-center">{errMsg}</p>
                )}
              </div>
            )}

            {/* Paying — waiting for HashPack approval */}
            {step === 'paying' && (
              <div className="flex flex-col items-center gap-3 py-4">
                <svg className="w-10 h-10 animate-spin" style={{ color: '#00BAAD' }} fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"/>
                  <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
                <div className="text-center">
                  <div className="text-gray-200 text-sm font-medium">Waiting for HashPack…</div>
                  <div className="text-gray-600 text-xs mt-0.5">Approve the transaction in your extension</div>
                </div>
              </div>
            )}

            {/* Success */}
            {step === 'success' && (
              <div className="flex flex-col items-center gap-3 py-4">
                <div className="w-12 h-12 rounded-full flex items-center justify-center"
                  style={{ background: 'rgba(21,128,61,0.15)', border: '1px solid rgba(21,128,61,0.3)' }}>
                  <svg className="w-6 h-6 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M5 13l4 4L19 7"/>
                  </svg>
                </div>
                <div className="text-green-400 font-semibold text-sm">Payment confirmed on Hedera</div>
                <div className="text-gray-500 text-xs">Generating your report…</div>
              </div>
            )}

            {/* Error */}
            {step === 'error' && (
              <div className="space-y-3">
                <div className="rounded-xl p-3"
                  style={{ background: 'rgba(239,68,68,0.07)', border: '1px solid rgba(239,68,68,0.18)' }}>
                  <div className="text-red-400 text-xs font-semibold mb-1">Payment failed</div>
                  <div className="text-red-400/70 text-xs leading-relaxed">{errMsg}</div>
                </div>
                <button onClick={() => { setStep('idle'); setErrMsg(''); }}
                  className="w-full py-2.5 rounded-xl text-sm font-medium transition-all hover:scale-[1.02]"
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)', color: '#9ca3af' }}>
                  Try again
                </button>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="px-6 pb-4 text-center">
            <a href={`https://hashscan.io/testnet/account/${RECEIVER_ID}`}
              target="_blank" rel="noreferrer"
              className="text-[11px] text-gray-700 hover:text-gray-500 transition-colors">
              View receiving account on Hashscan ↗
            </a>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

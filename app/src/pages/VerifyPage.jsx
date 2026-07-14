import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';

export default function VerifyPage() {
  const { hash } = useParams();
  const navigate = useNavigate();
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!hash) return;
    fetch(`/oracle/verify/${encodeURIComponent(hash)}`)
      .then(r => r.json())
      .then(data => { setResult(data); setLoading(false); })
      .catch(() => { setResult({ valid: false, reason: 'Could not reach ZoneProof oracle.' }); setLoading(false); });
  }, [hash]);

  return (
    <div className="min-h-screen bg-[#080808] flex flex-col items-center justify-center px-4">
      {/* Logo */}
      <div className="mb-8 text-center">
        <div className="text-2xl font-bold text-white tracking-tight">Zone<span className="text-teal-400">Proof</span></div>
        <div className="text-xs text-slate-500 mt-1">Report Authenticity Verification</div>
      </div>

      <div className="w-full max-w-lg bg-[#111] border border-slate-800 rounded-2xl overflow-hidden">

        {/* Status bar */}
        <div className={`h-1.5 w-full ${loading ? 'bg-slate-700' : result?.valid ? 'bg-teal-400' : 'bg-red-500'}`} />

        <div className="p-8">
          {loading && (
            <div className="text-center py-8">
              <div className="w-8 h-8 border-2 border-teal-400 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <p className="text-slate-400 text-sm">Verifying report signature…</p>
            </div>
          )}

          {!loading && result && (
            <>
              {/* Status badge */}
              <div className={`flex items-center gap-3 p-4 rounded-xl mb-6 ${
                result.valid
                  ? 'bg-teal-950 border border-teal-800'
                  : 'bg-red-950 border border-red-800'
              }`}>
                <span className="text-2xl">{result.valid ? '✅' : '❌'}</span>
                <div>
                  <div className={`font-bold text-base ${result.valid ? 'text-teal-300' : 'text-red-300'}`}>
                    {result.valid ? 'Authentic ZoneProof Report' : 'Verification Failed'}
                  </div>
                  <div className="text-xs text-slate-400 mt-0.5">
                    {result.valid
                      ? 'ECDSA-signed by ZoneProof oracle · Logged on Hedera HCS · NFT receipt minted'
                      : result.reason || 'Signature does not match the ZoneProof oracle'}
                  </div>
                </div>
              </div>

              {result.valid && (
                <div className="space-y-3">
                  <Row label="Oracle address" value={result.oracle_address} mono highlight />
                  <Row label="Property PIN" value={result.pin} />
                  <Row label="Property" value={result.site_address} />
                  <Row label="Generated" value={result.generated_at?.replace('T', ' ').replace('Z', ' UTC')} />

                  <div className="pt-2 border-t border-slate-800">
                    <div className="text-xs text-slate-500 mb-1">REPORT HASH</div>
                    <div className="font-mono text-xs text-slate-300 break-all">{result.report_hash}</div>
                  </div>

                  {/* HCS Proof */}
                  {result.hcs_proof && (
                    <div className="pt-2 border-t border-slate-800">
                      <div className="text-xs text-teal-600 font-semibold uppercase tracking-wide mb-2">
                        Hedera Consensus Service Proof
                      </div>
                      <div className="bg-[#0a1a1a] border border-teal-900 rounded-lg p-3 space-y-1.5">
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">Topic</span>
                          <span className="text-teal-300 font-mono">{result.hcs_proof.topic_id}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">Sequence #</span>
                          <span className="text-teal-300 font-mono">{result.hcs_proof.sequence_number}</span>
                        </div>
                        {result.hcs_proof.hashscan && (
                          <a
                            href={result.hcs_proof.hashscan}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block text-xs text-teal-400 hover:text-teal-200 underline mt-1"
                          >
                            View on HashScan →
                          </a>
                        )}
                      </div>
                    </div>
                  )}

                  {/* HTS NFT Receipt */}
                  {result.nft_receipt && (
                    <div className="pt-2 border-t border-slate-800">
                      <div className="text-xs text-yellow-600 font-semibold uppercase tracking-wide mb-2">
                        ZPR NFT Receipt (HTS Token)
                      </div>
                      <div className="bg-[#1a1500] border border-yellow-900 rounded-lg p-3 space-y-1.5">
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">Token</span>
                          <span className="text-yellow-300 font-mono">{result.nft_receipt.token_id}</span>
                        </div>
                        <div className="flex justify-between text-xs">
                          <span className="text-slate-500">Serial #</span>
                          <span className="text-yellow-300 font-mono">{result.nft_receipt.serial}</span>
                        </div>
                        {result.nft_receipt.hashscan && (
                          <a
                            href={result.nft_receipt.hashscan}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="block text-xs text-yellow-400 hover:text-yellow-200 underline mt-1"
                          >
                            View NFT on HashScan →
                          </a>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!result.valid && (
                <div className="text-center py-4">
                  <p className="text-slate-500 text-sm">
                    This hash was not issued by the ZoneProof oracle, or the report has been tampered with.
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-8 py-4 border-t border-slate-800 flex items-center justify-between">
          <div className="text-xs text-slate-600">
            Signed · HCS logged · HTS minted · Hedera Testnet
          </div>
          <button
            onClick={() => navigate('/')}
            className="text-xs text-teal-400 hover:text-teal-300 transition-colors"
          >
            ← Back to map
          </button>
        </div>
      </div>

      <p className="mt-6 text-xs text-slate-700 max-w-sm text-center">
        Every ZoneProof report is signed with ECDSA, logged to Hedera HCS for
        tamper-proof timestamping, and minted as a ZPR NFT receipt on HTS — no smart contracts required.
      </p>
    </div>
  );
}

function Row({ label, value, mono, highlight }) {
  return (
    <div className="flex justify-between items-start gap-4">
      <div className="text-xs text-slate-500 uppercase tracking-wide shrink-0 pt-0.5">{label}</div>
      <div className={`text-sm text-right break-all ${
        highlight ? 'text-teal-300 font-semibold' :
        mono ? 'font-mono text-slate-300' : 'text-slate-300'
      }`}>
        {value || '—'}
      </div>
    </div>
  );
}
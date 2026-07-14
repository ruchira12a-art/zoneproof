import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';

const STEPS = [
  {
    num: '01',
    title: 'CRE Nodes Fetch Data',
    desc: "Three independent Chainlink CRE nodes pull rezoning petitions and parcel changes from Wake County's open data API every hour.",
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"
          d="M5 12h14M12 5l7 7-7 7" />
      </svg>
    ),
    color: '#0ea5e9',
  },
  {
    num: '02',
    title: 'BFT Consensus → Merkle Root',
    desc: 'Each node independently hashes the events into a SHA-256 Merkle tree. 2 of 3 nodes must agree on the same root before it is committed.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"
          d="M9 3H5a2 2 0 00-2 2v4m6-6h10a2 2 0 012 2v4M9 3v18m0 0h10a2 2 0 002-2V9M9 21H5a2 2 0 01-2-2V9m0 0h18" />
      </svg>
    ),
    color: '#6366f1',
  },
  {
    num: '03',
    title: 'Root Anchored on Hedera',
    desc: 'The consensus Merkle root (32 bytes) is written to RezoningOracle.sol on Hedera EVM. Each batch is forever on-chain and publicly verifiable.',
    icon: (
      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5"
          d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    ),
    color: '#22c55e',
  },
];

const FEATURES = [
  {
    icon: '⛓️',
    title: 'On-Chain Merkle Proof',
    desc: 'Every rezoning petition and parcel change is hashed into a cryptographic Merkle tree. The root is committed to Hedera EVM — tamper-proof and auditable by anyone.',
    color: '#6366f1',
  },
  {
    icon: '🔮',
    title: 'Chainlink CRE Oracle',
    desc: 'A decentralized oracle network of 3 nodes reaches BFT consensus on zoning data before writing to chain. No single point of failure or trust.',
    color: '#0ea5e9',
  },
  {
    icon: '🗺️',
    title: '434k Parcel Map',
    desc: 'Explore all 434,000 Wake County parcels rendered in real-time from Mapbox vector tiles. Click any parcel to see zoning history, owner, and assessed value.',
    color: '#22c55e',
  },
  {
    icon: '🤖',
    title: 'AI-Powered Search',
    desc: 'Ask in plain English: "Show me all N1 to B1 conversions" or "Find commercial rezoning near downtown Raleigh." AI maps the results to parcels on the map.',
    color: '#f59e0b',
  },
];

const TECH = [
  { name: 'Chainlink CRE', sub: 'Decentralized Oracle', color: '#375BD2' },
  { name: 'Hedera', sub: 'On-Chain Proof', color: '#00BAAD' },
  { name: 'Mapbox', sub: 'Vector Tile Map', color: '#0ea5e9' },
  { name: 'Wake County', sub: 'Live GIS Data', color: '#22c55e' },
  { name: 'Claude AI', sub: 'Zoning Assistant', color: '#a78bfa' },
  { name: 'ENS', sub: 'zoneproof.eth', color: '#f59e0b' },
];

const fadeUp = {
  hidden: { opacity: 0, y: 32 },
  show: { opacity: 1, y: 0 },
};

export default function Landing() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen bg-[#050a10] text-white overflow-x-hidden">

      {/* ── Navbar ── */}
      <nav className="fixed top-0 inset-x-0 z-50 flex items-center justify-between px-6 py-4"
        style={{ background: 'rgba(5,10,16,0.85)', backdropFilter: 'blur(16px)', borderBottom: '1px solid rgba(14,165,233,0.08)' }}>
        <div className="flex items-center">
          <img src="/zoneproof-wordmark.svg" alt="ZoneProof" className="h-10 w-auto" />
        </div>

        <div className="hidden md:flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold"
          style={{ background: 'rgba(14,165,233,0.1)', border: '1px solid rgba(14,165,233,0.2)', color: '#38bdf8' }}>
          <span className="w-1.5 h-1.5 bg-sky-400 rounded-full animate-pulse" />
          Live on Hedera
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate('/tech')}
            className="hidden md:block px-4 py-2 rounded-xl text-sm font-semibold text-sky-300 hover:text-white transition-colors"
            style={{ border: '1px solid rgba(14,165,233,0.25)' }}>
            How It Works
          </button>
          <button
            onClick={() => navigate('/map')}
            className="px-5 py-2 rounded-xl text-sm font-bold text-white transition-all hover:scale-105"
            style={{ background: 'linear-gradient(135deg, #0ea5e9, #6366f1)', boxShadow: '0 4px 20px rgba(14,165,233,0.4)' }}>
            Open Map →
          </button>
        </div>
      </nav>

      {/* ── Hero ── */}
      <section className="relative min-h-screen flex flex-col items-center justify-center pt-20 pb-16 px-6 overflow-hidden">
        {/* Grid */}
        <div className="absolute inset-0 bg-[linear-gradient(rgba(14,165,233,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(14,165,233,0.04)_1px,transparent_1px)] bg-[size:60px_60px] [mask-image:radial-gradient(ellipse_80%_80%_at_50%_40%,black,transparent)]" />
        {/* Glows */}
        <div className="absolute top-1/3 left-1/4 w-[600px] h-[600px] bg-sky-600/6 rounded-full blur-[140px] pointer-events-none" />
        <div className="absolute top-1/2 right-1/4 w-[400px] h-[400px] bg-indigo-600/8 rounded-full blur-[100px] pointer-events-none" />

        <div className="relative z-10 text-center max-w-5xl mx-auto">
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}
            className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full mb-8 text-xs font-semibold"
            style={{ background: 'rgba(14,165,233,0.1)', border: '1px solid rgba(14,165,233,0.25)', color: '#7dd3fc' }}>
            🏛️ Wake County, NC — Land Registry on Hedera
          </motion.div>

          {/* Heading */}
          <motion.h1
            initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.1 }}
            className="text-5xl md:text-7xl lg:text-8xl font-black leading-none mb-6">
            <span className="bg-gradient-to-br from-white via-sky-100 to-sky-200 bg-clip-text text-transparent">
              Decentralized
            </span>
            <br />
            <span className="bg-gradient-to-r from-sky-400 via-blue-400 to-indigo-400 bg-clip-text text-transparent">
              Land Registry.
            </span>
          </motion.h1>

          <motion.p
            initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, delay: 0.2 }}
            className="text-lg md:text-xl text-gray-400 max-w-2xl mx-auto mb-10 leading-relaxed">
            Every rezoning petition in Wake County, NC is hashed into a cryptographic Merkle tree
            and anchored on <span className="text-sky-400 font-semibold">Hedera</span> by a
            <span className="text-indigo-400 font-semibold"> Chainlink CRE</span> oracle network —
            tamper-proof and verifiable by anyone.
          </motion.p>

          {/* CTAs */}
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, delay: 0.35 }}
            className="flex flex-col sm:flex-row gap-3 justify-center mb-16">
            <button
              onClick={() => navigate('/map')}
              className="px-8 py-4 rounded-xl font-bold text-white text-base transition-all hover:scale-105 hover:shadow-2xl"
              style={{ background: 'linear-gradient(135deg, #0ea5e9, #6366f1)', boxShadow: '0 6px 30px rgba(14,165,233,0.4)' }}>
              Explore 434k Parcels →
            </button>
            <a
              href="https://hashscan.io/testnet/contract/0xf3f8945df31ac04c09312e9e472ba7415bf356b4"
              target="_blank" rel="noopener noreferrer"
              className="px-8 py-4 rounded-xl font-semibold text-gray-300 text-base border border-white/10 hover:bg-white/5 transition-all hover:scale-105">
              View on Hedera ↗
            </a>
          </motion.div>

          {/* Stats */}
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.6, delay: 0.5 }}
            className="grid grid-cols-3 gap-4 max-w-xl mx-auto">
            {[
              { value: '434k', label: 'Wake County Parcels' },
              { value: '3-node', label: 'CRE Oracle Network' },
              { value: '100%', label: 'On-Chain Verifiable' },
            ].map((s) => (
              <div key={s.label} className="text-center">
                <div className="text-2xl md:text-3xl font-black bg-gradient-to-r from-sky-400 to-indigo-400 bg-clip-text text-transparent">{s.value}</div>
                <div className="text-[11px] text-gray-500 mt-0.5">{s.label}</div>
              </div>
            ))}
          </motion.div>
        </div>

        {/* Scroll cue */}
        <motion.div
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.2 }}
          className="absolute bottom-8 left-1/2 -translate-x-1/2">
          <motion.div animate={{ y: [0, 8, 0] }} transition={{ repeat: Infinity, duration: 2 }}
            className="w-5 h-9 border-2 border-white/10 rounded-full flex justify-center pt-1.5">
            <div className="w-1 h-1.5 bg-sky-500 rounded-full" />
          </motion.div>
        </motion.div>
      </section>

      {/* ── How it works ── */}
      <section className="py-24 px-6 max-w-5xl mx-auto">
        <motion.div
          variants={fadeUp} initial="hidden" whileInView="show" viewport={{ once: true }}
          className="text-center mb-16">
          <div className="text-xs font-black uppercase tracking-widest text-sky-400 mb-3">How It Works</div>
          <h2 className="text-3xl md:text-4xl font-black text-white">
            From County GIS to On-Chain Proof
          </h2>
        </motion.div>

        <div className="grid md:grid-cols-3 gap-6">
          {STEPS.map((step, i) => (
            <motion.div
              key={step.num}
              variants={fadeUp} initial="hidden" whileInView="show" viewport={{ once: true }}
              transition={{ delay: i * 0.12 }}
              className="relative rounded-2xl p-6"
              style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid rgba(14,165,233,0.12)` }}>
              <div className="flex items-center gap-3 mb-4">
                <div className="text-3xl font-black tabular-nums" style={{ color: step.color, opacity: 0.25 }}>
                  {step.num}
                </div>
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: `rgba(${step.color === '#0ea5e9' ? '14,165,233' : step.color === '#6366f1' ? '99,102,241' : '34,197,94'},0.12)`, border: `1px solid ${step.color}40`, color: step.color }}>
                  {step.icon}
                </div>
              </div>
              <h3 className="text-white font-bold text-base mb-2">{step.title}</h3>
              <p className="text-gray-400 text-sm leading-relaxed">{step.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── Features ── */}
      <section className="py-16 px-6 max-w-5xl mx-auto">
        <motion.div
          variants={fadeUp} initial="hidden" whileInView="show" viewport={{ once: true }}
          className="text-center mb-12">
          <div className="text-xs font-black uppercase tracking-widest text-indigo-400 mb-3">Features</div>
          <h2 className="text-3xl md:text-4xl font-black text-white">Built for Real-World Verification</h2>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {FEATURES.map((f, i) => (
            <motion.div
              key={f.title}
              variants={fadeUp} initial="hidden" whileInView="show" viewport={{ once: true }}
              transition={{ delay: i * 0.08 }}
              whileHover={{ scale: 1.02, y: -2 }}
              className="rounded-2xl p-6 cursor-default"
              style={{ background: `rgba(${f.color === '#6366f1' ? '99,102,241' : f.color === '#0ea5e9' ? '14,165,233' : f.color === '#22c55e' ? '34,197,94' : '245,158,11'},0.06)`, border: `1px solid ${f.color}22` }}>
              <div className="text-3xl mb-3">{f.icon}</div>
              <h3 className="text-white font-bold text-base mb-2">{f.title}</h3>
              <p className="text-gray-400 text-sm leading-relaxed">{f.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── Tech stack ── */}
      <section className="py-16 px-6 max-w-5xl mx-auto">
        <motion.div
          variants={fadeUp} initial="hidden" whileInView="show" viewport={{ once: true }}
          className="text-center mb-10">
          <div className="text-xs font-black uppercase tracking-widest text-gray-500 mb-3">Tech Stack</div>
        </motion.div>
        <div className="flex flex-wrap justify-center gap-3">
          {TECH.map((t, i) => (
            <motion.div
              key={t.name}
              variants={fadeUp} initial="hidden" whileInView="show" viewport={{ once: true }}
              transition={{ delay: i * 0.06 }}
              className="px-5 py-3 rounded-2xl text-center"
              style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}>
              <div className="font-black text-sm" style={{ color: t.color }}>{t.name}</div>
              <div className="text-gray-600 text-[10px] mt-0.5">{t.sub}</div>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="py-24 px-6">
        <motion.div
          variants={fadeUp} initial="hidden" whileInView="show" viewport={{ once: true }}
          className="max-w-2xl mx-auto text-center rounded-3xl p-10"
          style={{ background: 'linear-gradient(135deg, rgba(14,165,233,0.08), rgba(99,102,241,0.08))', border: '1px solid rgba(14,165,233,0.2)' }}>
          <div className="text-4xl mb-4">🗺️</div>
          <h2 className="text-3xl font-black text-white mb-3">
            Explore the Map
          </h2>
          <p className="text-gray-400 mb-8">
            Navigate 434,000 Wake County parcels. Search by address or ask AI — every result is backed by on-chain data.
          </p>
          <button
            onClick={() => navigate('/map')}
            className="px-10 py-4 rounded-xl font-bold text-white text-base transition-all hover:scale-105"
            style={{ background: 'linear-gradient(135deg, #0ea5e9, #6366f1)', boxShadow: '0 6px 30px rgba(14,165,233,0.35)' }}>
            Open Interactive Map →
          </button>
        </motion.div>
      </section>

      {/* ── Footer ── */}
      <footer className="border-t border-white/5 py-8 px-6 text-center text-gray-600 text-xs">
        <div className="flex items-center justify-center gap-2 mb-2">
          <img src="/zoneproof-favicon.svg" alt="ZoneProof" className="w-5 h-5 opacity-40" />
        </div>
        <div>Powered by Chainlink CRE · Hedera · Wake County GIS</div>
        <div className="mt-1">
          <a href="https://hashscan.io/testnet/contract/0xf3f8945df31ac04c09312e9e472ba7415bf356b4"
            target="_blank" rel="noopener noreferrer"
            className="text-sky-600 hover:text-sky-400 transition-colors">
            Contract: 0xf3f8945...
          </a>
        </div>
      </footer>
    </div>
  );
}

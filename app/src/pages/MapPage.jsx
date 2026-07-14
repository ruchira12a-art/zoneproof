import { useState, useEffect, useRef, useCallback } from 'react';
import mapboxgl from 'mapbox-gl';
import { motion, AnimatePresence } from 'framer-motion';
import { PaymentGate } from '../components/PaymentGate';

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_TOKEN;
const TILESET_ID   = 'manojsrinivasa.wake-county-parcels';
const SOURCE_LAYER = 'parcels';
const API_BASE     = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000';

mapboxgl.accessToken = MAPBOX_TOKEN;

const MAP_STYLES = {
  dark:      { name: 'Dark',      url: 'mapbox://styles/mapbox/dark-v11' },
  satellite: { name: 'Satellite', url: 'mapbox://styles/mapbox/satellite-streets-v12' },
  streets:   { name: 'Streets',   url: 'mapbox://styles/mapbox/streets-v12' },
};

const PETITION_RE = /^[A-Z]{1,3}-\d{1,4}-\d{4}$/i;

function fmt(n)   { return n == null ? '—' : Number(n).toLocaleString(); }
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}
function shortHash(h) { return h ? `${h.slice(0, 6)}…${h.slice(-4)}` : '—'; }

// ── Zone code expansion ───────────────────────────────────────────────────────

const ZONE_BASE = {
  'R-1':  { name: 'Residential-1',            desc: 'Single-family residential. Minimum 1-acre lots. Very low-density, rural character.' },
  'R-2':  { name: 'Residential-2',            desc: 'Single-family residential. Minimum 20,000 sq ft lots. Low-density suburban.' },
  'R-4':  { name: 'Residential-4',            desc: 'Single-family residential. Minimum 8,000 sq ft lots. Low-medium density suburban.' },
  'R-6':  { name: 'Residential-6',            desc: 'Single-family residential. Minimum 6,000 sq ft lots. Medium-density urban neighborhoods.' },
  'R-10': { name: 'Residential-10',           desc: 'Single-family residential. Minimum 10,000 sq ft lots. Suburban scale.' },
  'R-15': { name: 'Residential-15',           desc: 'Single-family residential. Minimum 15,000 sq ft lots. Low-density suburban.' },
  'R-20': { name: 'Residential-20',           desc: 'Single-family residential. Minimum 20,000 sq ft lots. Large-lot suburban or semi-rural.' },
  'R-40': { name: 'Residential-40',           desc: 'Single-family residential. Minimum 40,000 sq ft lots. Rural or agricultural transition area.' },
  'RX':   { name: 'Residential Mixed Use',    desc: 'Medium-density residential (apartments, townhomes) with ground-floor retail or office in walkable neighborhoods.' },
  'NX':   { name: 'Neighborhood Mixed Use',   desc: 'Small-scale, pedestrian-friendly mix of retail, office, and housing suited to neighborhood streets and commercial nodes.' },
  'CX':   { name: 'Commercial Mixed Use',     desc: 'Full range of commercial, retail, entertainment, office, and residential uses. Supports walkable urban and suburban commercial centers.' },
  'OX':   { name: 'Office Mixed Use',         desc: 'Office parks and professional services with complementary residential, retail, and hospitality uses.' },
  'IX':   { name: 'Industrial Mixed Use',     desc: 'Light industrial, manufacturing, tech, and maker-space uses mixed with office and limited residential.' },
  'DX':   { name: 'Downtown Mixed Use',       desc: 'High-intensity urban mixed-use for the downtown core. Supports tall buildings, dense residential, retail, and civic uses.' },
  'TOD':  { name: 'Transit Overlay District', desc: 'Transit-oriented development corridor. Higher-density mixed-use within walking distance of bus rapid transit or rail stations.' },
  'PD':   { name: 'Planned Development',      desc: 'Custom zoning for master-planned developments. Conditions individually negotiated and recorded in a Development Agreement.' },
  'CMP':  { name: 'Campus',                   desc: 'Large institutional campus (university, hospital, corporate HQ) governed by an approved master plan rather than standard bulk standards.' },
  'O&I':  { name: 'Office & Institutional',   desc: 'Professional offices, government buildings, hospitals, educational institutions, and civic uses.' },
  'B-1':  { name: 'Neighborhood Business',    desc: 'Small-scale, neighborhood-serving retail and services (convenience stores, barber shops, small restaurants) along local streets.' },
  'B-2':  { name: 'Community Business',       desc: 'Community-scale retail, restaurants, personal services, and other auto-accessible commercial uses.' },
  'GC':   { name: 'General Commercial',       desc: 'Wide array of commercial uses including auto dealers, big-box retail, and service establishments with large parking needs.' },
  'OP':   { name: 'Office Park',              desc: 'Suburban office campus with low-rise buildings, surface or structured parking, and landscaped setbacks.' },
  'MF':   { name: 'Multi-Family Residential', desc: 'Apartment buildings and multi-family housing at medium to high density.' },
  'I-1':  { name: 'Industrial — Light',       desc: 'Light manufacturing, assembly, warehousing, research and development with limited off-site impacts.' },
  'I-2':  { name: 'Industrial — Heavy',       desc: 'Heavy manufacturing, processing, and storage with potentially significant off-site impacts (noise, traffic, emissions).' },
};

function expandZoneCode(raw) {
  if (!raw) return { name: 'Unknown', desc: '' };
  const c = raw.trim();

  // Exact match (e.g. 'R-10', 'O&I')
  if (ZONE_BASE[c]) return { code: c, ...ZONE_BASE[c] };

  // Strip trailing dash (CX- → CX)
  const stripped = c.replace(/-$/, '');
  if (ZONE_BASE[stripped]) return { code: c, ...ZONE_BASE[stripped] };

  // Tokenise on '-' and find longest base match
  const tokens = c.split('-');
  let baseKey = null, modTokens = [];

  for (let len = Math.min(tokens.length, 2); len >= 1; len--) {
    const candidate = tokens.slice(0, len).join('-');
    if (ZONE_BASE[candidate]) { baseKey = candidate; modTokens = tokens.slice(len); break; }
  }

  if (!baseKey) {
    return { code: c, name: c, desc: 'Zoning classification under the Raleigh Unified Development Ordinance (UDO). Consult the City of Raleigh Planning Department for full requirements.' };
  }

  const base = ZONE_BASE[baseKey];
  const modDesc = [];
  modTokens.forEach(m => {
    if (m === 'CU')       modDesc.push('Conditional Use — site-specific conditions negotiated and recorded with the city');
    else if (m === 'PL')  modDesc.push('Planned — subject to an approved master development plan');
    else if (m === 'UL')  modDesc.push('Urban Limited — compact urban-form standards; parking maximums enforced');
    else if (/^\d+$/.test(m)) modDesc.push(`Intensity Level ${m} — height and floor-area ratio capped at tier ${m}`);
  });

  return {
    code: c,
    name: `${base.name}${modTokens.length ? ` (${modTokens.join('-')})` : ''}`,
    desc: base.desc + (modDesc.length ? ' ' + modDesc.join('; ') + '.' : ''),
  };
}

const STATUS_COLORS = {
  'Approved':                     { bg: 'rgba(34,197,94,0.15)',  border: 'rgba(34,197,94,0.4)',  text: '#4ade80' },
  'Denied':                       { bg: 'rgba(239,68,68,0.15)',  border: 'rgba(239,68,68,0.4)',  text: '#f87171' },
  'Withdrawn':                    { bg: 'rgba(107,114,128,0.15)',border: 'rgba(107,114,128,0.4)',text: '#9ca3af' },
  'Active':                       { bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)', text: '#fbbf24' },
  'Pending City Council':         { bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)', text: '#fbbf24' },
  'Pending Planning Commission':  { bg: 'rgba(245,158,11,0.15)', border: 'rgba(245,158,11,0.4)', text: '#fbbf24' },
};
const DEFAULT_STATUS = { bg: 'rgba(99,102,241,0.15)', border: 'rgba(99,102,241,0.4)', text: '#a5b4fc' };

function StatusBadge({ status }) {
  const c = STATUS_COLORS[status] || DEFAULT_STATUS;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold"
      style={{ background: c.bg, border: `1px solid ${c.border}`, color: c.text }}>
      {status || 'Unknown'}
    </span>
  );
}

// ── Parcel History Panel ──────────────────────────────────────────────────────

function ParcelPanel({ pin, onClose, onParcelLoaded, mapRef }) {
  // Phase 1 — free data (loaded on mount, no payment)
  const [parcelData,  setParcelData]  = useState(null);   // basic parcel info
  const [peekData,    setPeekData]    = useState(null);   // petition count only
  // Phase 2 — paid data (loaded after payment)
  const [fullData,    setFullData]    = useState(null);   // complete history
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState('');
  const [downloading, setDownloading] = useState(false);
  const [paymentUrl,  setPaymentUrl]  = useState(null);

  const historyUrl = `/oracle/parcels/${encodeURIComponent(pin)}/history`;

  // Phase 1: load free preview in parallel
  useEffect(() => {
    if (!pin) return;
    setLoading(true);
    setError('');
    setParcelData(null);
    setPeekData(null);
    setFullData(null);

    Promise.all([
      fetch(`/oracle/parcels/${encodeURIComponent(pin)}`),
      fetch(`/oracle/parcels/${encodeURIComponent(pin)}/history/peek`),
    ]).then(async ([pr, pkr]) => {
      if (pr.status === 404) return;
      if (!pr.ok) throw new Error(`Oracle returned ${pr.status}`);
      const parcel = await pr.json();
      setParcelData(parcel);
      if (pkr.ok) {
        const peek = await pkr.json();
        setPeekData(peek);
        // Place Hedera badge on map immediately — no payment needed to show it
        onParcelLoaded?.({ on_chain_count: peek.on_chain_count, parcel: { pin } });
      }
    }).catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [pin]);

  // Phase 2: payment complete — reveal full data
  const onPaymentComplete = useCallback(async (paidRes) => {
    setPaymentUrl(null);
    try {
      const d = await paidRes.json();
      setFullData(d);
      onParcelLoaded?.(d);
    } catch {
      setError('Failed to parse response after payment');
    }
  }, [onParcelLoaded]);

  const downloadReport = async () => {
    if (!fullData || downloading) return;
    setDownloading(true);
    try {
      const jsPDFMod  = await import('jspdf');
      const jsPDF     = jsPDFMod.jsPDF || jsPDFMod.default;
      const atMod     = await import('jspdf-autotable');
      const autoTable = atMod.default || atMod;

      const doc = new jsPDF({ unit: 'pt', format: 'letter' });
      const PW = 612, PH = 792, M = 40, CW = 532;
      let y = 0;

      const parcel  = fullData.parcel;
      const history = fullData.rezoning_history || [];
      const onChain = fullData.on_chain_count   ?? 0;
      const total   = fullData.total_petitions  ?? 0;

      // Palette — all RGB triplets, spread with ...
      const NAVY_HDR  = [8, 20, 48];      // header background
      const TEAL      = [0, 186, 173];    // Hedera brand teal
      const NAVY      = [22, 35, 64];     // section title text
      const NAVY_TBL  = [15, 40, 90];     // table header bg
      const BLUE      = [37, 99, 200];    // petition numbers, links
      const BODY      = [22, 30, 46];     // main body text
      const LABEL     = [100, 116, 139];  // uppercase field labels
      const MUTED     = [148, 163, 184];  // footer / captions
      const RULE      = [214, 221, 232];  // divider lines
      const ROW_ALT   = [246, 249, 252];  // alt table rows
      const GREEN     = [21, 128, 61];    // approved / on-chain
      const RED       = [185, 28, 28];    // denied
      const GRAY      = [107, 114, 128];  // withdrawn / pending
      const GREEN_BG  = [236, 253, 245];  // hedera verified box
      const GREEN_BD  = [110, 231, 183];  // hedera box border

      // ── helpers ────────────────────────────────────────────────────────────
      const newPageIfNeeded = (needed) => {
        if (y + needed > PH - 44) { doc.addPage(); y = M; }
      };

      const secHeader = (title) => {
        newPageIfNeeded(50);
        doc.setFillColor(...TEAL);
        doc.rect(M, y, 4, 20, 'F');
        doc.setFillColor(...NAVY);
        doc.rect(M + 4, y, CW - 4, 20, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(9);
        doc.setTextColor(255, 255, 255);
        doc.text(title, M + 14, y + 13.5);
        y += 27;
      };

      const rule = () => {
        doc.setDrawColor(...RULE);
        doc.setLineWidth(0.5);
        doc.line(M, y, M + CW, y);
        y += 10;
      };

      // ── page 1 header band ─────────────────────────────────────────────────
      // Dark navy banner
      doc.setFillColor(...NAVY_HDR);
      doc.rect(0, 0, PW, 76, 'F');
      // Teal stripe below banner
      doc.setFillColor(...TEAL);
      doc.rect(0, 76, PW, 3, 'F');
      // Left teal accent pillar
      doc.setFillColor(...TEAL);
      doc.rect(0, 0, 5, 76, 'F');

      // Wordmark
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(22);
      doc.setTextColor(255, 255, 255);
      doc.text('ZONEPROOF', M, 36);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8.5);
      doc.setTextColor(...MUTED);
      doc.text('Decentralized Land Registry  |  Wake County, NC', M, 52);
      doc.text('Powered by Chainlink CRE  +  Hedera Hashgraph', M, 64);

      // Right: report label + date
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(...TEAL);
      doc.text('PARCEL DUE DILIGENCE REPORT', PW - M, 36, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...MUTED);
      const dateStr = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
      doc.text(dateStr, PW - M, 52, { align: 'right' });
      doc.text('ZoneProof · Verified Zoning Report', PW - M, 64, { align: 'right' });

      y = 90;

      // ── map image ──────────────────────────────────────────────────────────
      // Try canvas first (needs preserveDrawingBuffer: true + page reload)
      // Fall back to Mapbox Static Images API for a reliable render
      let mapImgData = null, mapImgType = 'JPEG';

      if (mapRef?.current) {
        try {
          const canvas = mapRef.current.getCanvas();
          const raw    = canvas.toDataURL('image/jpeg', 0.88);
          // A solid-black JPEG is tiny; a real map is >>30 KB (>40 000 base64 chars)
          if (raw.length > 40000) { mapImgData = raw; }
        } catch { /* will fall through to static API */ }

        if (!mapImgData) {
          try {
            const c = mapRef.current.getCenter();
            const z = Math.min(mapRef.current.getZoom(), 17).toFixed(1);
            const lng = c.lng.toFixed(6), lat = c.lat.toFixed(6);
            // Green pin-l marker at parcel centre
            const overlay = `pin-l-building+22c55e(${lng},${lat})`;
            const url = `https://api.mapbox.com/styles/v1/mapbox/dark-v11/static/${overlay}/${lng},${lat},${z}/640x320@2x?access_token=${MAPBOX_TOKEN}`;
            const res = await fetch(url);
            if (res.ok) {
              const blob = await res.blob();
              mapImgData = await new Promise((res2, rej) => {
                const r = new FileReader();
                r.onload = () => res2(r.result);
                r.onerror = rej;
                r.readAsDataURL(blob);
              });
              mapImgType = 'PNG';
            }
          } catch { /* no map image */ }
        }
      }

      if (mapImgData) {
        const imgH = 185;
        // Subtle shadow rect behind map
        doc.setFillColor(220, 227, 240);
        doc.rect(M + 2, y + 2, CW, imgH, 'F');
        // Map image
        doc.addImage(mapImgData, mapImgType, M, y, CW, imgH);
        // Green parcel-highlight border
        doc.setDrawColor(34, 197, 94);
        doc.setLineWidth(2);
        doc.rect(M, y, CW, imgH);
        y += imgH + 7;

        doc.setFont('helvetica', 'italic');
        doc.setFontSize(8);
        doc.setTextColor(...MUTED);
        const addr = [parcel.site_address, parcel.city, parcel.zipcode].filter(Boolean).join(', ');
        doc.text(`Figure 1  |  PIN ${parcel.pin}  -  ${addr}`, PW / 2, y, { align: 'center' });
        y += 18;
      }

      // ── parcel information ─────────────────────────────────────────────────
      secHeader('PARCEL INFORMATION');

      const infoRows = [
        ['Parcel ID (PIN)',  parcel.pin],
        ['Site Address',     [parcel.site_address, parcel.city, parcel.zipcode].filter(Boolean).join(', ')],
        ['Recorded Owner',   parcel.owner],
        ['Assessed Value',   parcel.total_value_assd != null ? `$${fmt(parcel.total_value_assd)}` : null],
        ['Land Value',       parcel.land_val   != null ? `$${fmt(parcel.land_val)}`   : null],
        ['Building Value',   parcel.bldg_val   != null ? `$${fmt(parcel.bldg_val)}`   : null],
        ['Year Built',       parcel.year_built],
        ['Heated Area',      parcel.heated_area != null ? `${fmt(parcel.heated_area)} sq ft` : null],
        ['Lot Area',         parcel.calc_area   != null ? `${fmt(parcel.calc_area)} sq ft`   : null],
        ['Type & Use',       parcel.type_and_use],
        ['Land Class',       parcel.land_class],
      ].filter(([, v]) => v != null && v !== '');

      const colW = (CW - 16) / 2;
      const rowH = 27;
      const numRows = Math.ceil(infoRows.length / 2);
      newPageIfNeeded(numRows * rowH + 16);

      infoRows.forEach(([label, value], i) => {
        const col  = i % 2;
        const xB   = M + col * (colW + 16);
        const rowY = y + Math.floor(i / 2) * rowH;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.5);
        doc.setTextColor(...LABEL);
        doc.text(label.toUpperCase(), xB, rowY);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(9.5);
        doc.setTextColor(...BODY);
        const lines = doc.splitTextToSize(String(value), colW - 6);
        doc.text(lines.slice(0, 2), xB, rowY + 12);
      });

      y += numRows * rowH + 6;
      rule();

      // ── rezoning history table ─────────────────────────────────────────────
      newPageIfNeeded(120);
      secHeader(`REZONING HISTORY  |  ${total} petition${total !== 1 ? 's' : ''}  |  ${onChain} anchored on-chain`);

      // Note: jsPDF Helvetica only covers Latin-1 — use ASCII for arrow + check
      autoTable(doc, {
        startY:      y,
        head:        [['Petition #', 'Zoning Change', 'Status', 'Vote', 'Meeting', 'On-Chain']],
        body:        history.map(h => [
          h.petition_number || '-',
          `${h.current_zoning || '-'} -> ${h.proposed_zoning || '-'}`,
          h.status      || '-',
          h.vote_result || '-',
          h.meeting_date
            ? new Date(h.meeting_date).toLocaleDateString('en-US', { year: 'numeric', month: 'short' })
            : '-',
          h.committed_at
            ? `Batch #${h.evm_snapshot_index ?? '-'}`
            : 'Pending',
        ]),
        margin:      { left: M, right: M },
        tableWidth:  CW,
        styles: {
          fontSize: 8,
          cellPadding: { top: 5, right: 5, bottom: 5, left: 5 },
          lineColor: [...RULE],
          lineWidth: 0.4,
          textColor: [...BODY],
          font: 'helvetica',
        },
        headStyles: {
          fillColor: [...NAVY_TBL],
          textColor: [210, 230, 255],
          fontStyle: 'bold',
          fontSize: 7.5,
        },
        alternateRowStyles: { fillColor: [...ROW_ALT] },
        columnStyles: {
          0: { fontStyle: 'bold', textColor: [...BLUE], cellWidth: 72 },
          1: { cellWidth: 130, font: 'courier', fontSize: 7.5 },
          2: { cellWidth: 68 },
          3: { cellWidth: 60 },
          4: { cellWidth: 52 },
          5: { cellWidth: 'auto', fontStyle: 'bold' },
        },
        didParseCell: (d) => {
          if (d.section !== 'body') return;
          if (d.column.index === 5) {
            d.cell.styles.textColor = d.cell.raw === 'Pending' ? [...GRAY] : [...GREEN];
          }
          if (d.column.index === 2) {
            if (d.cell.raw === 'Approved')  d.cell.styles.textColor = [...GREEN];
            if (d.cell.raw === 'Denied')    d.cell.styles.textColor = [...RED];
            if (d.cell.raw === 'Withdrawn') d.cell.styles.textColor = [...GRAY];
          }
        },
      });

      y = (doc.lastAutoTable?.finalY ?? y) + 22;

      // ── zoning code definitions ────────────────────────────────────────────
      const allCodes = [...new Set(
        history.flatMap(h => [h.current_zoning, h.proposed_zoning].filter(Boolean))
      )];

      if (allCodes.length > 0) {
        newPageIfNeeded(80);
        secHeader('ZONING CODE DEFINITIONS');

        for (const code of allCodes) {
          const info = expandZoneCode(code);
          const descLines = doc.splitTextToSize(info.desc, CW - 24);
          const cardH = 14 + descLines.length * 11 + 10;
          newPageIfNeeded(cardH + 8);

          // Light card bg
          doc.setFillColor(246, 249, 252);
          doc.setDrawColor(...RULE);
          doc.setLineWidth(0.4);
          doc.rect(M, y, CW, cardH, 'FD');
          // Left accent
          doc.setFillColor(...TEAL);
          doc.rect(M, y, 3, cardH, 'F');

          // Code label in teal mono
          doc.setFont('courier', 'bold');
          doc.setFontSize(9.5);
          doc.setTextColor(0, 130, 120);
          doc.text(code, M + 10, y + 12);

          // Name in navy
          const codeW = doc.getTextWidth(code);
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(9.5);
          doc.setTextColor(...NAVY);
          doc.text(`  -  ${info.name}`, M + 10 + codeW, y + 12);

          // Description
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(...LABEL);
          doc.text(descLines, M + 14, y + 24);

          y += cardH + 7;
        }

        y += 4;
      }

      // ── hedera blockchain verification ────────────────────────────────────
      newPageIfNeeded(120);
      secHeader('HEDERA BLOCKCHAIN VERIFICATION');

      const isV   = onChain > 0;
      const boxH  = 52;
      doc.setFillColor(...(isV ? GREEN_BG : ROW_ALT));
      doc.setDrawColor(...(isV ? GREEN_BD : RULE));
      doc.setLineWidth(1.2);
      doc.rect(M, y, CW, boxH, 'FD');
      // Left status stripe
      doc.setFillColor(...(isV ? GREEN_BD : RULE));
      doc.rect(M, y, 4, boxH, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10.5);
      doc.setTextColor(...(isV ? GREEN : GRAY));
      doc.text(
        isV
          ? `${onChain} of ${total} petition${total !== 1 ? 's' : ''} cryptographically anchored on Hedera Hashgraph`
          : 'No petitions anchored on-chain yet',
        M + 14, y + 20
      );
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(...LABEL);
      doc.text(
        'Contract: 0xf3f8945df31ac04c09312e9e472ba7415bf356b4  |  Hedera Testnet (Chain ID 296)  |  3-node BFT Oracle',
        M + 14, y + 36
      );
      y += boxH + 18;

      // Network metadata row
      doc.setFillColor(246, 249, 252);
      doc.rect(M, y, CW, 24, 'F');
      const meta = [
        ['Network', 'Hedera Testnet'],
        ['Chain ID', '296'],
        ['Oracle', 'Chainlink CRE'],
        ['Consensus', 'Byzantine Fault Tolerant'],
      ];
      const metaColW = CW / meta.length;
      meta.forEach(([k, v], i) => {
        const xM = M + i * metaColW + 8;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.5);
        doc.setTextColor(...LABEL);
        doc.text(k.toUpperCase(), xM, y + 8);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.5);
        doc.setTextColor(...BODY);
        doc.text(v, xM, y + 19);
      });
      y += 32;

      const verified = history.filter(h => h.committed_at);
      if (verified.length > 0) {
        y += 4;
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(7.5);
        doc.setTextColor(...LABEL);
        doc.text('VERIFIED PETITIONS', M, y);
        y += 14;

        for (const h of verified) {
          newPageIfNeeded(60);

          // Petition row
          doc.setFillColor(236, 253, 245);
          doc.setDrawColor(...GREEN_BD);
          doc.setLineWidth(0.4);
          const petH = h.hedera_evm_tx_hash ? 52 : 34;
          doc.rect(M, y, CW, petH, 'FD');
          doc.setFillColor(...GREEN_BD);
          doc.rect(M, y, 3, petH, 'F');

          doc.setFont('courier', 'bold');
          doc.setFontSize(10);
          doc.setTextColor(0, 120, 100);
          doc.text(h.petition_number, M + 10, y + 13);

          const det = [
            h.evm_snapshot_index != null && `Batch #${h.evm_snapshot_index}`,
            h.hedera_evm_block && `Block ${fmt(h.hedera_evm_block)}`,
            h.committed_at && `Anchored ${fmtDate(h.committed_at)}`,
          ].filter(Boolean).join('   |   ');

          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(...BODY);
          doc.text(det, M + 90, y + 13);

          if (h.hedera_evm_tx_hash) {
            doc.setFont('courier', 'normal');
            doc.setFontSize(7);
            doc.setTextColor(...BLUE);
            doc.text(`TX  ${h.hedera_evm_tx_hash}`, M + 10, y + 27);
            doc.text(`    https://hashscan.io/testnet/transaction/${h.hedera_evm_tx_hash}`, M + 10, y + 39);
          }

          y += petH + 6;
        }
      }

      // ── ZoneProof authenticity seal ───────────────────────────────────────
      const seal = fullData.verification_seal;
      if (seal) {
        newPageIfNeeded(130);
        secHeader('ZONEPROOF AUTHENTICITY SEAL');

        const GOLD_BG = [254, 252, 232];
        const GOLD_BD = [253, 224, 71];
        const BOX_H   = 158;
        const QR_SIZE = 80;
        const TEXT_W  = CW - QR_SIZE - 28; // text column width

        doc.setFillColor(...GOLD_BG);
        doc.setDrawColor(...GOLD_BD);
        doc.setLineWidth(1.2);
        doc.rect(M, y, CW, BOX_H, 'FD');
        // left accent stripe
        doc.setFillColor(...GOLD_BD);
        doc.rect(M, y, 4, BOX_H, 'F');

        // "Issued by" title
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10.5);
        doc.setTextColor(133, 77, 14);
        doc.text('Issued by  ZoneProof Oracle', M + 14, y + 18);

        // Field rows — left text column
        const hcsLabel = seal.hcs_sequence != null
          ? `Seq #${seal.hcs_sequence} on ${seal.hcs_topic_id}`
          : 'pending';
        const nftLabel = seal.nft_serial != null
          ? `ZPR Serial #${seal.nft_serial} (${seal.nft_token_id})`
          : 'pending';
        const sealRows = [
          ['ORACLE',     seal.oracle_address],
          ['GENERATED',  seal.generated_at?.replace('T', ' ').replace('Z', ' UTC').slice(0, 22)],
          ['REPORT HASH',seal.report_hash],
          ['SIGNATURE',  (seal.oracle_signature || '').slice(0, 46) + '…'],
          ['HCS PROOF',  hcsLabel],
          ['ZPR NFT',    nftLabel],
        ];
        const rowStart = y + 32;
        sealRows.forEach(([k, v], i) => {
          const ry = rowStart + i * 18;
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(6.5);
          doc.setTextColor(133, 77, 14);
          doc.text(k, M + 14, ry);
          doc.setFont('courier', 'normal');
          doc.setFontSize(7);
          doc.setTextColor(22, 30, 46);
          doc.text(String(v || ''), M + 78, ry, { maxWidth: TEXT_W - 70 });
        });

        // QR code — right side of box
        const verifyUrl = `${window.location.origin}/verify/${seal.report_hash}`;
        const qrX = M + CW - QR_SIZE - 10;
        const qrY = y + (BOX_H - QR_SIZE) / 2;
        try {
          const QRCode = (await import('qrcode')).default;
          const qrDataUrl = await QRCode.toDataURL(verifyUrl, {
            width: 200, margin: 1,
            color: { dark: '#0f172a', light: '#fffce8' },
          });
          doc.addImage(qrDataUrl, 'PNG', qrX, qrY, QR_SIZE, QR_SIZE);
          // "Scan to verify" label
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(6);
          doc.setTextColor(133, 77, 14);
          doc.text('SCAN TO VERIFY', qrX + QR_SIZE / 2, qrY + QR_SIZE + 10, { align: 'center' });
        } catch (_) {
          // QR generation failed — show URL as fallback
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(6.5);
          doc.setTextColor(37, 99, 200);
          doc.text(verifyUrl, M + 14, y + BOX_H - 10, { maxWidth: CW - 20 });
        }

        y += BOX_H + 12;
      }

      // ── footer on every page ───────────────────────────────────────────────
      const totalPages = doc.getNumberOfPages();
      for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFillColor(8, 20, 48);
        doc.rect(0, PH - 28, PW, 28, 'F');
        doc.setFillColor(...TEAL);
        doc.rect(0, PH - 28, PW, 1.5, 'F');
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(...MUTED);
        doc.text('Generated by ZoneProof  |  Chainlink CRE + Hedera Hashgraph', M, PH - 10);
        doc.text(`Page ${p} / ${totalPages}`, PW - M, PH - 10, { align: 'right' });
      }

      doc.save(`ZoneProof-${pin}-Report.pdf`);
    } catch (err) {
      console.error('PDF generation failed:', err);
    } finally {
      setDownloading(false);
    }
  };

  // Derived
  const parcel      = fullData?.parcel || parcelData;
  const history     = fullData?.rezoning_history || [];
  const onChain     = fullData?.on_chain_count ?? 0;
  const total       = fullData?.total_petitions ?? peekData?.total_petitions ?? 0;
  const peekOnChain = peekData?.on_chain_count ?? 0;
  const isPaid      = fullData !== null;
  const hasHistory  = total > 0;

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* x402 Payment Gate modal */}
      {paymentUrl && (
        <PaymentGate url={paymentUrl} onPaid={onPaymentComplete} onClose={() => setPaymentUrl(null)} />
      )}

      {/* ── Header ── */}
      <div className="px-5 pt-5 pb-4 border-b flex-shrink-0"
        style={{ borderColor: 'rgba(14,165,233,0.15)' }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-bold uppercase tracking-widest text-sky-400 mb-0.5">Parcel Details</div>
            <div className="text-white font-black text-base leading-snug truncate">
              {loading ? 'Loading…' : parcel?.site_address || pin}
            </div>
            <div className="text-gray-500 text-xs mt-0.5 font-mono">{pin}</div>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5">
            {/* Download Report — locked until paid */}
            {isPaid ? (
              <button onClick={downloadReport} disabled={downloading}
                title="Download PDF Report"
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-all disabled:opacity-40 hover:scale-105 active:scale-95"
                style={{ background: 'rgba(0,186,173,0.15)', border: '1px solid rgba(0,186,173,0.35)', color: '#00BAAD' }}>
                {downloading
                  ? <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                    </svg>
                  : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                        d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
                    </svg>}
                <span>{downloading ? 'Generating…' : 'Download Report'}</span>
              </button>
            ) : (
              <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold opacity-40 select-none"
                style={{ border: '1px solid rgba(255,255,255,0.1)', color: '#9ca3af' }}>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                </svg>
                Report
              </div>
            )}
            <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors p-1">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-y-auto">

        {/* Loading */}
        {loading && (
          <div className="flex flex-col items-center justify-center h-40 gap-3">
            <div className="flex gap-1.5">
              {[0, 0.18, 0.36].map((d, i) => (
                <motion.div key={i} animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ repeat: Infinity, duration: 1.2, delay: d }}
                  className="w-2 h-2 rounded-full bg-sky-400" />
              ))}
            </div>
            <span className="text-gray-500 text-xs">Fetching parcel data…</span>
          </div>
        )}

        {/* Parcel not found */}
        {!parcelData && !loading && !error && (
          <div className="m-5 p-4 rounded-xl text-sm text-gray-400"
            style={{ background: 'rgba(148,163,184,0.07)', border: '1px solid rgba(148,163,184,0.15)' }}>
            <div className="font-semibold mb-1 text-gray-300">No data found</div>
            <div className="text-xs text-gray-500">This parcel has no recorded data in ZoneProof.</div>
          </div>
        )}

        {/* Error */}
        {error && !loading && (
          <div className="m-5 p-4 rounded-xl text-sm text-red-300"
            style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
            <div className="font-bold mb-1">Oracle API unreachable</div>
            <div className="text-xs text-red-400/80">{error}</div>
          </div>
        )}

        {/* ── Preview + locked sections (parcel loaded, not yet paid) ── */}
        {parcelData && !loading && !isPaid && (
          <>
            {/* FREE: 4 basic fields */}
            <div className="px-5 pt-4 pb-4">
              <div className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-3">
                Property Overview
              </div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                {[
                  { label: 'Owner',    value: parcel?.owner,    span: true },
                  { label: 'City',     value: parcel?.city },
                  { label: 'Zip',      value: parcel?.zipcode },
                  { label: 'Type',     value: parcel?.type_and_use, span: true },
                ].filter(r => r.value).map(({ label, value, span }) => (
                  <div key={label} className={span ? 'col-span-2' : ''}>
                    <div className="text-[10px] text-gray-600 mb-0.5">{label}</div>
                    <div className="text-gray-200 text-xs font-medium leading-snug">{value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mx-5 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }} />

            {/* LOCKED: Financial details (blurred) */}
            <div className="mx-5 my-4 rounded-xl overflow-hidden"
              style={{ border: '1px solid rgba(255,255,255,0.07)' }}>
              <div className="px-3 py-2 flex items-center gap-1.5"
                style={{ background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                <svg className="w-3 h-3 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                </svg>
                <span className="text-[10px] font-black uppercase tracking-widest text-gray-600">Financial Details</span>
                <span className="ml-auto text-[10px] text-gray-700">Unlock to reveal</span>
              </div>
              <div className="px-3 py-3 grid grid-cols-2 gap-x-5 gap-y-3"
                style={{ filter: 'blur(5px)', userSelect: 'none', pointerEvents: 'none' }}>
                {[
                  { label: 'Assessed Value', value: parcel?.total_value_assd ? `$${fmt(parcel.total_value_assd)}` : '$———' },
                  { label: 'Land Value',     value: parcel?.land_val ? `$${fmt(parcel.land_val)}` : '$———' },
                  { label: 'Year Built',     value: parcel?.year_built || '——' },
                  { label: 'Heated Area',    value: parcel?.heated_area ? `${fmt(parcel.heated_area)} sf` : '—— sf' },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div className="text-[10px] text-gray-600 mb-0.5">{label}</div>
                    <div className="text-gray-200 text-xs font-medium">{value}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* LOCKED: Rezoning history */}
            {!hasHistory ? (
              <div className="mx-5 mb-5 p-4 rounded-xl text-sm text-gray-400"
                style={{ background: 'rgba(148,163,184,0.07)', border: '1px solid rgba(148,163,184,0.15)' }}>
                <div className="font-semibold mb-1 text-gray-300">No rezoning history</div>
                <div className="text-xs text-gray-500">No rezoning petitions recorded for this parcel.</div>
              </div>
            ) : (
              <div className="mx-5 mb-5 rounded-2xl overflow-hidden"
                style={{ border: '1px solid rgba(0,186,173,0.2)', background: 'rgba(0,186,173,0.02)' }}>

                {/* Section label */}
                <div className="px-4 pt-3.5 pb-2 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <svg className="w-3.5 h-3.5 flex-shrink-0" style={{ color: '#00BAAD' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
                    </svg>
                    <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                      Rezoning History · {total} petition{total !== 1 ? 's' : ''}
                    </span>
                  </div>
                  {peekOnChain > 0 && (
                    <span className="text-[10px] font-bold text-green-400">{peekOnChain} on-chain</span>
                  )}
                </div>

                {/* Ghost cards — blurred */}
                <div className="relative px-4 pb-2" style={{ pointerEvents: 'none', userSelect: 'none' }}>
                  <div style={{ filter: 'blur(5px)', opacity: 0.55 }}>
                    {[0, 1].map(i => (
                      <div key={i} className="mb-2 rounded-xl p-3"
                        style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.07)' }}>
                        <div className="flex items-center justify-between mb-2">
                          <div className="h-3.5 w-24 rounded-full" style={{ background: 'rgba(56,189,248,0.35)' }} />
                          <div className="h-3.5 w-16 rounded-full" style={{ background: i === 0 ? 'rgba(34,197,94,0.35)' : 'rgba(249,115,22,0.35)' }} />
                        </div>
                        <div className="flex items-center gap-2 mb-2">
                          <div className="h-5 w-12 rounded" style={{ background: 'rgba(56,189,248,0.2)' }} />
                          <div className="w-3 h-2 rounded" style={{ background: 'rgba(100,116,139,0.3)' }} />
                          <div className="h-5 w-14 rounded" style={{ background: 'rgba(249,115,22,0.2)' }} />
                        </div>
                        <div className="h-2.5 w-36 rounded-full mb-1.5" style={{ background: 'rgba(100,116,139,0.25)' }} />
                        {i === 0 && peekOnChain > 0 && (
                          <div className="mt-2 rounded-lg p-2" style={{ background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.12)' }}>
                            <div className="h-2.5 w-20 rounded-full mb-1.5" style={{ background: 'rgba(34,197,94,0.3)' }} />
                            <div className="h-2 w-32 rounded-full" style={{ background: 'rgba(100,116,139,0.2)' }} />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                  {/* Gradient fade to CTA */}
                  <div className="absolute inset-x-0 bottom-0 h-16"
                    style={{ background: 'linear-gradient(to bottom, transparent, rgba(4,8,18,0.98))' }} />
                </div>

                {/* Pay CTA */}
                <div className="px-4 pb-4 flex flex-col items-center gap-2">
                  <button onClick={() => setPaymentUrl(historyUrl)}
                    className="w-full py-3 rounded-xl font-bold text-sm flex items-center justify-center gap-2 transition-all hover:scale-[1.02] active:scale-[0.98]"
                    style={{ background: 'linear-gradient(135deg, #00BAAD22, #0284c722)', border: '1px solid rgba(0,186,173,0.45)', color: '#00BAAD' }}>
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z"/>
                    </svg>
                    Pay 0.05 ℏ — Unlock Full History + Report
                  </button>
                  <div className="text-[11px] text-gray-600 text-center">
                    One-time · Hedera Testnet · Verified on-chain
                  </div>
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Full data view (paid) ── */}
        {parcelData && !loading && isPaid && (
          <>
            {/* Property info — all fields */}
            <div className="px-5 pt-4 pb-3">
              <div className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-3">Property Info</div>
              <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                {[
                  { label: 'Owner',        value: parcel?.owner,             span: true },
                  { label: 'City',         value: parcel?.city },
                  { label: 'Zip',          value: parcel?.zipcode },
                  { label: 'Assessed',     value: parcel?.total_value_assd ? `$${fmt(parcel.total_value_assd)}` : null },
                  { label: 'Land Value',   value: parcel?.land_val ? `$${fmt(parcel.land_val)}` : null },
                  { label: 'Year Built',   value: parcel?.year_built },
                  { label: 'Heated Area',  value: parcel?.heated_area ? `${fmt(parcel.heated_area)} sf` : null },
                  { label: 'Lot Area',     value: parcel?.calc_area ? `${fmt(parcel.calc_area)} sf` : null },
                  { label: 'Type',         value: parcel?.type_and_use, span: true },
                  { label: 'Land Class',   value: parcel?.land_class },
                ].filter(r => r.value).map(({ label, value, span }) => (
                  <div key={label} className={span ? 'col-span-2' : ''}>
                    <div className="text-[10px] text-gray-600 mb-0.5">{label}</div>
                    <div className="text-gray-200 text-xs font-medium leading-snug">{value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mx-5 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }} />

            {/* On-chain verification */}
            <div className="px-5 py-3">
              <div className="text-[10px] font-black uppercase tracking-widest text-gray-500 mb-2">On-Chain Verification</div>
              <div className="flex items-center gap-3 p-3 rounded-xl"
                style={{ background: onChain > 0 ? 'rgba(34,197,94,0.08)' : 'rgba(255,255,255,0.03)', border: onChain > 0 ? '1px solid rgba(34,197,94,0.2)' : '1px solid rgba(255,255,255,0.06)' }}>
                <div className="text-2xl flex-shrink-0">{onChain > 0 ? '✅' : '⏳'}</div>
                <div>
                  <div className="text-sm font-bold" style={{ color: onChain > 0 ? '#4ade80' : '#9ca3af' }}>
                    {onChain > 0 ? `${onChain} of ${total} petition${total !== 1 ? 's' : ''} anchored on Hedera` : 'No petitions anchored yet'}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5">RezoningOracle.sol · Hedera Testnet</div>
                </div>
              </div>
              {onChain > 0 && (
                <a href="https://hashscan.io/testnet/contract/0xf3f8945df31ac04c09312e9e472ba7415bf356b4"
                  target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-1.5 mt-2 text-[11px] text-sky-500 hover:text-sky-300 transition-colors">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                  </svg>
                  View contract on HashScan ↗
                </a>
              )}
            </div>

            <div className="mx-5 border-t" style={{ borderColor: 'rgba(255,255,255,0.05)' }} />

            {/* Rezoning history */}
            <div className="px-5 py-3">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] font-black uppercase tracking-widest text-gray-500">Rezoning History</div>
                <div className="text-[10px] text-gray-600">{total} petition{total !== 1 ? 's' : ''}</div>
              </div>
              {history.length === 0 && (
                <div className="text-xs text-gray-600 py-4 text-center">No rezoning petitions found.</div>
              )}
              <div className="space-y-3">
                {history.map((pet, i) => {
                  const isOnChain = Boolean(pet.committed_at);
                  return (
                    <div key={pet.petition_number + i} className="rounded-xl overflow-hidden"
                      style={{ border: isOnChain ? '1px solid rgba(34,197,94,0.18)' : '1px solid rgba(255,255,255,0.06)', background: isOnChain ? 'rgba(34,197,94,0.04)' : 'rgba(255,255,255,0.02)' }}>
                      <div className="px-3 py-2.5 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="font-mono text-xs font-bold text-sky-300 flex-shrink-0">{pet.petition_number}</span>
                          <StatusBadge status={pet.status} />
                        </div>
                        {isOnChain && (
                          <span className="flex items-center gap-1 text-[10px] font-bold text-green-400 flex-shrink-0"
                            style={{ background: 'rgba(34,197,94,0.12)', border: '1px solid rgba(34,197,94,0.25)', padding: '2px 6px', borderRadius: '6px' }}>
                            ⛓️ On-Chain
                          </span>
                        )}
                      </div>
                      <div className="px-3 pb-2.5">
                        {(pet.current_zoning || pet.proposed_zoning) && (
                          <div className="flex items-center gap-1.5 mb-2">
                            <span className="px-2 py-0.5 rounded text-[11px] font-bold font-mono"
                              style={{ background: 'rgba(14,165,233,0.12)', color: '#38bdf8' }}>{pet.current_zoning || '—'}</span>
                            <svg className="w-3 h-3 text-gray-600 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7l5 5m0 0l-5 5m5-5H6"/>
                            </svg>
                            <span className="px-2 py-0.5 rounded text-[11px] font-bold font-mono"
                              style={{ background: 'rgba(249,115,22,0.12)', color: '#fb923c' }}>{pet.proposed_zoning || '—'}</span>
                          </div>
                        )}
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-500">
                          {pet.meeting_date && <span>📅 {fmtDate(pet.meeting_date)}</span>}
                          {pet.vote_result  && <span>🗳️ {pet.vote_result}</span>}
                          {pet.meeting_type && <span>{pet.meeting_type}</span>}
                        </div>
                        {pet.petition_address && (
                          <div className="text-[10px] text-gray-600 mt-1 truncate">📍 {pet.petition_address}</div>
                        )}
                        {isOnChain && (
                          <div className="mt-2.5 rounded-lg px-2.5 py-2 space-y-1"
                            style={{ background: 'rgba(34,197,94,0.07)', border: '1px solid rgba(34,197,94,0.12)' }}>
                            <div className="text-[10px] font-bold text-green-400 uppercase tracking-wider mb-1">Hedera Proof</div>
                            {pet.evm_snapshot_index != null && (
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-gray-500">Batch ID</span>
                                <span className="text-[10px] font-mono text-gray-300">#{pet.evm_snapshot_index}</span>
                              </div>
                            )}
                            {pet.hedera_evm_block && (
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] text-gray-500">Block</span>
                                <span className="text-[10px] font-mono text-gray-300">{fmt(pet.hedera_evm_block)}</span>
                              </div>
                            )}
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] text-gray-500">Anchored</span>
                              <span className="text-[10px] text-gray-300">{fmtDate(pet.committed_at)}</span>
                            </div>
                            {pet.hedera_evm_tx_hash && (
                              <div className="flex items-center justify-between mt-1">
                                <span className="text-[10px] text-gray-500">TX</span>
                                <a href={`https://hashscan.io/testnet/transaction/${pet.hedera_evm_tx_hash}`}
                                  target="_blank" rel="noopener noreferrer"
                                  className="text-[10px] font-mono text-sky-400 hover:text-sky-300 transition-colors">
                                  {shortHash(pet.hedera_evm_tx_hash)} ↗
                                </a>
                              </div>
                            )}
                          </div>
                        )}
                        {pet.legislation_url && (
                          <a href={pet.legislation_url} target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 mt-2 text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors">
                            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"/>
                            </svg>
                            View legislation ↗
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="h-6" />
          </>
        )}
      </div>
    </div>
  );
}

// ── AI Chat Panel ─────────────────────────────────────────────────────────────

function AiPanel({ onHighlightFeatures, onClose }) {
  const [messages, setMessages] = useState([{
    role: 'assistant',
    content: "Hi! Ask me anything about Wake County zoning — \"Show N1 to B1 conversions\", \"Find commercial rezonings near downtown\", or paste any address.",
  }]);
  const [input, setInput]     = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEnd            = useRef(null);

  useEffect(() => {
    messagesEnd.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const send = async (e) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, county_id: 'raleigh_nc', conversation_history: [] }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setMessages(prev => [...prev, { role: 'assistant', content: data.reply || 'No response.' }]);
      if ((data.parcel_features || []).length > 0) onHighlightFeatures(data.parcel_features);
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `⚠️ ${err.message}. Make sure the backend is running at ${API_BASE}.`,
      }]);
    } finally {
      setLoading(false);
    }
  };

  const QUICK = ['Show top 5 petitioners', 'N1 to B1 conversions', 'Recent commercial rezonings', 'Show approval rate'];

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-5 py-4 border-b flex-shrink-0"
        style={{ borderColor: 'rgba(14,165,233,0.15)' }}>
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xl">🤖</span>
            <span className="font-black text-white tracking-wide">ZONEPROOF AI</span>
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5">Wake County zoning assistant</div>
        </div>
        <button onClick={onClose} className="text-gray-600 hover:text-gray-300 transition-colors p-1">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
      <div className="px-4 py-3 border-b flex-shrink-0 flex flex-wrap gap-2"
        style={{ borderColor: 'rgba(14,165,233,0.1)' }}>
        {QUICK.map(q => (
          <button key={q} onClick={() => setInput(q)}
            className="px-3 py-1.5 rounded-lg text-xs text-gray-300 hover:text-white transition-all"
            style={{ background: 'rgba(14,165,233,0.1)', border: '1px solid rgba(14,165,233,0.2)' }}>
            {q}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((m, i) => (
          <div key={i} className={`flex gap-2.5 ${m.role === 'user' ? 'justify-end' : ''}`}>
            {m.role === 'assistant' && (
              <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center mt-0.5"
                style={{ background: 'linear-gradient(135deg, #0ea5e9, #6366f1)' }}>
                <span className="text-xs">🤖</span>
              </div>
            )}
            <div className={`rounded-2xl px-4 py-3 text-sm leading-relaxed max-w-[85%] ${m.role === 'user' ? 'text-white' : 'text-gray-200'}`}
              style={m.role === 'user'
                ? { background: 'linear-gradient(135deg, #0ea5e9, #6366f1)' }
                : { background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(14,165,233,0.1)' }}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex gap-2.5">
            <div className="w-7 h-7 rounded-full flex-shrink-0 flex items-center justify-center"
              style={{ background: 'linear-gradient(135deg, #0ea5e9, #6366f1)' }}>
              <span className="text-xs">🤖</span>
            </div>
            <div className="rounded-2xl px-4 py-3 flex gap-1.5"
              style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(14,165,233,0.1)' }}>
              {[0, 0.18, 0.36].map((d, i) => (
                <motion.div key={i} animate={{ opacity: [0.3, 1, 0.3] }}
                  transition={{ repeat: Infinity, duration: 1.2, delay: d }}
                  className="w-2 h-2 bg-sky-400 rounded-full" />
              ))}
            </div>
          </div>
        )}
        <div ref={messagesEnd} />
      </div>
      <form onSubmit={send} className="px-4 py-3 border-t flex-shrink-0 flex gap-2"
        style={{ borderColor: 'rgba(14,165,233,0.15)' }}>
        <input value={input} onChange={e => setInput(e.target.value)} disabled={loading}
          placeholder="Ask about zoning, petitions, developers…"
          className="flex-1 rounded-xl px-4 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-sky-500/50 disabled:opacity-50"
          style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(14,165,233,0.2)' }} />
        <button type="submit" disabled={loading || !input.trim()}
          className="w-10 h-10 rounded-xl flex items-center justify-center transition-all hover:scale-105 disabled:opacity-40"
          style={{ background: 'linear-gradient(135deg, #0ea5e9, #6366f1)' }}>
          <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
          </svg>
        </button>
      </form>
    </div>
  );
}

// ── MapPage ───────────────────────────────────────────────────────────────────

export default function MapPage() {
  const mapContainer = useRef(null);
  const map          = useRef(null);

  const highlightedPinRef  = useRef(null);
  const aiHighlightRef     = useRef([]);
  const hederaMarkerRef    = useRef(null);  // mapboxgl.Marker for on-chain badge

  const [mapStyle, setMapStyle]             = useState('dark');
  const [showStyleMenu, setShowStyleMenu]   = useState(false);
  const [isChatOpen, setIsChatOpen]         = useState(false);
  const [isDetailOpen, setIsDetailOpen]     = useState(false);
  const [detailPin, setDetailPin]           = useState(null);
  const [searchQuery, setSearchQuery]       = useState('');
  const [searchLoading, setSearchLoading]   = useState(false);
  const [searchError, setSearchError]       = useState('');
  const [searchHint, setSearchHint]         = useState('');
  const [geocodeResults, setGeocodeResults] = useState([]);

  // ── Hedera on-chain badge marker ──────────────────────────────────────────
  const clearHederaMarker = useCallback(() => {
    if (hederaMarkerRef.current) {
      hederaMarkerRef.current.remove();
      hederaMarkerRef.current = null;
    }
  }, []);

  // Queries the full canvas for all tile renditions of the highlighted parcel,
  // computes the northeast corner (top-right = maxLng, maxLat) of the bounding
  // box across all renditions, then places a tiny Hedera badge there —
  // exactly how Twitter places a verified tick on a profile picture.
  const placeHederaMarker = useCallback((pin) => {
    clearHederaMarker();
    if (!map.current || !pin) return;

    const container = map.current.getContainer();
    const features  = map.current.queryRenderedFeatures(
      [[0, 0], [container.clientWidth, container.clientHeight]],
      {
        layers: ['parcels-fill', 'parcels-search-fill'],
        filter: ['==', ['get', 'pin'], pin],
      },
    );
    if (!features.length) return;

    // Find the actual polygon vertex that is "most northeast" by maximising
    // lng + lat. This picks a real vertex on the polygon boundary — unlike
    // computing maxLng and maxLat independently, which produces an imaginary
    // bounding-box corner that can land outside the polygon entirely.
    let bestLng = null, bestLat = null, bestScore = -Infinity;
    const scan = (ring) => ring.forEach(([lng, lat]) => {
      const score = lng + lat;   // higher = further NE
      if (score > bestScore) { bestScore = score; bestLng = lng; bestLat = lat; }
    });
    features.forEach(f => {
      const { type, coordinates } = f.geometry;
      if (type === 'Polygon')           scan(coordinates[0]);
      else if (type === 'MultiPolygon') coordinates.forEach(p => scan(p[0]));
    });
    if (bestLng === null) return;

    const maxLng = bestLng, maxLat = bestLat;

    // Badge element — 16 px teal circle, Hedera logo inside
    const el = document.createElement('div');
    Object.assign(el.style, {
      width: '32px', height: '32px',
      background: '#00BAAD',
      borderRadius: '50%',
      border: '2.5px solid rgba(255,255,255,0.92)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      boxShadow: '0 2px 8px rgba(0,0,0,0.6)',
      pointerEvents: 'none',
    });
    const img = document.createElement('img');
    img.src = '/hedera-icon.png';
    img.alt = 'Hedera verified';
    Object.assign(img.style, { width: '20px', height: '20px', objectFit: 'contain' });
    el.appendChild(img);

    hederaMarkerRef.current = new mapboxgl.Marker({ element: el, anchor: 'center' })
      .setLngLat([maxLng, maxLat])
      .addTo(map.current);
  }, [clearHederaMarker]);

  // Called by ParcelPanel once the API response arrives
  const handleParcelLoaded = useCallback((data) => {
    if (data?.on_chain_count > 0) {
      placeHederaMarker(data.parcel?.pin);
    } else {
      clearHederaMarker();
    }
  }, [placeHederaMarker, clearHederaMarker]);

  // ── Map init ───────────────────────────────────────────────────────────────
  const addParcelLayers = useCallback(() => {
    if (!map.current) return;

    if (!map.current.getSource('wake-parcels')) {
      map.current.addSource('wake-parcels', { type: 'vector', url: `mapbox://${TILESET_ID}` });
    }
    if (!map.current.getLayer('parcels-fill')) {
      map.current.addLayer({
        id: 'parcels-fill', type: 'fill',
        source: 'wake-parcels', 'source-layer': SOURCE_LAYER,
        paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.18 },
      });
    }
    if (!map.current.getLayer('parcels-outline')) {
      map.current.addLayer({
        id: 'parcels-outline', type: 'line',
        source: 'wake-parcels', 'source-layer': SOURCE_LAYER,
        paint: { 'line-color': '#38bdf8', 'line-width': 0.6, 'line-opacity': 0.7 },
      });
    }
    // Search highlight — same tileset, filtered by PIN
    if (!map.current.getLayer('parcels-search-fill')) {
      map.current.addLayer({
        id: 'parcels-search-fill', type: 'fill',
        source: 'wake-parcels', 'source-layer': SOURCE_LAYER,
        paint: { 'fill-color': '#22c55e', 'fill-opacity': 0.75 },
        filter: ['literal', false],
      });
    }
    if (!map.current.getLayer('parcels-search-outline')) {
      map.current.addLayer({
        id: 'parcels-search-outline', type: 'line',
        source: 'wake-parcels', 'source-layer': SOURCE_LAYER,
        paint: { 'line-color': '#4ade80', 'line-width': 3 },
        filter: ['literal', false],
      });
    }
    // Restore after style switch
    if (highlightedPinRef.current) _applyPinFilter(highlightedPinRef.current);

    // AI / petition GeoJSON overlay
    if (!map.current.getSource('ai-parcels')) {
      map.current.addSource('ai-parcels', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: aiHighlightRef.current },
      });
      map.current.addLayer({
        id: 'ai-fill', type: 'fill', source: 'ai-parcels',
        paint: { 'fill-color': '#f59e0b', 'fill-opacity': 0.6 },
      });
      map.current.addLayer({
        id: 'ai-outline', type: 'line', source: 'ai-parcels',
        paint: { 'line-color': '#fbbf24', 'line-width': 2.5 },
      });
    }

    // Click handlers
    ['parcels-fill', 'parcels-search-fill', 'ai-fill'].forEach(layerId => {
      map.current.on('click', layerId, e => {
        const pin = e.features[0].properties?.pin;
        if (pin) openDetail(pin);
      });
      map.current.on('mouseenter', layerId, () => { map.current.getCanvas().style.cursor = 'pointer'; });
      map.current.on('mouseleave', layerId, () => { map.current.getCanvas().style.cursor = ''; });
    });

    // Click on empty map — close popup only, keep panel open
    map.current.on('click', e => {
      const hits = map.current.queryRenderedFeatures(e.point,
        { layers: ['parcels-fill', 'parcels-search-fill', 'ai-fill'] });
      // If empty click, don't auto-close the panel (user may still want to read it)
    });
  }, []);

  useEffect(() => {
    if (map.current || !mapContainer.current) return;
    map.current = new mapboxgl.Map({
      container:              mapContainer.current,
      style:                  MAP_STYLES.dark.url,
      center:                 [-78.85, 35.78],
      zoom:                   11,
      preserveDrawingBuffer:  true,   // required for canvas.toDataURL() in PDF export
    });
    map.current.addControl(new mapboxgl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.current.on('load', addParcelLayers);
  }, [addParcelLayers]);

  // Resize the map when panels open/close
  useEffect(() => {
    if (map.current) setTimeout(() => map.current?.resize(), 310);
  }, [isChatOpen, isDetailOpen]);

  // ── Style switch ───────────────────────────────────────────────────────────
  const switchStyle = (key) => {
    if (!map.current) return;
    setMapStyle(key);
    setShowStyleMenu(false);
    map.current.setStyle(MAP_STYLES[key].url);
    map.current.once('styledata', addParcelLayers);
  };

  // ── PIN highlight ──────────────────────────────────────────────────────────
  const _applyPinFilter = (pin) => {
    const f = ['==', ['get', 'pin'], pin];
    if (map.current?.getLayer('parcels-search-fill'))   map.current.setFilter('parcels-search-fill', f);
    if (map.current?.getLayer('parcels-search-outline')) map.current.setFilter('parcels-search-outline', f);
  };

  const _clearPinFilter = () => {
    highlightedPinRef.current = null;
    const f = ['literal', false];
    if (map.current?.getLayer('parcels-search-fill'))   map.current.setFilter('parcels-search-fill', f);
    if (map.current?.getLayer('parcels-search-outline')) map.current.setFilter('parcels-search-outline', f);
  };

  const highlightPin = useCallback((pin) => {
    highlightedPinRef.current = pin;
    _applyPinFilter(pin);
  }, []);

  // ── Open detail panel ─────────────────────────────────────────────────────
  const openDetail = useCallback((pin) => {
    clearHederaMarker();   // remove stale badge while new data loads
    highlightPin(pin);
    setDetailPin(pin);
    setIsDetailOpen(true);
    setIsChatOpen(false);
  }, [highlightPin, clearHederaMarker]);

  const closeDetail = useCallback(() => {
    setIsDetailOpen(false);
    _clearPinFilter();
    setDetailPin(null);
    setSearchQuery('');
    clearHederaMarker();
  }, [clearHederaMarker]);

  // ── AI highlights ─────────────────────────────────────────────────────────
  const highlightAiFeatures = useCallback((features) => {
    if (!map.current || !features.length) return;
    aiHighlightRef.current = features;
    const src = map.current.getSource('ai-parcels');
    if (src) src.setData({ type: 'FeatureCollection', features });
    const bounds = new mapboxgl.LngLatBounds();
    features.forEach(f => {
      const rings = f.geometry?.type === 'Polygon' ? f.geometry.coordinates : (f.geometry?.coordinates?.flat() || []);
      if (rings[0]) rings[0].forEach(c => bounds.extend(c));
    });
    if (!bounds.isEmpty()) map.current.fitBounds(bounds, { padding: 100, maxZoom: 18, duration: 900 });
  }, []);

  // ── Fly + highlight parcel after geocoding ─────────────────────────────────
  const flyToResult = useCallback((result) => {
    if (!map.current) return;
    const [lng, lat] = result.center;
    setGeocodeResults([]);
    setSearchQuery(result.place_name || result.text || '');
    setSearchHint('');
    _clearPinFilter();

    map.current.flyTo({ center: [lng, lat], zoom: 17, duration: 1000 });

    map.current.once('idle', () => {
      if (!map.current) return;
      const screenPt = map.current.project([lng, lat]);
      const buf = 10;
      const features = map.current.queryRenderedFeatures(
        [[screenPt.x - buf, screenPt.y - buf], [screenPt.x + buf, screenPt.y + buf]],
        { layers: ['parcels-fill'] },
      );
      if (features.length > 0) {
        const pin = features[0].properties?.pin;
        if (pin) openDetail(pin);
      } else {
        setSearchHint('Flew to location — click a parcel to inspect it');
        setTimeout(() => setSearchHint(''), 4000);
      }
    });
  }, [openDetail]);

  // ── Search ────────────────────────────────────────────────────────────────
  const handleSearch = useCallback(async (e) => {
    e?.preventDefault();
    const q = searchQuery.trim();
    if (!q) return;
    setSearchError('');
    setSearchHint('');
    setGeocodeResults([]);
    setSearchLoading(true);

    if (PETITION_RE.test(q)) {
      try {
        const res = await fetch(`/oracle/petitions/${encodeURIComponent(q.toUpperCase())}/geojson`);
        if (res.ok) {
          const data  = await res.json();
          const feats = (data.features || []).filter(f => f.geometry?.coordinates);
          if (feats.length > 0) { highlightAiFeatures(feats); setSearchLoading(false); return; }
        }
      } catch { /* fall through */ }
      setSearchError(`Petition ${q.toUpperCase()} not found`);
      setSearchLoading(false);
      return;
    }

    try {
      const bbox = '-79.2,35.5,-78.3,36.1';
      const url  = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(q)}.json?access_token=${MAPBOX_TOKEN}&country=US&bbox=${bbox}&proximity=-78.85,35.78&limit=5`;
      const res  = await fetch(url);
      if (!res.ok) throw new Error('Geocoding failed');
      const { features = [] } = await res.json();
      if (features.length === 0) {
        setSearchError(`No results for "${q}"`);
      } else if (features.length === 1) {
        flyToResult(features[0]);
      } else {
        setGeocodeResults(features);
      }
    } catch {
      setSearchError('Search failed — check connection');
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery, flyToResult, highlightAiFeatures]);

  // ── Layout widths ─────────────────────────────────────────────────────────
  const leftW  = isChatOpen   ? 400 : 0;
  const rightW = isDetailOpen ? 380 : 0;

  return (
    <div className="relative w-full h-screen bg-black overflow-hidden">

      {/* ── Map ── */}
      <div
        ref={mapContainer}
        className="absolute top-0 bottom-0 transition-all duration-300"
        style={{ left: leftW, right: rightW }}
      />

      {/* ── Top bar ── */}
      <div
        className="absolute top-0 z-20 flex items-center gap-2.5 px-4 py-3 transition-all duration-300"
        style={{
          left:       leftW,
          right:      rightW,
          background: 'linear-gradient(to bottom, rgba(5,10,16,0.88) 0%, transparent 100%)',
        }}>

        <div className="flex items-center gap-3 flex-shrink-0">
          <a href="/" className="flex items-center gap-2">
            <img src="/zoneproof-favicon.svg" alt="ZoneProof" className="h-8 w-8 flex-shrink-0" />
            <div className="hidden sm:block leading-none">
              <div className="text-white font-black text-sm">ZoneProof</div>
              <div className="text-gray-500 text-[10px]">Wake County · 434k parcels</div>
            </div>
          </a>
          <a href="/tech"
            className="hidden lg:block px-3 py-1 rounded-lg text-[10px] font-semibold transition-colors hover:text-white"
            style={{ color: '#38bdf8', border: '1px solid rgba(14,165,233,0.2)' }}>
            How It Works
          </a>
        </div>

        {/* Search */}
        <div className="flex-1 max-w-lg relative">
          <form onSubmit={handleSearch} className="flex gap-1.5">
            <div className="relative flex-1">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-gray-500">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                    d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>
              <input
                type="text"
                value={searchQuery}
                onChange={e => { setSearchQuery(e.target.value); setSearchError(''); setSearchHint(''); setGeocodeResults([]); }}
                onKeyDown={e => e.key === 'Escape' && setGeocodeResults([])}
                placeholder="Search address or petition (Z-29-2023)…"
                className="w-full pl-8 pr-3 py-2 rounded-xl text-xs text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-sky-500/50"
                style={{
                  background: 'rgba(255,255,255,0.08)',
                  border: searchError ? '1px solid rgba(239,68,68,0.5)' : '1px solid rgba(255,255,255,0.1)',
                }}
              />
              <AnimatePresence>
                {geocodeResults.length > 1 && (
                  <motion.div
                    initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                    className="absolute top-full mt-1 left-0 right-0 rounded-xl overflow-hidden z-50 py-1"
                    style={{ background: '#0d1520', border: '1px solid rgba(14,165,233,0.2)' }}>
                    {geocodeResults.map(r => (
                      <button key={r.id} type="button" onClick={() => flyToResult(r)}
                        className="flex w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-sky-500/10 hover:text-white gap-2 items-start">
                        <svg className="w-3 h-3 text-sky-400 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2"
                            d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                        </svg>
                        <span className="truncate">{r.place_name}</span>
                      </button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
              {searchError && (
                <div className="absolute top-full mt-1 left-0 text-[10px] text-red-400 bg-black/85 px-2 py-1 rounded whitespace-nowrap z-50">
                  {searchError}
                </div>
              )}
              {searchHint && !searchError && (
                <div className="absolute top-full mt-1 left-0 text-[10px] text-sky-400 bg-black/85 px-2 py-1 rounded whitespace-nowrap z-50">
                  {searchHint}
                </div>
              )}
            </div>
            <button type="submit" disabled={searchLoading || !searchQuery.trim()}
              className="px-3 py-2 rounded-xl text-xs font-medium text-gray-300 hover:text-white transition-colors disabled:opacity-40 flex-shrink-0"
              style={{ background: 'rgba(14,165,233,0.15)', border: '1px solid rgba(14,165,233,0.3)' }}>
              {searchLoading
                ? <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                : '🔍'}
            </button>
          </form>
        </div>

        {/* Legend */}
        <div className="hidden lg:flex items-center gap-2 flex-shrink-0">
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
            style={{ background: 'rgba(14,165,233,0.1)', border: '1px solid rgba(14,165,233,0.2)', color: '#38bdf8' }}>
            <span className="w-2 h-2 rounded-sm" style={{ background: '#0ea5e9' }} />
            All parcels
          </div>
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px]"
            style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: '#4ade80' }}>
            <span className="w-2 h-2 rounded-sm" style={{ background: '#22c55e' }} />
            Selected
          </div>
        </div>

        {/* Style switcher */}
        <div className="relative flex-shrink-0">
          <button onClick={() => setShowStyleMenu(v => !v)}
            className="px-3 py-2 rounded-xl text-xs font-medium text-gray-300 hover:text-white transition-colors"
            style={{ background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)' }}>
            {MAP_STYLES[mapStyle].name} ▾
          </button>
          <AnimatePresence>
            {showStyleMenu && (
              <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }}
                className="absolute right-0 top-full mt-1 rounded-xl overflow-hidden py-1 z-50"
                style={{ background: '#0d1520', border: '1px solid rgba(14,165,233,0.2)', minWidth: '130px' }}>
                {Object.entries(MAP_STYLES).map(([key, s]) => (
                  <button key={key} onClick={() => switchStyle(key)}
                    className={`block w-full text-left px-4 py-2 text-xs transition-colors ${mapStyle === key ? 'text-sky-400 font-semibold' : 'text-gray-400 hover:text-white'}`}>
                    {s.name}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* AI chat toggle */}
        <button onClick={() => { setIsChatOpen(v => !v); if (!isChatOpen) setIsDetailOpen(false); }}
          className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition-all flex-shrink-0"
          style={isChatOpen
            ? { background: 'linear-gradient(135deg, #0ea5e9, #6366f1)', color: '#fff', boxShadow: '0 4px 16px rgba(14,165,233,0.4)' }
            : { background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.1)', color: '#d1d5db' }}>
          🤖 <span className="hidden sm:inline">AI Chat</span>
        </button>
      </div>

      {/* ── Left: AI Chat panel ── */}
      <AnimatePresence>
        {isChatOpen && (
          <motion.div
            initial={{ x: -420, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -420, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
            className="absolute left-0 top-0 h-full w-[400px] z-30 flex flex-col"
            style={{ background: 'rgba(5,10,20,0.98)', borderRight: '1px solid rgba(14,165,233,0.15)', backdropFilter: 'blur(20px)' }}>
            <AiPanel onHighlightFeatures={highlightAiFeatures} onClose={() => setIsChatOpen(false)} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Right: Parcel Detail panel ── */}
      <AnimatePresence>
        {isDetailOpen && detailPin && (
          <motion.div
            initial={{ x: 400, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 400, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 280, damping: 28 }}
            className="absolute right-0 top-0 h-full w-[380px] z-30 flex flex-col"
            style={{ background: 'rgba(5,10,20,0.98)', borderLeft: '1px solid rgba(14,165,233,0.15)', backdropFilter: 'blur(20px)' }}>
            <ParcelPanel pin={detailPin} onClose={closeDetail} onParcelLoaded={handleParcelLoaded} mapRef={map} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Hedera status badge ── */}
      <div
        className="absolute bottom-6 z-20 flex items-center gap-2 px-3 py-2 rounded-xl transition-[left] duration-300"
        style={{
          left:           leftW + 12,
          background:     'rgba(5,10,20,0.82)',
          border:         '1px solid rgba(14,165,233,0.15)',
          backdropFilter: 'blur(12px)',
        }}>
        <div className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
        <span className="text-[11px] text-gray-400 font-medium">Hedera Testnet</span>
        <a href="https://hashscan.io/testnet/contract/0xf3f8945df31ac04c09312e9e472ba7415bf356b4"
          target="_blank" rel="noopener noreferrer"
          className="text-[11px] text-sky-500 hover:text-sky-300 transition-colors">
          0xf3f894… ↗
        </a>
      </div>
    </div>
  );
}

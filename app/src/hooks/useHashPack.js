/**
 * useHashPack — Flow A (HashPack as EVM provider via window.ethereum)
 *
 * Uses EIP-6963 (modern multi-wallet standard) to find HashPack specifically,
 * even when MetaMask and Phantom are also installed.
 *
 * Flow: Connect → Switch to Hedera Testnet → Send HBAR → HashPack popup → approve
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import { BrowserProvider, parseEther, getAddress } from 'ethers';

export const RECEIVER_EVM = import.meta.env.VITE_HEDERA_RECEIVER_EVM || '0x85652f8479dc8dbd89adaee37d42e7c91a534294';
export const RECEIVER_ID  = import.meta.env.VITE_HEDERA_RECEIVER     || '0.0.7952768';
export const HBAR_AMOUNT  = 0.05;

const HEDERA_TESTNET = {
  chainId:          '0x128',
  chainName:        'Hedera Testnet',
  nativeCurrency:   { name: 'HBAR', symbol: 'HBAR', decimals: 18 },
  rpcUrls:          ['https://testnet.hashio.io/api'],
  blockExplorerUrls:['https://hashscan.io/testnet'],
};

/**
 * Discover HashPack via EIP-6963 (wallet announces itself) and legacy fallbacks.
 * Returns a promise that resolves to the provider, or null if not found.
 */
function discoverHashPack() {
  return new Promise((resolve) => {
    const found = { provider: null };

    // EIP-6963: wallets dispatch this event when we request providers
    function onAnnounce(event) {
      const { info, provider } = event.detail ?? {};
      // Log all announcing wallets so we can debug
      console.log('[wallet-detect] announced:', info?.name, info?.rdns, provider);

      const name = (info?.name ?? '').toLowerCase();
      const rdns = (info?.rdns ?? '').toLowerCase();
      if (name.includes('hashpack') || rdns.includes('hashpack')) {
        found.provider = provider;
        cleanup();
        resolve(provider);
      }
    }

    function cleanup() {
      window.removeEventListener('eip6963:announceProvider', onAnnounce);
    }

    window.addEventListener('eip6963:announceProvider', onAnnounce);
    // Ask all installed wallets to announce themselves
    window.dispatchEvent(new Event('eip6963:requestProvider'));

    // Give wallets 600ms to respond, then try legacy fallbacks
    setTimeout(() => {
      cleanup();
      if (found.provider) return;

      // Log everything available for debugging
      console.log('[wallet-detect] EIP-6963 timeout — checking legacy globals:', {
        'window.ethereum':            !!window.ethereum,
        'window.ethereum.isHashPack': window.ethereum?.isHashPack,
        'window.ethereum.providers':  window.ethereum?.providers?.map(p => ({
          isHashPack: p.isHashPack,
          isMetaMask: p.isMetaMask,
          isPhantom:  p.isPhantom,
        })),
        'window.hashpack':    !!window.hashpack,
        'window.hashconnect': !!window.hashconnect,
      });

      // Legacy 1: MetaMask providers[] array
      if (Array.isArray(window.ethereum?.providers)) {
        const hp = window.ethereum.providers.find(p => p.isHashPack);
        if (hp) { resolve(hp); return; }
      }

      // Legacy 2: HashPack is the only wallet
      if (window.ethereum?.isHashPack) { resolve(window.ethereum); return; }

      // Legacy 3: HashPack-specific global
      if (window.hashpack) { resolve(window.hashpack); return; }

      resolve(null);
    }, 600);
  });
}

async function ensureHederaTestnet(provider) {
  try {
    await provider.send('wallet_switchEthereumChain', [{ chainId: HEDERA_TESTNET.chainId }]);
  } catch (err) {
    if (err.code === 4902 || err.code === -32603) {
      await provider.send('wallet_addEthereumChain', [HEDERA_TESTNET]);
    } else {
      throw err;
    }
  }
}

export function useHashPack() {
  const [hasWallet, setHasWallet] = useState(false);
  const [paying,    setPaying]    = useState(false);
  const [error,     setError]     = useState(null);
  const providerRef = useRef(null);

  // Detect HashPack on mount
  useEffect(() => {
    discoverHashPack().then(p => {
      providerRef.current = p;
      setHasWallet(!!p);
      if (!p) console.warn('[useHashPack] HashPack not found — check console logs above for what wallets announced');
    });
  }, []);

  const payAndFetch = useCallback(async (url) => {
    setError(null);

    // Re-discover in case extension was installed after page load
    let hpProvider = providerRef.current;
    if (!hpProvider) {
      hpProvider = await discoverHashPack();
      providerRef.current = hpProvider;
      setHasWallet(!!hpProvider);
    }

    if (!hpProvider) {
      throw new Error('HashPack not detected. Open the console for debug info.');
    }

    setPaying(true);
    try {
      const provider = new BrowserProvider(hpProvider);

      // Connect — HashPack popup opens
      await provider.send('eth_requestAccounts', []);

      // Switch to Hedera Testnet
      await ensureHederaTestnet(provider);

      const signer = await provider.getSigner();

      // Send HBAR — HashPack approval popup opens
      const tx = await signer.sendTransaction({
        to:       getAddress(RECEIVER_EVM),
        value:    parseEther(String(HBAR_AMOUNT)),
        gasLimit: 21000n,
      });

      await tx.wait(1);

      // Hedera mirror node lags 3-8s behind on-chain consensus — wait before querying
      await new Promise(r => setTimeout(r, 4000));

      const paymentHeader = btoa(
        JSON.stringify({ txHash: tx.hash, network: 'testnet', scheme: 'hedera-evm' })
      );

      // Retry oracle up to 3 times in case mirror node is still indexing
      let res;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await fetch(url, { headers: { 'X-Payment': paymentHeader } });
        if (res.status !== 402) break;
        if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
      }
      return res;
    } finally {
      setPaying(false);
    }
  }, []);

  return { hasWallet, paying, error, payAndFetch };
}

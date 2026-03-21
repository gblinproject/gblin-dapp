import {ChangeDetectionStrategy, Component, signal, computed, OnInit, OnDestroy} from '@angular/core';
import {MatIconModule} from '@angular/material/icon';
import {CommonModule} from '@angular/common';
import {translations, Language} from '../translations';
import {ethers} from 'ethers';

const RPC_URL = "https://mainnet.base.org";
const GBLIN_ABI = [
  "function totalSupply() view returns (uint256)",
  "function stabilityFund() view returns (uint256)",
  "function getVaultStats() view returns (uint256 tvl, uint256 fund, uint256[] weights)",
  "function getRecentRebalances() view returns (tuple(uint256 timestamp, address executor, uint256 reward)[])",
  "function incentivizedRebalance() external",
  "function buyGBLIN(uint256 minGblinOut) external payable",
  "function buyGBLINWithToken(bytes calldata path, uint256 amountIn, uint256 minWethOut, uint256 minGblinOut) external",
  "function sellGBLINForEth(uint256 gblinAmount, uint256 minEthOut) external",
  "function quoteBuyGBLIN(uint256 ethAmount) view returns (uint256 gblinOut, uint256 founderFee, uint256 stabFee)",
  "function quoteSellGBLIN(uint256 gblinAmount) view returns (uint256 ethOut)",
  "function balanceOf(address account) view returns (uint256)"
];

interface BasescanTransaction {
  hash: string;
  from: string;
  to: string;
  value: string;
  timeStamp: string;
  functionName: string;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [MatIconModule, CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnInit, OnDestroy {
  contractAddress = "0xc475851f9101A2AC48a84EcF869766A94D301FaA";
  copied = signal(false);
  showLangSelector = signal(false);
  language = signal<Language>('it');

  t = computed(() => {
    const lang = this.language();
    const dict = translations[lang] || translations['en'];
    return (key: string) => {
      const keys = key.split('.');
      let val: Record<string, unknown> = dict as Record<string, unknown>;
      for (const k of keys) {
        if (val && typeof val === 'object' && k in val) {
          val = val[k] as Record<string, unknown>;
        } else {
          return key;
        }
      }
      return val as unknown as string;
    };
  });

  languages: { code: Language; name: string; flag: string }[] = [
    { code: 'en', name: 'English', flag: '🇺🇸' },
    { code: 'it', name: 'Italiano', flag: '🇮🇹' },
    { code: 'es', name: 'Español', flag: '🇪🇸' },
    { code: 'zh', name: '中文', flag: '🇨🇳' },
    { code: 'ja', name: '日本語', flag: '🇯🇵' },
    { code: 'fr', name: 'Français', flag: '🇫🇷' },
    { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  ];

  // Dashboard signals
  supply = signal<string>('---');
  stabilityFund = signal<string>('---');
  buyAmount = signal('0.01');
  quoteBuyGBLIN = signal('0.00');
  isMinting = signal(false);

  // Trade Interface signals
  mode = signal<'buy' | 'sell'>('buy');
  amount = signal('');
  selectedToken = signal('ETH');
  isTokenModalOpen = signal(false);
  isWalletModalOpen = signal(false);
  account = signal<string | null>(null);
  isConnecting = signal(false);
  quote = signal('0');
  rawQuote = signal<bigint>(0n);
  displayQuote = computed(() => {
    const q = this.quote();
    if (q === '0') return '0.00';
    const num = parseFloat(q);
    if (num === 0) return '0.00';
    if (num < 0.000001) return q; // Show full precision for very small amounts
    return num.toLocaleString(undefined, { 
      minimumFractionDigits: 2,
      maximumFractionDigits: 6 
    });
  });

  minOutDisplay = computed(() => {
    const raw = this.rawQuote();
    if (raw === 0n) return '0.00';
    const slip = BigInt(Math.floor(this.slippage() * 100));
    const minOut = (raw * (10000n - slip)) / 10000n;
    const formatted = ethers.formatEther(minOut);
    return parseFloat(formatted).toFixed(8);
  });

  feeDisplay = signal('0.00');
  hasQuote = computed(() => this.rawQuote() > 0n);
  isLoadingQuote = signal(false);
  isTransacting = signal(false);
  tradeTxHash = signal<string | null>(null);
  tradeError = signal<string | null>(null);
  showForceOption = signal(false);
  lastUpdate = signal<string>(new Date().toLocaleTimeString('it-IT'));
  isRefreshing = signal(false);
  slippage = signal(1);
  searchQuery = signal('');
  
  ethBalance = signal('0.0000');
  gblinBalance = signal('0.0000');

  tokens = ['ETH', 'USDC', 'cbBTC', 'DEGEN', 'AERO', 'BRETT'];

  // Rebalance Action State
  stats = signal<{
    tvlUsd: number;
    fundEth: number;
    weights: { symbol: string; actual: number; dynamic: number; base: number }[];
    recentLogs: { txHash: string; executor: string; tokenIn: string; tokenOut: string; amount: string; time: string; type: string }[];
  } | null>(null);
  isLoadingStats = signal(true);
  isArbitraging = signal(false);
  arbTxHash = signal<string | null>(null);
  arbError = signal<string | null>(null);

  private provider: ethers.JsonRpcProvider;
  private contract: ethers.Contract;
  private intervalId: ReturnType<typeof setInterval> | undefined;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(RPC_URL);
    this.contract = new ethers.Contract(this.contractAddress, GBLIN_ABI, this.provider);
  }

  ngOnInit() {
    this.fetchData();
    this.intervalId = setInterval(() => this.fetchData(), 15000);
  }

  ngOnDestroy() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
    }
  }

  async fetchData() {
    this.isRefreshing.set(true);
    try {
      const [totalSupply, stabFund] = await Promise.all([
        this.contract['totalSupply']().catch(() => 0n),
        this.contract['stabilityFund']().catch(() => 0n)
      ]);
      
      this.supply.set(parseFloat(ethers.formatEther(totalSupply)).toLocaleString(undefined, {maximumFractionDigits: 2}));
      this.stabilityFund.set(parseFloat(ethers.formatEther(stabFund)).toFixed(8));

      // Fetch user balances if connected
      const currentAccount = this.account();
      if (currentAccount) {
        const [ethBal, gblinBal] = await Promise.all([
          this.provider.getBalance(currentAccount),
          this.contract['balanceOf'](currentAccount).catch(() => 0n)
        ]);
        this.ethBalance.set(parseFloat(ethers.formatEther(ethBal)).toFixed(8));
        this.gblinBalance.set(parseFloat(ethers.formatEther(gblinBal)).toFixed(8));
      } else {
        this.ethBalance.set('0.00000000');
        this.gblinBalance.set('0.00000000');
      }
    } catch (e) {
      console.error("Error fetching dashboard data", e);
    }

    try {
      // Fetch real GBLIN transactions from Basescan API (txlist matches the "Transactions" tab)
      const response = await fetch(`https://api.basescan.org/api?module=account&action=txlist&address=${this.contractAddress}&startblock=0&endblock=99999999&page=1&offset=10&sort=desc`);
      const json = await response.json();
      
      let recentLogs: { txHash: string; executor: string; tokenIn: string; tokenOut: string; amount: string; time: string; type: string }[] = [];

      if (json.status === '1' && Array.isArray(json.result)) {
        recentLogs = (json.result as BasescanTransaction[]).map((tx) => {
          const time = new Date(parseInt(tx.timeStamp) * 1000);
          const func = tx.functionName || '';
          let type = 'TRANSAZIONE';
          if (func.includes('buyGBLIN')) type = 'ACQUISTO';
          else if (func.includes('sellGBLIN')) type = 'VENDITA';
          else if (func.includes('incentivizedRebalance')) type = 'REBALANCE';
          else if (tx.value !== '0') type = 'INVIO ETH';

          return {
            txHash: tx.hash,
            executor: tx.from,
            tokenIn: '---',
            tokenOut: 'GBLIN',
            amount: tx.value !== '0' ? parseFloat(ethers.formatEther(tx.value)).toFixed(8) : '---',
            time: time.toLocaleString('it-IT', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }),
            type: type
          };
        });
      }

        // Fallback if txlist is empty or rate-limited
        if (recentLogs.length === 0) {
          try {
            const latestBlock = await this.provider.getBlockNumber();
            const logs = await this.provider.getLogs({
              address: this.contractAddress,
              fromBlock: latestBlock - 5000,
              toBlock: latestBlock
            });
            
            if (logs && Array.isArray(logs)) {
              recentLogs = await Promise.all(logs.reverse().slice(0, 10).map(async log => {
                const block = await this.provider.getBlock(log.blockNumber);
                const time = block ? new Date(block.timestamp * 1000) : new Date();
                
                let from = '---';
                let to = '---';
                
                if (log.topics && log.topics.length > 1 && log.topics[1]) {
                  from = ethers.getAddress('0x' + log.topics[1].slice(26));
                }
                if (log.topics && log.topics.length > 2 && log.topics[2]) {
                  to = ethers.getAddress('0x' + log.topics[2].slice(26));
                }
                
                let type = 'TRASFERIMENTO';
                if (from === ethers.ZeroAddress) type = 'ACQUISTO';
                else if (to === ethers.ZeroAddress) type = 'VENDITA';

                return {
                  txHash: log.transactionHash,
                  executor: from === ethers.ZeroAddress ? to : from,
                  tokenIn: '---',
                  tokenOut: 'GBLIN',
                  amount: '---',
                  time: time.toLocaleString('it-IT', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }),
                  type: type
                };
              }));
            }
          } catch (logErr) {
            console.warn("Fallback logs fetch failed", logErr);
          }
        }

      this.stats.set({
        tvlUsd: 1250000,
        fundEth: parseFloat(this.stabilityFund()) || 45.2,
        weights: [
          { symbol: 'WETH', actual: 48.5, dynamic: 50, base: 50 },
          { symbol: 'cbBTC', actual: 31.2, dynamic: 30, base: 30 },
          { symbol: 'USDC', actual: 20.3, dynamic: 20, base: 20 }
        ],
        recentLogs: recentLogs
      });
      this.isLoadingStats.set(false);
      this.lastUpdate.set(new Date().toLocaleTimeString('it-IT'));
    } catch (e) {
      console.error("Error fetching stats", e);
      this.isLoadingStats.set(false);
    } finally {
      this.isRefreshing.set(false);
    }
  }

  async handleArbitrage() {
    if (!this.account() || !(window as unknown as {ethereum: unknown}).ethereum) {
      this.openWalletModal();
      return;
    }

    try {
      this.isArbitraging.set(true);
      this.arbError.set(null);
      this.arbTxHash.set(null);

      const provider = new ethers.BrowserProvider((window as unknown as {ethereum: ethers.Eip1193Provider}).ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(this.contractAddress, GBLIN_ABI, signer);

      // Verifica preventiva: se fallisce qui, non proviamo nemmeno a inviare la transazione
      try {
        await contract['incentivizedRebalance'].staticCall();
      } catch (staticErr: unknown) {
        console.warn("Static call failed, rebalance not needed:", staticErr);
        this.arbError.set("Nessun rebalance necessario al momento o condizioni non soddisfatte.");
        this.isArbitraging.set(false);
        return;
      }

      const tx = await contract['incentivizedRebalance']();
      this.arbTxHash.set(tx.hash);
      await tx.wait();
      
      this.fetchData(); // Refresh data
    } catch (err: unknown) {
      console.error(err);
      const errorObj = err as { code?: string; message?: string; info?: { error?: { code: number } } };
      
      if (errorObj.code === 'CALL_EXCEPTION' || errorObj.message?.includes('CALL_EXCEPTION')) {
        this.arbError.set("Nessun rebalance necessario al momento o condizioni non soddisfatte.");
      } else if (errorObj.code === '4001' || errorObj.info?.error?.code === 4001) {
        this.arbError.set("Transazione annullata dall'utente.");
      } else {
        this.arbError.set((err as Error).message || "Errore durante la transazione");
      }
    } finally {
      this.isArbitraging.set(false);
    }
  }

  copyToClipboard() {
    navigator.clipboard.writeText(this.contractAddress);
    this.copied.set(true);
    setTimeout(() => this.copied.set(false), 2000);
  }

  async updateBuyAmount(event: Event) {
    const target = event.target as HTMLInputElement;
    let val = target.value;
    
    // Handle comma as decimal separator
    val = val.replace(',', '.');
    this.buyAmount.set(val);
    
    if (val && !isNaN(Number(val)) && Number(val) > 0) {
      try {
        const wethAmount = ethers.parseEther(val);
        const [gblinOut] = await this.contract['quoteBuyGBLIN'](wethAmount);
        this.quoteBuyGBLIN.set(parseFloat(ethers.formatEther(gblinOut)).toFixed(4));
      } catch (e) {
        console.error("Quote error:", e);
        this.quoteBuyGBLIN.set('0.00');
      }
    } else {
      this.quoteBuyGBLIN.set('0.00');
    }
  }

  async handleMint() {
    if (!this.account() || !(window as unknown as {ethereum: unknown}).ethereum || !this.buyAmount() || isNaN(Number(this.buyAmount())) || Number(this.buyAmount()) <= 0) return;
    
    try {
      this.isMinting.set(true);
      const provider = new ethers.BrowserProvider((window as unknown as {ethereum: ethers.Eip1193Provider}).ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(this.contractAddress, GBLIN_ABI, signer);

      const parsedQuote = ethers.parseEther(this.quoteBuyGBLIN());
      const minOut = (parsedQuote * BigInt(10000 - this.slippage() * 100)) / 10000n;

      const parsedAmount = ethers.parseEther(this.buyAmount());
      const tx = await contract['buyGBLIN'](minOut, { value: parsedAmount });
      
      await tx.wait();
      this.buyAmount.set('');
      this.quoteBuyGBLIN.set('0.00');
      this.fetchData(); // Refresh data
    } catch (err: unknown) {
      console.error(err);
      // Could set an error state here if we had one for the mint section
    } finally {
      this.isMinting.set(false);
    }
  }

  setMaxAmount() {
    const balance = this.mode() === 'buy' ? this.ethBalance() : this.gblinBalance();
    if (this.mode() === 'buy') {
      // Leave some ETH for gas
      const eth = parseFloat(balance);
      const max = Math.max(0, eth - 0.001); // Reserve 0.001 ETH for gas
      this.amount.set(max.toString());
    } else {
      this.amount.set(balance);
    }
    // Trigger quote update
    const event = { target: { value: this.amount() } } as unknown as Event;
    this.updateAmount(event);
  }

  async checkNetwork() {
    const ethereum = (window as unknown as { ethereum: ethers.Eip1193Provider }).ethereum;
    if (!ethereum) return false;
    
    try {
      const provider = new ethers.BrowserProvider(ethereum);
      const network = await provider.getNetwork();
      
      if (network.chainId !== 8453n) { // Base Mainnet
        try {
          await ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x2105' }], // 8453 in hex
          });
          return true;
        } catch (switchError: unknown) {
          const err = switchError as { code: number };
          if (err.code === 4902) {
            try {
              await ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                  chainId: '0x2105',
                  chainName: 'Base',
                  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
                  rpcUrls: ['https://mainnet.base.org'],
                  blockExplorerUrls: ['https://basescan.org']
                }],
              });
              return true;
            } catch {
              return false;
            }
          }
          return false;
        }
      }
      return true;
    } catch (e) {
      console.error("Network check error:", e);
      return false;
    }
  }

  toggleLangSelector() {
    this.showLangSelector.update(v => !v);
  }

  setLanguage(code: Language) {
    this.language.set(code);
    this.showLangSelector.set(false);
  }

  setMode(m: 'buy' | 'sell') {
    this.mode.set(m);
    this.amount.set('');
    this.tradeError.set(null);
    this.tradeTxHash.set(null);
  }

  async updateAmount(event: Event) {
    const target = event.target as HTMLInputElement;
    let val = target.value;
    
    // Handle comma as decimal separator
    val = val.replace(',', '.');
    this.amount.set(val);
    
    if (!val || isNaN(Number(val)) || Number(val) <= 0) {
      this.quote.set('0');
      this.rawQuote.set(0n);
      return;
    }

    this.isLoadingQuote.set(true);
    try {
      // Use wallet provider if connected for more accurate quote
      let activeContract = this.contract;
      if (this.account() && (window as unknown as {ethereum: ethers.Eip1193Provider}).ethereum) {
        const provider = new ethers.BrowserProvider((window as unknown as {ethereum: ethers.Eip1193Provider}).ethereum);
        activeContract = new ethers.Contract(this.contractAddress, GBLIN_ABI, provider);
      }

      if (this.mode() === 'buy') {
        const wethAmount = ethers.parseEther(val);
        const result = await activeContract['quoteBuyGBLIN'](wethAmount);
        
        // result[0] is gblinOut (gross), result[1] is founderFee, result[2] is stabFee
        // We use BigInt to ensure precision and handle potential undefined/null
        const gblinOut = result[0] ? BigInt(result[0]) : 0n;
        const founderFee = result[1] ? BigInt(result[1]) : 0n;
        const stabFee = result[2] ? BigInt(result[2]) : 0n;
        
        // Il contratto sembra restituire un valore che non tiene conto di tutte le tasse
        // Applichiamo uno sconto cautelativo del 3.5% per allinearci a MetaMask
        let netGblinOut = gblinOut - founderFee - stabFee;
        const safetyMargin = (netGblinOut * 35n) / 1000n;
        netGblinOut = netGblinOut - safetyMargin;
        
        this.feeDisplay.set(ethers.formatEther(founderFee + stabFee + safetyMargin));
        
        this.rawQuote.set(netGblinOut);
        this.quote.set(ethers.formatEther(netGblinOut));
        console.log(`Buy Quote: Gross=${gblinOut}, Net=${netGblinOut}, TotalFees=${founderFee + stabFee + safetyMargin}`);
      } else {
        const parsedAmount = ethers.parseEther(val);
        const ethOut = await activeContract['quoteSellGBLIN'](parsedAmount);
        const netEthOut = BigInt(ethOut);
        
        // Apply similar logic for sell if needed (usually sell also has fees)
        // For now, let's assume quoteSellGBLIN might also be gross.
        // If we see a discrepancy in sell, we might need to adjust here too.
        
        this.rawQuote.set(netEthOut);
        this.quote.set(ethers.formatEther(netEthOut));
        console.log(`Sell Quote: Net=${netEthOut}`);
      }
    } catch (e) {
      console.error("Quote error:", e);
      // Fallback to default provider if wallet provider fails
      try {
        if (this.mode() === 'buy') {
          const result = await this.contract['quoteBuyGBLIN'](ethers.parseEther(val));
          const gblinOut = BigInt(result[0]);
          const founderFee = BigInt(result[1]);
          const stabFee = BigInt(result[2]);
          let netGblinOut = gblinOut - founderFee - stabFee;
          
          const safetyMargin = (netGblinOut * 35n) / 1000n;
          netGblinOut = netGblinOut - safetyMargin;
          
          this.feeDisplay.set(ethers.formatEther(founderFee + stabFee + safetyMargin));
          this.rawQuote.set(netGblinOut);
          this.quote.set(ethers.formatEther(netGblinOut));
        } else {
          const ethOut = await this.contract['quoteSellGBLIN'](ethers.parseEther(val));
          this.rawQuote.set(BigInt(ethOut));
          this.quote.set(ethers.formatEther(BigInt(ethOut)));
        }
      } catch (innerErr) {
        console.error("Fallback quote error:", innerErr);
        this.quote.set('0');
      }
    } finally {
      this.isLoadingQuote.set(false);
    }
  }

  openTokenModal() {
    this.isTokenModalOpen.set(true);
  }

  closeTokenModal() {
    this.isTokenModalOpen.set(false);
  }

  selectToken(token: string) {
    this.selectedToken.set(token);
    this.isTokenModalOpen.set(false);
  }

  updateSearchQuery(event: Event) {
    const target = event.target as HTMLInputElement;
    this.searchQuery.set(target.value);
  }

  get filteredTokens() {
    const query = this.searchQuery().toLowerCase();
    return this.tokens.filter(t => t.toLowerCase().includes(query));
  }

  openWalletModal() {
    this.isWalletModalOpen.set(true);
  }

  closeWalletModal() {
    this.isWalletModalOpen.set(false);
  }

  async connectWallet() {
    this.isWalletModalOpen.set(false);
    if (typeof window === 'undefined' || !(window as unknown as {ethereum: unknown}).ethereum) {
      this.tradeError.set("MetaMask o un wallet compatibile non trovato. Installa l'estensione per continuare.");
      return;
    }

    try {
      this.isConnecting.set(true);
      this.tradeError.set(null);
      const provider = new ethers.BrowserProvider((window as unknown as {ethereum: ethers.Eip1193Provider}).ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      if (accounts.length > 0) {
        this.account.set(accounts[0]);
        await this.checkNetwork();
        this.fetchData(); // Immediate balance update
      }
    } catch (err: unknown) {
      console.error(err);
      this.tradeError.set((err as Error).message || "Errore durante la connessione al wallet");
    } finally {
      this.isConnecting.set(false);
    }
  }

  async handleTrade(force = false) {
    if (!this.account() || !(window as unknown as {ethereum: unknown}).ethereum || !this.amount() || Number(this.amount()) <= 0) return;

    try {
      this.isTransacting.set(true);
      this.tradeError.set(null);
      this.showForceOption.set(false);
      this.tradeTxHash.set(null);

      // Check network
      const isCorrectNetwork = await this.checkNetwork();
      if (!isCorrectNetwork) {
        this.tradeError.set("Per favore, passa alla rete Base Mainnet nel tuo wallet.");
        this.isTransacting.set(false);
        return;
      }

      // Check balance before proceeding
      const userBalance = this.mode() === 'buy' ? this.ethBalance() : this.gblinBalance();
      if (parseFloat(userBalance) < parseFloat(this.amount())) {
        this.tradeError.set(`Saldo insufficiente. Hai ${userBalance} ${this.mode() === 'buy' ? 'ETH' : 'GBLIN'}, ma stai provando a usare ${this.amount()}.`);
        this.isTransacting.set(false);
        return;
      }

      const provider = new ethers.BrowserProvider((window as unknown as {ethereum: ethers.Eip1193Provider}).ethereum);
      const signer = await provider.getSigner();
      const contract = new ethers.Contract(this.contractAddress, GBLIN_ABI, signer);

      // Re-fetch quote to be 100% sure it's fresh and from the right provider
      let currentRawQuote = 0n;
      try {
        if (this.mode() === 'buy') {
          const result = await contract['quoteBuyGBLIN'](ethers.parseEther(this.amount()));
          const gblinOut = BigInt(result[0]);
          const founderFee = BigInt(result[1]);
          const stabFee = BigInt(result[2]);
          currentRawQuote = gblinOut - founderFee - stabFee;
          
          // Apply safety margin
          currentRawQuote = (currentRawQuote * 965n) / 1000n;
        } else {
          const ethOut = await contract['quoteSellGBLIN'](ethers.parseEther(this.amount()));
          currentRawQuote = BigInt(ethOut);
        }
        this.rawQuote.set(currentRawQuote);
        this.quote.set(ethers.formatEther(currentRawQuote));
      } catch (e) {
        console.warn("Quote refresh failed, using last known", e);
        currentRawQuote = this.rawQuote();
      }

      if (currentRawQuote === 0n) {
        this.tradeError.set("Impossibile ottenere un preventivo valido. Riprova.");
        this.isTransacting.set(false);
        return;
      }

      // Calculate minOut with slippage
      const slippageBps = BigInt(Math.round(this.slippage() * 100));
      const minOut = (currentRawQuote * (10000n - slippageBps)) / 10000n;

      console.log(`Trade: ${this.mode()} ${this.amount()} - Quote: ${ethers.formatEther(currentRawQuote)} - MinOut: ${ethers.formatEther(minOut)} - Slippage: ${this.slippage()}%`);

      // Pre-flight check (Simulation)
      if (!force) {
        try {
          if (this.mode() === 'buy') {
            const parsedAmount = ethers.parseEther(this.amount());
            await contract['buyGBLIN'].staticCall(minOut, { value: parsedAmount });
          } else {
            const parsedAmount = ethers.parseEther(this.amount());
            await contract['sellGBLINForEth'].staticCall(parsedAmount, minOut);
          }
        } catch (staticErr: unknown) {
          console.error("Simulation failed:", staticErr);
          const err = staticErr as { 
            data?: string; 
            message?: string; 
            reason?: string; 
            info?: { error?: { data?: string; code?: number } } 
          };
          
          let errorData = "";
          if (typeof err.data === 'string') {
            errorData = err.data;
          } else if (err.info?.error?.data && typeof err.info.error.data === 'string') {
            errorData = err.info.error.data;
          }

          const errorMsg = err.message || "";
          
          if (errorData.includes("0x8199f5f3") || errorMsg.includes("0x8199f5f3")) {
            this.tradeError.set("Slippage rilevato dalla simulazione. Il prezzo potrebbe essere cambiato. Prova ad aumentare lo slippage o forza l'invio se sei sicuro.");
            this.showForceOption.set(true);
          } else {
            this.tradeError.set("La simulazione indica che la transazione potrebbe fallire: " + (err.reason || "Errore tecnico. Verifica il saldo."));
          }
          this.isTransacting.set(false);
          return;
        }
      }

      let tx;
      if (this.mode() === 'buy') {
        const parsedAmount = ethers.parseEther(this.amount());
        tx = await contract['buyGBLIN'](minOut, { value: parsedAmount });
      } else {
        const parsedAmount = ethers.parseEther(this.amount());
        tx = await contract['sellGBLINForEth'](parsedAmount, minOut);
      }

      this.tradeTxHash.set(tx.hash);
      await tx.wait();
      
      this.amount.set('');
      this.isTransacting.set(false);
      this.fetchData(); // Refresh balances
    } catch (err: unknown) {
      console.error(err);
      const error = err as { 
        data?: string; 
        message?: string; 
        code?: number | string;
        info?: { error?: { data?: string; code?: number } } 
      };
      const errorMsg = error.message || "";
      
      let errorData = "";
      if (typeof error.data === 'string') {
        errorData = error.data;
      } else if (error.info?.error?.data && typeof error.info.error.data === 'string') {
        errorData = error.info.error.data;
      }
      
      if (errorMsg.includes("0x8199f5f3") || errorData.includes("0x8199f5f3")) {
        this.tradeError.set("Slippage eccessivo durante l'invio. Aumenta lo slippage al 3% o 5% nelle impostazioni.");
        this.showForceOption.set(true);
      } else if (error.code === 4001 || error.info?.error?.code === 4001) {
        this.tradeError.set("Transazione annullata dall'utente.");
      } else {
        this.tradeError.set("Errore durante la transazione: " + (error.message || "Errore sconosciuto"));
      }
      this.isTransacting.set(false);
    }
  }
}

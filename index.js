/**************************************************************************
 * /Blockchain/index.js (Main Express Server)
 **************************************************************************/
require("dotenv").config();                       // NEW
const path        = require('path');
const express     = require('express');
const bodyParser  = require('body-parser');
const cors        = require('cors');
const { exec }    = require('child_process');
const fs          = require('fs');
const os          = require('os');
const axios       = require('axios');
const crypto      = require('crypto');
const { encode, decode } = require('./util/codec');

// Stripe setup
const stripeKey   = (process.env.STRIPE_SECRET_KEY || "").trim();
const stripe      = require('stripe')(stripeKey, { maxNetworkRetries: 2 });
console.log("→ STRIPE_SECRET_KEY loaded:", stripeKey ? "✅" : "❌");
console.log("→ STRIPE_WEBHOOK_SECRET loaded:", !!process.env.STRIPE_WEBHOOK_SECRET);

// Auth and Ephemeral Keys
const {
  router: authRoutes,
  authenticateToken,
  ephemeralKeys
} = require('./routes/auth');

// Database connection
const connectDB = require('./db');
connectDB();

// Core blockchain components
const Blockchain         = require('./blockchain');
const P2pServer          = require('./app/p2p-server');
const TransactionPool    = require('./wallet/transaction-pool');
const Wallet             = require('./wallet');
const TransactionMiner   = require('./app/transaction-miner');
const Transaction        = require('./wallet/transaction');

// User & contract routes
const userRoutes     = require('./routes/user');
const contractLookup = require('./routes/contract');

// Configuration and pricing utils
const {
  REWARD_INPUT,
  MINING_REWARD,
  FIXED_GAS_PRICE
} = require('./config');
const {
  calculatePrice,
  currentPrice,
  getLastMetrics,
  getHistory
} = require('./util/paycoinPricing');

// Buy router & webhook handler
const { createBuyRouter, webhookHandler } = require('./routes/buy');

const app = express();

// ── Stripe Webhook (raw body for signature verification) ───────────
if (process.env.STRIPE_WEBHOOK_SECRET) {
  app.post(
    '/api/buy/webhook',
    express.raw({ type: 'application/json' }),
    webhookHandler
  );
} else {
  console.warn('▶ STRIPE_WEBHOOK_SECRET not set: Stripe webhook disabled');
}
// -------------------------------------------------------------------

// JSON body parsing for non-webhook routes
app.use(bodyParser.json({ limit: '10mb' }));
app.use(cors());

// Serve static assets
app.use(express.static(path.join(__dirname, 'client/dist')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Auth endpoints
app.use('/api/auth', authRoutes);

// Instantiate blockchain & P2P server
const blockchain       = new Blockchain();
const transactionPool  = new TransactionPool();
const p2pServer        = new P2pServer(blockchain, transactionPool);

// Miner setup (not used directly but instantiated)
const minerWallet      = new Wallet();
const transactionMiner = new TransactionMiner(
  blockchain,
  transactionPool,
  minerWallet,
  p2pServer
);

// BuyPayCoin routes
app.use(
  '/api/buy',
  createBuyRouter({ stripe, blockchain, pool: transactionPool, p2p: p2pServer })
);

// Price recalculation stub
setInterval(() => {
  calculatePrice({
    rollingVolume7d: 1_200_000,
    volumeMin      : 100_000,
    volumeMax      : 2_000_000,
    reserveRatio   : 0.92,
    ratioMin       : 0.80,
    ratioMax       : 1.20,
    sentimentScore : 0.55,
    sentMin        : 0.0,
    sentMax        : 1.0
  });
}, 60_000);

// Ephemeral in-memory notifications
const notificationsMap = {};
function addNotification(userId, message, link) {
  if (!notificationsMap[userId]) notificationsMap[userId] = [];
  notificationsMap[userId].push({
    id     : crypto.randomBytes(8).toString('hex'),
    message,
    link,
    isRead : false
  });
}
function findUserIdByAddress(pubKey) {
  for (const [uId, obj] of Object.entries(ephemeralKeys || {})) {
    if (obj.publicKey === pubKey) return uId;
  }
  return null;
}

// Override addBlock to notify & broadcast
const originalAdd = blockchain.addBlock.bind(blockchain);
blockchain.addBlock = args => {
  const blk = originalAdd(args);
  blk.data.forEach(tx => {
    if (tx.type === 'REWARD') return;
    const uid = findUserIdByAddress(tx.input.address);
    if (uid) addNotification(uid, `Your tx ${tx.id.slice(0,10)}… was mined!`, `/transaction/${tx.id}`);
  });
  p2pServer.broadcastChain();
  return blk;
};

// WASM contract execution helper
async function runWasmContract({ doc, functionName, functionArgs, gasLimit }) {
  const wasmBuffer = Buffer.from(doc.codeWasmBase64, 'base64');
  let gasUsed = 0;
  let newState = { ...doc.state };
  let resultVal = null;

  const wasmModule = await WebAssembly.compile(wasmBuffer);
  const instance   = await WebAssembly.instantiate(wasmModule, {});

  if (functionName && typeof instance.exports[functionName] === 'function') {
    gasUsed += 200;
    if (gasUsed > gasLimit) throw new Error('Out of gas before function call');
    resultVal = instance.exports[functionName](...functionArgs);
    newState.lastCallResult = resultVal;
  } else {
    const codeSize = wasmBuffer.length;
    gasUsed += codeSize;
    if (gasUsed > gasLimit) throw new Error('Out of gas (code size cost too high)');
  }
  return { newState, usedGas: gasUsed, result: resultVal };
}

// Notification helper for mined txs
function addMinedNotifications(block) {
  block.data.forEach(tx => {
    if (tx.type === 'REWARD') return;
    const uid = findUserIdByAddress(tx.input.address);
    if (uid) addNotification(uid, `Your tx ${tx.id.slice(0,10)}… was mined!`, `/transaction/${tx.id}`);
  });
}

// Blocks & transaction routes
app.get('/api/blocks', (req, res) => res.json(blockchain.chain));
app.post('/api/mine', (req, res) => {
  blockchain.addBlock({ data: req.body.data });
  p2pServer.broadcastChain();
  res.redirect('/api/blocks');
});
app.get('/api/transaction-pool-map', (req, res) => res.json(transactionPool.transactionMap));

// Mining with user key
app.get('/api/user/mine-transactions', authenticateToken, (req, res) => {
  const { userId, walletAddress } = req.user;
  const eph = ephemeralKeys[userId];
  if (!eph) return res.status(401).json({ message: 'Re-login required.' });
  const userWallet = new Wallet();
  userWallet.keyPair  = userWallet.keyPair.ec.keyFromPrivate(eph.privateKey, 'hex');
  userWallet.publicKey = walletAddress;
  new TransactionMiner(blockchain, transactionPool, userWallet, p2pServer, userId).mineTransactions();
  res.json({ message: 'Mining complete. New block added.' });
});

// User wallet routes
app.get('/api/user/wallet-info', authenticateToken, (req, res) => {
  const { userId, walletAddress } = req.user;
  const eph = ephemeralKeys[userId];
  if (!eph) return res.status(401).json({ message: 'Re-login required.' });
  const balance = Wallet.calculateBalance({ chain: blockchain.chain, address: walletAddress });
  res.json({ address: walletAddress, balance });
});
app.post('/api/user/transact', authenticateToken, (req, res) => {
  const { userId, walletAddress } = req.user;
  const eph = ephemeralKeys[userId];
  if (!eph) return res.status(401).json({ message: 'Re-login required.' });
  const { recipient, amount } = req.body;
  const userWallet = new Wallet();
  userWallet.keyPair  = userWallet.keyPair.ec.keyFromPrivate(eph.privateKey, 'hex');
  userWallet.publicKey = walletAddress;
  userWallet.balance   = Wallet.calculateBalance({ chain: blockchain.chain, address: walletAddress });
  try {
    const tx = userWallet.createTransaction({ recipient, amount: Number(amount), chain: blockchain.chain });
    tx.type = 'NORMAL';
    transactionPool.setTransaction(tx);
    p2pServer.broadcastTransaction(tx);
    res.json({ message: 'Transaction submitted', transaction: tx });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// Auth, user & contract routes
app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/contract', contractLookup);

// Notifications endpoints
app.get('/api/user/notifications', authenticateToken, (req, res) => {
  const notifs = notificationsMap[req.user.userId] || [];
  res.json(notifs);
});
app.post('/api/user/notifications/mark-read', authenticateToken, (req, res) => {
  const arr = notificationsMap[req.user.userId] || [];
  if (req.body.id === 'all') arr.forEach(n => n.isRead = true);
  else {
    const n = arr.find(x => x.id === req.body.id);
    if (n) n.isRead = true;
  }
  res.json({ success: true });
});

// Contract deploy route
app.post('/api/contract/deploy', authenticateToken, (req, res) => {
  const { userId, walletAddress } = req.user;
  const eph = ephemeralKeys[userId];
  if (!eph) return res.status(401).json({ message: 'Re-login required.' });
  const userWallet = new Wallet();
  userWallet.keyPair  = userWallet.keyPair.ec.keyFromPrivate(eph.privateKey, 'hex');
  userWallet.publicKey = walletAddress;
  userWallet.balance   = Wallet.calculateBalance({ chain: blockchain.chain, address: walletAddress });
  const { rustCode, gasLimit, description } = req.body;
  if (!rustCode) return res.status(400).json({ message: 'No Rust code provided.' });
  if (!gasLimit || gasLimit <= 0) return res.status(400).json({ message: 'Invalid gasLimit.' });
  const needed = gasLimit * FIXED_GAS_PRICE;
  if (userWallet.balance < needed) return res.status(400).json({ message: `Need ≥${needed} PKC.` });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-'));
  const cargoToml = `[package]
name = "temp_contract"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]
`;
  fs.writeFileSync(path.join(tempDir, 'Cargo.toml'), cargoToml);
  fs.mkdirSync(path.join(tempDir, 'src'));
  fs.writeFileSync(path.join(tempDir, 'src', 'lib.rs'), rustCode);
  exec('cargo build --target wasm32-unknown-unknown --release', { cwd: tempDir }, async (err, stdout, stderr) => {
    if (err) { fs.rmSync(tempDir, { recursive: true, force: true }); return res.status(400).json({ message: stderr }); }
    const wasmPath = path.join(tempDir, 'target', 'wasm32-unknown-unknown', 'release', 'temp_contract.wasm');
    if (!fs.existsSync(wasmPath)) { fs.rmSync(tempDir, { recursive: true, force: true }); return res.status(500).json({ message: 'WASM missing.' }); }
    const wasmBuffer = fs.readFileSync(wasmPath);
    fs.rmSync(tempDir, { recursive: true, force: true });
    const codeSize = wasmBuffer.length;
    if (codeSize > gasLimit) return res.status(400).json({ message: `Out of gas: ${codeSize} > ${gasLimit}` });
    let exports = [];
    try {
      const mod = await WebAssembly.compile(wasmBuffer);
      exports = WebAssembly.Module.exports(mod).filter(e => e.kind === 'function').map(e => e.name);
    } catch {}
    const base64 = wasmBuffer.toString('base64');
    try {
      const tx = userWallet.createTransaction({ recipient: walletAddress, amount: 0, chain: blockchain.chain });
      tx.type = 'SMART_CONTRACT'; tx.isDeploy = true;
      tx.contractAddress     = crypto.randomBytes(8).toString('hex') + Date.now().toString(16);
      tx.wasmBase64          = base64;
      tx.rustSource          = encode(rustCode);
      tx.exportedFunctions   = exports;
      tx.gasLimit            = gasLimit;
      tx.gasPrice            = FIXED_GAS_PRICE;
      tx.contractDescription = description || '';
      transactionPool.setTransaction(tx);
      p2pServer.broadcastTransaction(tx);
      res.json({ message: 'Deploy TX created', contractAddress: tx.contractAddress, codeSize, gasLimit, transaction: tx });
    } catch (e) {
      res.status(400).json({ message: e.message });
    }
  });
});

// Contract interaction route
app.post('/api/contract/interact', authenticateToken, async (req, res) => {
  const { userId, walletAddress } = req.user;
  const eph = ephemeralKeys[userId];
  if (!eph) return res.status(401).json({ message: 'Re-login required.' });
  const { contractAddress, functionName, functionArgs, gasLimit } = req.body;
  if (!contractAddress || !functionName) return res.status(400).json({ message: 'contractAddress & functionName required.' });
  const userWallet = new Wallet();
  userWallet.keyPair  = userWallet.keyPair.ec.keyFromPrivate(eph.privateKey, 'hex');
  userWallet.publicKey = walletAddress;
  userWallet.balance   = Wallet.calculateBalance({ chain: blockchain.chain, address: walletAddress });
  if (!gasLimit || gasLimit <= 0) return res.status(400).json({ message: 'gasLimit required.' });
  const needed = gasLimit * FIXED_GAS_PRICE; if (userWallet.balance < needed) return res.status(400).json({ message: `Need ≥${needed}` });
  if (gasLimit < 200) return res.status(400).json({ message: 'Insufficient gas limit.' });
  try {
    const tx = userWallet.createTransaction({ recipient: walletAddress, amount: 0, chain: blockchain.chain });
    tx.type           = 'SMART_CONTRACT';
    tx.isDeploy       = false;
    tx.contractAddress= contractAddress;
    tx.functionName   = functionName;
    tx.functionArgs   = Array.isArray(functionArgs) ? functionArgs.map(v=>Number(v)||0) : [];
    tx.gasLimit       = gasLimit;
    tx.gasPrice       = FIXED_GAS_PRICE;
    transactionPool.setTransaction(tx);
    p2pServer.broadcastTransaction(tx);
    res.json({ message: 'Interact TX created', cost: 200, gasLimit, transaction: tx });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
});

// React fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

// Sync helpers
async function syncChains() {
  try {
    const r = await axios.get('http://localhost:3000/api/blocks');
    blockchain.replaceChain(r.data);
  } catch (e) { console.error('Sync blocks failed:', e.message); }
}
async function syncPool() {
  try {
    const r = await axios.get('http://localhost:3000/api/transaction-pool-map');
    transactionPool.setMap(r.data);
  } catch (e) { console.error('Sync pool failed:', e.message); }
}

// Start server
const PORT = process.env.PORT||3000;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  if (PORT!==3000) { syncChains(); syncPool(); }
  p2pServer.listen();
});

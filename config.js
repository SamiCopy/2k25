// Blockchain/config.js
/* ──────────────────────────────────────────────────────────
 *  Global constants
 * ──────────────────────────────────────────────────────────*/
const MINE_RATE          = 1000;   // 1-second PoW target
const INITIAL_DIFFICULTY = 3;

/* ---------- genesis block ---------- */
const GENESIS_DATA = {
  timestamp : 1,
  lastHash  : '------',
  hash      : 'hash-one',
  difficulty: INITIAL_DIFFICULTY,
  nonce     : 0,
  data      : []
};

/* ---------- balances & rewards ---------- */
const STARTING_BALANCE = 1000;
const REWARD_INPUT     = { address: '*authorized_reward' };
const MINING_REWARD    = 50;       // *base* reward (multiplied later)

/* ---------- gas fee ---------- */
const FIXED_GAS_PRICE  = 0.1;

/* ──────────────────────────────────────────────────────────
 *  Mining-power tiers  (6 realistic buckets)
 * ──────────────────────────────────────────────────────────*/
const POWER_LEVELS = Object.freeze({
  EASY        : 0,   // potato laptop, IoT Pi
  NORMAL      : 1,   // everyday office PC
  MEDIUM      : 2,   // decent gaming rig
  HIGH        : 3,   // high-end gamer / entry workstation
  ULTRA       : 4,   // enthusiast multi-GPU
  EXTRAVAGANT : 5    // mining-farm titan
});

/* Reward multipliers per tier */
const POWER_MULTIPLIER = {
  [POWER_LEVELS.EASY]       : 1.0,
  [POWER_LEVELS.NORMAL]     : 1.2,
  [POWER_LEVELS.MEDIUM]     : 1.5,
  [POWER_LEVELS.HIGH]       : 2.0,
  [POWER_LEVELS.ULTRA]      : 2.5,
  [POWER_LEVELS.EXTRAVAGANT]: 3.0
};

/* Hardware auto-detection parameters */
const BENCHMARK_DURATION_SEC     = 10;     // async benchmark length
const BENCHMARK_RETRY_BASE_SEC   = 30;     // back-off start on failure
/* Hash/s boundaries that split the tiers.
 * Override with:  POWER_THRESHOLDS="50000,200000,750000,2500000,12000000"
 *                 → six comma-separated integers */
const HASHRATE_THRESHOLDS = (()=>{
  const env = process.env.POWER_THRESHOLDS;
  if(env){
    const arr = env.split(',').map(n=>parseInt(n.trim(),10)).filter(n=>n>0);
    if(arr.length === 5) return {
      EASY_NORM   : arr[0],
      NORM_MED    : arr[1],
      MED_HIGH    : arr[2],
      HIGH_ULTRA  : arr[3],
      ULTRA_EXTR  : arr[4]
    };
  }
  /* sensible defaults (≈ SHA-256 on typical 2024 hardware) */
  return {
    EASY_NORM   :     50_000,    //   < 50 kH/s → EASY
    NORM_MED    :    200_000,    // 50-200 kH/s → NORMAL
    MED_HIGH    :    750_000,    // 200-750 kH/s → MEDIUM
    HIGH_ULTRA  :  2_500_000,    // 0.75-2.5 MH/s → HIGH
    ULTRA_EXTR  : 12_000_000     // 2.5-12 MH/s  → ULTRA
                                // ≥12 MH/s   → EXTRAVAGANT
  };
})();

/* ──────────────────────────────────────────────────────────
 *  Referral system
 * ──────────────────────────────────────────────────────────*/
const REFERRAL_BONUS_RECIPIENT = 0.10;  // +10 % to referred miner
const REFERRAL_BONUS_REFERRER  = 0.05;  // +5 % to referrer
const REFERRAL_BONUS_BLOCKS    = 100;   // bonus for first 100 blocks

module.exports = {
  GENESIS_DATA,
  MINE_RATE,
  STARTING_BALANCE,
  REWARD_INPUT,
  MINING_REWARD,
  FIXED_GAS_PRICE,
  POWER_LEVELS,
  POWER_MULTIPLIER,
  BENCHMARK_DURATION_SEC,
  BENCHMARK_RETRY_BASE_SEC,
  HASHRATE_THRESHOLDS,
  REFERRAL_BONUS_RECIPIENT,
  REFERRAL_BONUS_REFERRER,
  REFERRAL_BONUS_BLOCKS
};

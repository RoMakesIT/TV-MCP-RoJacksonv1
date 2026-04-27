/**
 * T2: BB + RSI Scalps [MNQ] v3 — Three-mode filter sweep
 * Runs off / block_counter / smart sequentially and collects stats.
 */
import { readFileSync } from 'fs';
import { healthCheck } from '../src/core/health.js';
import { getState } from '../src/core/chart.js';
import { setSource, smartCompile, getErrors, ensurePineEditorOpen } from '../src/core/pine.js';
import { captureScreenshot } from '../src/core/capture.js';
import { openPanel } from '../src/core/ui.js';
import { evaluate } from '../src/connection.js';

const SOURCE_PATH = new URL('./T2_BB_RSI_Scalps_MNQ_v3.pine', import.meta.url).pathname;
const MODES = ['off', 'block_counter', 'smart'];
const WAIT_MS = 12000; // wait for strategy tester to recalculate after compile

const sleep = ms => new Promise(r => setTimeout(r, ms));

function patchMode(source, mode) {
  // Replace the filterMode input default to hardcode the mode
  return source.replace(
    /filterMode\s*=\s*input\.string\("[^"]*"/,
    `filterMode = input.string("${mode}"`
  );
}

function extractKey(metrics, ...keys) {
  for (const k of keys) {
    for (const mk of Object.keys(metrics)) {
      if (mk.toLowerCase().includes(k.toLowerCase())) return metrics[mk];
    }
  }
  return null;
}

async function scrapeStrategyTesterDOM() {
  const raw = await evaluate(`
    (function() {
      var bottomPanel = document.querySelector('[class*="layout__area--bottom"]');
      return bottomPanel ? bottomPanel.innerText : '';
    })()
  `);
  if (!raw) return {};

  // Parse key→value pairs from strategy tester plain text
  const text = raw;
  const extract = (label, text) => {
    const re = new RegExp(label + '\\s*\\n\\s*([\\+\\-−]?[\\d,\\.]+)', 'i');
    const m = text.match(re);
    return m ? parseFloat(m[1].replace(/,/g, '').replace('−', '-')) : null;
  };
  const extractPct = (label, text) => {
    // label then up to 60 chars (possibly with tabs/spaces) then XX.XX%
    const re = new RegExp(label + '[^%]{0,60}?([\\d]+\\.[\\d]+)%', 'i');
    const m = text.match(re);
    return m ? parseFloat(m[1]) : null;
  };

  return {
    netPL:        extract('Net P&L', text),
    maxDD:        extract('Max equity drawdown', text),
    trades:       extract('Total trades', text),
    wr:           extractPct('Profitable trades', text),
    pf:           extract('Profit factor', text),
    grossProfit:  extract('Gross profit', text),
    grossLoss:    extract('Gross loss', text),
    expectancy:   extract('Expected payoff', text),
  };
}

function fmt(v, decimals = 2) {
  if (v === null || v === undefined) return 'n/a';
  if (typeof v === 'number') return v.toFixed(decimals);
  return String(v);
}

function summarise(r) {
  return {
    mode:       r.mode,
    netPL:      fmt(r.netPL, 0),
    pf:         fmt(r.pf),
    wr:         fmt(r.wr),
    trades:     fmt(r.trades, 0),
    maxDD:      fmt(r.maxDD, 0),
    grossProfit: fmt(r.grossProfit, 0),
    grossLoss:   fmt(r.grossLoss, 0),
    expectancy:  fmt(r.expectancy),
  };
}

function printTable(rawResults) {
  const rows = rawResults.map(summarise);
  console.log('\n╔══════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║            SNAP3 — T2 v3 Three-Mode Backtest Comparison                         ║');
  console.log('╠══════════════════╦══════════╦══════╦═══════╦════════╦════════╦══════════╦═══════╣');
  console.log('║ Mode             ║ Net P&L  ║   PF ║   WR% ║ Trades ║ Max DD ║ Gr.P/L   ║   Exp ║');
  console.log('╠══════════════════╬══════════╬══════╬═══════╬════════╬════════╬══════════╬═══════╣');
  for (const r of rows) {
    const gpl = r.grossProfit !== 'n/a' && r.grossLoss !== 'n/a' ? `${r.grossProfit}/${r.grossLoss}` : 'n/a';
    const line = [
      r.mode.padEnd(16),
      r.netPL.padStart(8),
      r.pf.padStart(6),
      r.wr.padStart(7),
      r.trades.padStart(6),
      r.maxDD.padStart(6),
      gpl.padStart(10),
      r.expectancy.padStart(7),
    ].join(' ║ ');
    console.log(`║ ${line} ║`);
  }
  console.log('╚══════════════════╩══════════╩══════╩═══════╩════════╩════════╩══════════╩═══════╝');
  return rows;
}

async function main() {
  console.log('═══ T2 v3 Three-Mode Sweep ═══\n');

  // Health check
  console.log('[1/4] Health check...');
  const health = await healthCheck();
  if (!health.success) {
    console.error('FAIL — TradingView not reachable:', health.error);
    process.exit(1);
  }
  console.log('      ✓ Connected:', health.symbol || health.status || 'OK');

  // Chart state
  console.log('[2/4] Chart state...');
  const state = await getState();
  console.log(`      Symbol: ${state.symbol}  TF: ${state.timeframe}  Indicators: ${state.indicators?.length ?? '?'}`);

  // Open strategy tester so DOM scraping can read it
  console.log('[3/4] Opening strategy tester + Pine Editor...');
  try {
    await openPanel({ panel: 'strategy-tester', action: 'open' });
    await sleep(800);
  } catch (e) {
    console.warn('      strategy-tester openPanel warning:', e.message);
  }
  // Switch to Pine Editor tab for injection
  try {
    await openPanel({ panel: 'pine-editor', action: 'open' });
    await sleep(1500);
  } catch (e) {
    console.warn('      pine-editor openPanel warning:', e.message);
  }
  const editorReady = await ensurePineEditorOpen();
  console.log(`      Editor ready: ${editorReady}`);
  if (!editorReady) {
    console.error('FAIL — Pine Editor could not be opened. Please click the Pine Editor tab manually, then re-run.');
    process.exit(1);
  }

  const rawSource = readFileSync(SOURCE_PATH, 'utf8');
  const results = [];

  for (let i = 0; i < MODES.length; i++) {
    const mode = MODES[i];
    console.log(`\n[Pass ${i + 1}/${MODES.length}] mode="${mode}"`);

    // Patch source
    const patched = patchMode(rawSource, mode);
    const defaultLine = patched.match(/filterMode\s*=\s*input\.string\("[^"]*"/)?.[0];
    console.log(`      Source patched → ${defaultLine}`);

    // Inject
    console.log('      Injecting source...');
    const setRes = await setSource({ source: patched });
    if (!setRes.success) { console.error('      FAIL inject:', setRes.error); continue; }

    // Compile
    console.log('      Compiling...');
    const compRes = await smartCompile();
    const compSummary = JSON.stringify(compRes).slice(0, 300);
    console.log('      Compile result:', JSON.stringify(compRes).slice(0, 600));
    // severity 8 = error, severity 4 = warning (e.g. "use Pine v6") — only block on real errors
    const hardErrors = (compRes.errors || []).filter(e => e.severity >= 8);
    if (hardErrors.length > 0) {
      console.error('      COMPILE ERRORS — skipping pass:', JSON.stringify(hardErrors.slice(0, 3)));
      continue;
    }
    if (!compRes.success) {
      const errs = await getErrors();
      console.error('      Compile errors:', JSON.stringify(errs));
      continue;
    }

    // Switch to strategy tester and wait for recalculation
    console.log(`      Switching to strategy tester, waiting ${WAIT_MS / 1000}s...`);
    try { await openPanel({ panel: 'strategy-tester', action: 'open' }); } catch (e) {}
    await sleep(WAIT_MS);

    // Screenshot
    const ssFilename = `sweep_v3_${mode}_${Date.now()}`;
    console.log('      Screenshot → strategy_tester...');
    try {
      const ss = await captureScreenshot({ region: 'strategy_tester', filename: ssFilename });
      console.log('      Screenshot:', ss.path || ss.filename || JSON.stringify(ss).slice(0, 120));
    } catch (e) {
      console.warn('      Screenshot failed:', e.message);
    }

    // Pull stats via DOM scraping
    console.log('      Scraping strategy tester DOM...');
    const dom = await scrapeStrategyTesterDOM();
    console.log('      DOM metrics:', JSON.stringify(dom));
    results.push(dom ? { mode, ...dom } : { mode });
    console.log(`      ✓ Pass ${i + 1} done`);
  }

  // Print comparison table
  if (results.length > 0) {
    const rows = printTable(results);

    const off   = rows.find(r => r.mode === 'off');
    const block = rows.find(r => r.mode === 'block_counter');
    const smart = rows.find(r => r.mode === 'smart');

    console.log('\n─── Recommendation ───────────────────────────────────────────────────────────');
    console.log('\n  v2 failure modes targeted by v3:');
    console.log('  1. Setup A counter-trend longs bleeding (28% WR) in strong uptrend.');
    console.log('     → block_counter & smart kill A-long in downtrend, A-short in uptrend.');
    console.log('  2. Setup B midband fade missing continuation pullbacks.');
    console.log('     → smart reinterprets B as with-trend continuation (B-long only uptrend, etc.)');

    if (off && block && smart) {
      const offPL    = parseFloat(off.netPL)  || 0;
      const blockPL  = parseFloat(block.netPL) || 0;
      const smartPL  = parseFloat(smart.netPL) || 0;
      const offTrades   = parseInt(off.trades)   || 0;
      const blockTrades = parseInt(block.trades) || 0;
      const smartTrades = parseInt(smart.trades) || 0;

      console.log('\n  Analysis:');
      if (blockPL > offPL)
        console.log(`  + block_counter improves Net P&L by ${(blockPL - offPL).toFixed(0)} vs off — filter is helping.`);
      else
        console.log(`  - block_counter does NOT improve P&L vs off (${blockPL.toFixed(0)} vs ${offPL.toFixed(0)}) — filter may be too restrictive.`);

      if (smartPL > blockPL)
        console.log(`  + smart further improves vs block_counter by ${(smartPL - blockPL).toFixed(0)} — with-trend B reinterpretation adds alpha.`);
      else
        console.log(`  - smart does NOT beat block_counter (${smartPL.toFixed(0)} vs ${blockPL.toFixed(0)}).`);

      const tradeDiff = smartTrades - blockTrades;
      if (Math.abs(tradeDiff) > 5)
        console.log(`  Trades: off=${offTrades} | block_counter=${blockTrades} | smart=${smartTrades} (smart Δ vs block: ${tradeDiff > 0 ? '+' : ''}${tradeDiff})`);

      const best = [off, block, smart].reduce((a, b) => parseFloat(a.netPL) >= parseFloat(b.netPL) ? a : b);
      console.log(`\n  >> Recommended mode: ${best.mode.toUpperCase()} (Net P&L: ${best.netPL})`);
    }
    console.log('─────────────────────────────────────────────────────────────────────────────\n');
  } else {
    console.error('\nNo results collected — all passes failed.');
  }
}

main().catch(err => { console.error('Sweep error:', err); process.exit(1); });

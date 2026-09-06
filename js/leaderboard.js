/**
 * js/leaderboard.js
 * Ranking, tie-breaker logic & UI rendering
 */

export function sortPlayers(playersObj) {
  if (!playersObj) return [];
  const list = Object.values(playersObj);
  return list.sort((a, b) => {
    const scoreA = a.score || 0;
    const scoreB = b.score || 0;
    if (scoreB !== scoreA) {
      return scoreB - scoreA;
    }
    // Tie-breaker: lowest total time taken
    const timeA = a.totalTimeTakenMs || 999999;
    const timeB = b.totalTimeTakenMs || 999999;
    return timeA - timeB;
  });
}

export function calculateBranchStats(playersObj) {
  if (!playersObj) return [];
  const map = {};
  Object.values(playersObj).forEach(p => {
    const b = p.branch || 'Other';
    if (!map[b]) map[b] = { totalScore: 0, count: 0, fastestCount: 0 };
    map[b].totalScore += (p.score || 0);
    map[b].count += 1;
    map[b].fastestCount += (p.fastestCount || 0);
  });
  return Object.keys(map).map(b => ({
    branch: b,
    avgScore: map[b].count > 0 ? (map[b].totalScore / map[b].count).toFixed(1) : '0.0',
    totalScore: map[b].totalScore,
    count: map[b].count,
    fastestCount: map[b].fastestCount
  })).sort((x, y) => parseFloat(y.avgScore) - parseFloat(x.avgScore));
}

export function renderLeaderboardHTML(playersObj) {
  const sorted = sortPlayers(playersObj);
  if (sorted.length === 0) {
    return `<div class="text-center py-8 text-slate-500 font-mono text-xs italic">No active combatants in arena yet.</div>`;
  }

  return sorted.map((p, idx) => {
    const rankClass = idx === 0 
      ? 'border-amber-400/60 bg-amber-950/20 text-amber-300' 
      : idx === 1 
      ? 'border-slate-300/50 bg-slate-800/20 text-slate-200' 
      : idx === 2 
      ? 'border-amber-700/50 bg-amber-950/10 text-amber-500' 
      : 'border-slate-800 bg-slate-950 text-slate-300';

    const rankBadge = idx === 0 ? '👑 #1' : idx === 1 ? '🥈 #2' : idx === 2 ? '🥉 #3' : `#${idx + 1}`;
    const avgTime = p.totalTimeTakenMs && p.answeredCount ? (p.totalTimeTakenMs / p.answeredCount / 1000).toFixed(2) + 's' : '--';

    return `
      <div class="p-3.5 rounded-2xl border ${rankClass} flex items-center justify-between transition-all">
        <div class="flex items-center gap-3 min-w-0">
          <span class="w-8 h-8 rounded-xl flex items-center justify-center font-mono font-bold text-xs shrink-0 ${idx === 0 ? 'bg-amber-400 text-slate-950' : idx === 1 ? 'bg-slate-300 text-slate-950' : idx === 2 ? 'bg-amber-700 text-white' : 'bg-slate-900 text-slate-400'}">
            ${rankBadge}
          </span>
          <div class="truncate">
            <span class="text-sm font-bold text-white block truncate">${escapeHtml(p.name)}</span>
            <span class="text-[10px] font-mono text-cyan-400">${escapeHtml(p.branch)}${p.fastestCount ? ` • ${p.fastestCount} fastest` : ''}</span>
          </div>
        </div>
        <div class="text-right font-mono shrink-0 pl-2">
          <span class="text-sm font-extrabold text-emerald-400 block">${p.score || 0} pts</span>
          <span class="text-[10px] text-slate-400">${avgTime} avg</span>
        </div>
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, 
    tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
  );
}

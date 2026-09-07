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

export function renderLeaderboardHTML(playersObj, limit = 5, showEmojiRank = true) {
  const sorted = sortPlayers(playersObj);
  if (sorted.length === 0) {
    return `<div class="text-center py-6 text-slate-500 font-mono text-xs italic">No active participants yet.</div>`;
  }

  const displayed = typeof limit === 'number' && limit > 0 ? sorted.slice(0, limit) : sorted;

  return displayed.map((p, idx) => {
    const rankNum = idx + 1;
    let rankBadge = `#${rankNum}`;
    let badgeStyle = 'bg-slate-900 text-slate-400 border border-slate-700/60';
    let cardClass = 'border-slate-800 bg-slate-950/70 text-slate-300';

    if (idx === 0) {
      rankBadge = '#1';
      badgeStyle = 'bg-[#FBBC05] text-slate-950 font-black shadow-[0_0_12px_rgba(251,188,5,0.4)]';
      cardClass = 'border-[#FBBC05]/50 bg-[#FBBC05]/10 text-white shadow-sm';
    } else if (idx === 1) {
      rankBadge = '#2';
      badgeStyle = 'bg-[#4285F4] text-white font-black shadow-[0_0_12px_rgba(66,133,244,0.4)]';
      cardClass = 'border-[#4285F4]/40 bg-[#4285F4]/10 text-white shadow-sm';
    } else if (idx === 2) {
      rankBadge = '#3';
      badgeStyle = 'bg-[#34A853] text-white font-black shadow-[0_0_12px_rgba(52,168,83,0.4)]';
      cardClass = 'border-[#34A853]/40 bg-[#34A853]/10 text-white shadow-sm';
    }

    const avgTime = p.totalTimeTakenMs && p.answeredCount ? (p.totalTimeTakenMs / p.answeredCount / 1000).toFixed(2) + 's' : '--';

    return `
      <div class="p-3.5 rounded-2xl border ${cardClass} flex items-center justify-between transition-all">
        <div class="flex items-center gap-3 min-w-0">
          <span class="min-w-[38px] h-8 px-2 rounded-xl flex items-center justify-center font-mono font-bold text-xs shrink-0 whitespace-nowrap ${badgeStyle}">
            ${rankBadge}
          </span>
          <div class="truncate">
            <span class="text-sm font-bold text-white block truncate">${escapeHtml(p.name)}</span>
            <span class="text-[10px] font-mono text-cyan-400">${escapeHtml(p.branch || 'CSE')}${p.fastestCount ? ` • ${p.fastestCount} fastest` : ''}</span>
          </div>
        </div>
        <div class="text-right font-mono shrink-0 pl-2">
          <span class="text-sm font-extrabold text-[#34A853] block">${p.score || 0} pts</span>
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

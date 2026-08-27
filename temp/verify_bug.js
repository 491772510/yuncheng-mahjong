'use strict';
// 验证碰牌后听口识别 bug：手牌11张 + 明牌区1组碰刻子
const rules = require('../src/rules');

function show(hand, melds, label) {
  const ting = rules.isTing(hand, melds);
  const canDeclare = rules.canDeclareTing136(hand, melds);
  console.log(`[${label}] hand=${hand.join(',')} melds=${JSON.stringify(melds)}`);
  console.log(`  isTing(hand) => ${ting.length ? ting.join(',') : '空(不听)'}`);
  console.log(`  canDeclareTing136 => ${canDeclare}`);
  // 逐个打出尝试
  for (const t of [...new Set(hand)]) {
    const rest = hand.slice();
    rest.splice(rest.indexOf(t), 1);
    const ting2 = rules.isTing(rest, melds);
    if (ting2.length) {
      const ok6 = ting2.some((x) => rules.tilePoints(x) >= 6);
      console.log(`  打出 ${t} -> 听 [${ting2.join(',')}] ${ok6 ? '(含>=6点 ✓)' : '(无>=6点 ✗)'}`);
    }
  }
}

// 场景1：碰了5万(w5)，手牌11张 = 3面子+1将（无散牌）
show(
  ['w2','w3','w4','w6','w7','w8','t2','t3','t4','e','e'],
  [{type:'peng', tile:'w5', tiles:['w5','w5','w5']}],
  '碰w5, 手牌 w234 w678 t234 ee'
);

// 场景2：碰了5万，手牌含2张5万作将（碰前4张）
show(
  ['w2','w3','w4','w6','w7','w8','t2','t3','t4','w5','w5'],
  [{type:'peng', tile:'w5', tiles:['w5','w5','w5']}],
  '碰w5, 手牌 w234 w678 t234 w5w5'
);

// 场景3：碰了东风(e)，手牌全数牌（听口含字牌/高点数）
show(
  ['w2','w3','w4','w6','w7','w8','t2','t3','t4','b1','b1'],
  [{type:'peng', tile:'e', tiles:['e','e','e']}],
  '碰东风, 手牌 w234 w678 t234 b1b1'
);

// services/v4/__tests__/AdCopyBans.test.js
// Phase 4 smoke test — anti-ad-copy bans + brand-name-in-dialogue bans only
// fire under naturalistic_placement / incidental_prop / genre_invisible.
// Under hero_showcase / commercial they are intentionally relaxed.

import assert from 'assert';
import { validateScreenplay } from '../ScreenplayValidator.js';

let pass = 0;
let fail = 0;

function it(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${name}\n      ${err.message}`);
    fail++;
  }
}

function describe(name, fn) {
  console.log(`\n${name}`);
  fn();
}

function beat(beat_id, dialogue, persona_index = 0) {
  return {
    beat_id,
    type: 'TALKING_HEAD_CLOSEUP',
    persona_index,
    dialogue,
    duration_seconds: 3,
    framing: 'tight_closeup',
    subtext: 'character is conflicted'
  };
}

function makeGraph(beats) {
  return {
    dramatic_question: 'Will she find what she needs?',
    scenes: [{
      scene_id: 's1',
      scene_goal: 'establish',
      hook_type: 'visual',
      beats
    }]
  };
}

const personas = [
  { persona_index: 0, archetype: 'detective', voice: { signature_line: 'You don\'t need it.' } }
];

describe('Anti-ad-copy bans', () => {
  it('rejects "introducing" under naturalistic_placement', () => {
    const sg = makeGraph([
      beat('b1', 'I\'m introducing this new feature to the team.'),
      beat('b2', 'You should see what it does.')
    ]);
    const result = validateScreenplay(sg, {}, personas, {
      productIntegrationStyle: 'naturalistic_placement',
      subject: { name: 'Lumen' }
    });
    const banHits = result.issues.filter(i => i.id?.startsWith('ad_copy_'));
    assert.ok(banHits.length >= 1, 'expected at least one ad-copy ban');
    assert.match(banHits[0].id, /introducing/);
  });

  it('rejects "buy yours today" under incidental_prop', () => {
    const sg = makeGraph([
      beat('b1', 'You can buy yours today.'),
    ]);
    const result = validateScreenplay(sg, {}, personas, {
      productIntegrationStyle: 'incidental_prop'
    });
    assert.ok(result.issues.some(i => i.id === 'ad_copy_buy_today'), 'expected buy_today ban');
  });

  it('does NOT reject same line under hero_showcase', () => {
    const sg = makeGraph([
      beat('b1', 'You can buy yours today, with our patented design.'),
    ]);
    const result = validateScreenplay(sg, {}, personas, {
      productIntegrationStyle: 'hero_showcase'
    });
    const banHits = result.issues.filter(i => i.id?.startsWith('ad_copy_'));
    assert.strictEqual(banHits.length, 0, `expected no ad-copy bans under hero_showcase, got: ${banHits.map(b=>b.id).join(', ')}`);
  });

  it('does NOT reject same line under commercial', () => {
    const sg = makeGraph([
      beat('b1', 'You can buy yours today.'),
    ]);
    const result = validateScreenplay(sg, {}, personas, {
      productIntegrationStyle: 'commercial'
    });
    const banHits = result.issues.filter(i => i.id?.startsWith('ad_copy_'));
    assert.strictEqual(banHits.length, 0);
  });

  it('catches multiple bans across multiple beats', () => {
    const sg = makeGraph([
      beat('b1', 'Introducing the new MacBook.'),
      beat('b2', 'Now available in stores.'),
      beat('b3', 'It\'s a game-changer.')
    ]);
    const result = validateScreenplay(sg, {}, personas, {
      productIntegrationStyle: 'naturalistic_placement'
    });
    const banHits = result.issues.filter(i => i.id?.startsWith('ad_copy_'));
    assert.ok(banHits.length >= 3, `expected ≥3 bans, got ${banHits.length}`);
  });
});

describe('Brand-name-in-dialogue bans', () => {
  it('allows ONE brand mention diegetically (label-read exception)', () => {
    const sg = makeGraph([
      beat('b1', 'I picked up a Lumen at the store.'),
      beat('b2', 'Just the one.')
    ]);
    const result = validateScreenplay(sg, {}, personas, {
      productIntegrationStyle: 'naturalistic_placement',
      subject: { name: 'Lumen' }
    });
    const brandHits = result.issues.filter(i => i.id === 'brand_name_in_dialogue');
    assert.strictEqual(brandHits.length, 0, 'first brand mention should be exempt');
  });

  it('flags second + brand mention in dialogue', () => {
    const sg = makeGraph([
      beat('b1', 'I picked up a Lumen at the store.'),
      beat('b2', 'Lumen really did change everything.'),
      beat('b3', 'Lumen is the best.')
    ]);
    const result = validateScreenplay(sg, {}, personas, {
      productIntegrationStyle: 'naturalistic_placement',
      subject: { name: 'Lumen' }
    });
    const brandHits = result.issues.filter(i => i.id === 'brand_name_in_dialogue');
    assert.ok(brandHits.length >= 1, 'second brand mention should be flagged');
  });

  it('does NOT flag brand mentions under hero_showcase', () => {
    const sg = makeGraph([
      beat('b1', 'Lumen makes everything better.'),
      beat('b2', 'I love my Lumen.'),
      beat('b3', 'Lumen Lumen Lumen.')
    ]);
    const result = validateScreenplay(sg, {}, personas, {
      productIntegrationStyle: 'hero_showcase',
      subject: { name: 'Lumen' }
    });
    const brandHits = result.issues.filter(i => i.id === 'brand_name_in_dialogue');
    assert.strictEqual(brandHits.length, 0);
  });
});

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

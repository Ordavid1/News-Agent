// scripts/recover-episode-27d6276b.mjs
//
// One-off recovery for episode 27d6276b-8805-4a2c-a471-a19ce9d768c9.
//
// State at recovery time (queried 2026-05-06):
//   - Status: 'ready' (with a partial final_video_url containing only the 3
//     beats from scene 1)
//   - Scene 1 (sc1_plaza): 3/3 beats rendered (s1b1, s1b2, s1b3 — s1b3 was
//     regenerated via Edit & Retry, then the old `regenerateBeatInEpisode`
//     path silently skipped scenes 2 + 3 and shipped a partial cut)
//   - Scene 2 (sc2_pavilion): 5/5 beats PENDING — never rendered
//   - Scene 3 (sc3_bench):    4/4 beats PENDING — never rendered
//   - sc2_pavilion has _user_approved_lens_b flag from the earlier Approve & Continue
//
// Invokes runV4Pipeline in resume mode WITHOUT beatEdits — the resume picks
// up the persisted scene_description (with all 3 scene_master_urls intact),
// skips the 3 generated beats via the existing resume-check at
// BrandStoryService.js:5265, renders the 9 missing beats, then runs
// post-production + Lens D + assembly + uploads a fresh full final video.

import 'dotenv/config';

const STORY_ID = '4f24ebfa-2bb4-4747-b0cc-cf63144106a0';
const USER_ID = 'ac469b71-a9a7-4ce4-9781-2375a9ae9839';
const EPISODE_ID = '27d6276b-8805-4a2c-a471-a19ce9d768c9';

async function main() {
  console.log(`[recover] loading BrandStoryService…`);
  const { default: svc } = await import('../services/BrandStoryService.js');

  console.log(`[recover] invoking runV4Pipeline resume on episode ${EPISODE_ID}…`);
  console.log(`[recover] expected behavior:`);
  console.log(`  - skip screenplay generation (use persisted scene_description)`);
  console.log(`  - skip Lens A (already passed)`);
  console.log(`  - reuse episode row (no INSERT)`);
  console.log(`  - skip generateSceneMasters for all 3 scenes (URLs already set)`);
  console.log(`  - skip Lens B for sc2_pavilion (user-approved); re-judge sc1_plaza + sc3_bench`);
  console.log(`  - reuse 3 generated beats in sc1_plaza`);
  console.log(`  - render 5 beats in sc2_pavilion + 4 beats in sc3_bench (9 total)`);
  console.log(`  - run music bed + post-production on the full set`);
  console.log(`  - upload fresh final video, mark ready`);

  const onProgress = (stage, detail) => {
    console.log(`[recover.progress] ${stage}: ${detail}`);
  };

  try {
    const result = await svc.runV4Pipeline(STORY_ID, USER_ID, onProgress, {
      episodeId: EPISODE_ID
      // No beatEdits — we're not editing anything, just continuing forward.
      // No sceneEdits, no userApprovedScenes — those are persisted on the
      // existing scene_description / director_report.
    });
    console.log(`[recover] DONE — result:`, JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(`[recover] FAILED:`, err);
    if (err.constructor?.name === 'DirectorBlockingHaltError') {
      console.error(`[recover] Pipeline halted again at ${err.checkpoint || '?'} on artifact ${err.artifactKey || '?'}`);
      console.error(`[recover] Open the Director Panel for episode ${EPISODE_ID} to resolve.`);
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[recover] fatal:', err);
  process.exit(1);
});

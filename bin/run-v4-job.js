#!/usr/bin/env node
// bin/run-v4-job.js
//
// Entrypoint for the `v4-pipeline` Cloud Run Job.
//
// Cloud Run Jobs run as a separate execution from the saas-main service —
// max task timeout is 24h (vs 60min for service requests), they have their
// own memory/cpu sizing, and they don't compete with user-facing HTTP
// requests for resources.
//
// Invocation: the saas-main HTTP handler that previously called
// `brandStoryService.runEpisodePipeline()` inline now POSTs to the
// Cloud Run Jobs Admin API, passing STORY_ID + USER_ID as env-var
// overrides on the execution. This script reads those vars and runs
// the same pipeline function.
//
// Required env (override-able per execution):
//   STORY_ID       — UUID of the brand_story to advance one episode
//   USER_ID        — UUID of the owning user
//   BRAND_STORY_PIPELINE — typically 'v4', forwarded so the pipeline
//                         routing in runEpisodePipeline picks v4
//
// Optional:
//   RESUME_EPISODE_ID — if set, the pipeline resumes that specific
//                       episode instead of generating a new one (used
//                       by manual recovery).

import brandStoryService from '../services/BrandStoryService.js';
import winston from 'winston';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [new winston.transports.Console()]
});

async function main() {
  const storyId = process.env.STORY_ID;
  const userId = process.env.USER_ID;
  const resumeEpisodeId = process.env.RESUME_EPISODE_ID || null;

  if (!storyId || !userId) {
    logger.error('FATAL: STORY_ID and USER_ID env vars are required');
    process.exit(2);
  }

  logger.info(`[v4-job] starting storyId=${storyId} userId=${userId} resumeEpisodeId=${resumeEpisodeId || 'null'}`);
  const startedAt = Date.now();

  try {
    if (resumeEpisodeId) {
      // Resume an existing episode — the V4 pipeline supports this via
      // its built-in skip-checks (scenes/beats with existing URLs are
      // not re-rendered). The runV4Pipeline path knows how to resume
      // when it finds an existing episode for the same story.
      const result = await brandStoryService.runV4Pipeline(storyId, userId, (stage, detail) => {
        logger.info(`[v4-job] ${stage}: ${detail}`);
      }, { resumeEpisodeId });
      const durationSec = Math.round((Date.now() - startedAt) / 1000);
      logger.info(`[v4-job] RESUME complete in ${durationSec}s episode=${result?.id || 'unknown'}`);
    } else {
      const result = await brandStoryService.runEpisodePipeline(storyId, userId, (stage, detail) => {
        logger.info(`[v4-job] ${stage}: ${detail}`);
      });
      const durationSec = Math.round((Date.now() - startedAt) / 1000);
      logger.info(`[v4-job] complete in ${durationSec}s episode=${result?.id || 'unknown'}`);
    }
    process.exit(0);
  } catch (err) {
    const durationSec = Math.round((Date.now() - startedAt) / 1000);
    logger.error(`[v4-job] FAILED after ${durationSec}s: ${err.message}`);
    logger.error(err.stack || '');
    process.exit(1);
  }
}

main();

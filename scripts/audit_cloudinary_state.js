'use strict';
const config = require('../src/config');
const db = require('../src/db');
const cloudinary = require('../src/cloudinary');

async function main() {
  console.log(JSON.stringify({
    currentCloudinaryCloud: config.cloudinaryCloudName || '(missing)',
    cloudinaryConfigFromEnv: {
      cloudNameConfigured: Boolean(config.cloudinaryCloudName),
      apiKeyConfigured: Boolean(config.cloudinaryApiKey),
      apiSecretConfigured: Boolean(config.cloudinaryApiSecret),
    },
  }, null, 2));

  const rows = await db.query(`
    SELECT s.episode_id, s.scene_number, s.shot_index, s.status, s.clip_url
    FROM shots s
    WHERE s.clip_url IS NOT NULL AND TRIM(s.clip_url) <> ''
    ORDER BY s.episode_id, s.scene_number, s.shot_index
  `);

  const result = rows.map(row => {
    let cloud = null;
    let publicId = null;
    try {
      const u = new URL(row.clip_url);
      const parts = u.pathname.split('/').filter(Boolean);
      cloud = parts[0] || null;
      publicId = cloudinary.isCurrentCloudinaryVideoUrl(row.clip_url)
        ? 'current-cloud-url'
        : 'foreign-or-non-cloudinary';
    } catch (_) {}
    return {
      episode_id: row.episode_id, scene_number: row.scene_number, shot_index: row.shot_index,
      status: row.status, cloud, classification: publicId, clip_url: row.clip_url,
    };
  });

  console.log(JSON.stringify({ count: result.length, rows: result }, null, 2));
}

main().catch(err => {
  console.error(`[CloudinaryAudit] ${err.stack || err.message}`);
  process.exitCode = 1;
});

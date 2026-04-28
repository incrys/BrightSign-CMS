'use strict';
const fs   = require('fs');
const path = require('path');
const AUTORUN_TEMPLATE_PATH = path.join(__dirname, 'autorun.template.brs');

function generatePlaylistJson(playlist) {
  return JSON.stringify({
    name:                   playlist.name || 'Playlist CMS',
    generated_at:           new Date().toISOString(),
    default_image_duration: playlist.default_image_duration || 10,
    items: playlist.items.map(item => {
      const e = { file: item.file, label: item.label || item.file };
      if (item.duration !== undefined) e.duration = item.duration;
      return e;
    })
  }, null, 2);
}

function generateAutorun(playerInfo) {
  let brs = fs.readFileSync(AUTORUN_TEMPLATE_PATH, 'utf8');
  brs = brs.replace('{PLAYER_NAME}',    playerInfo.name || playerInfo.ip);
  brs = brs.replace('{GENERATED_DATE}', new Date().toISOString());
  return brs;
}

module.exports = { generatePlaylistJson, generateAutorun };
